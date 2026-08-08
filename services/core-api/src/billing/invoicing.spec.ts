/**
 * Invoicing, payment and voiding through the service.
 *
 * The recurring assertion is that the server decides the money. A client that can
 * name a total can name a smaller one.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { BillingService } from './billing.module';
import { InvoicesService } from './invoices.controller';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const INVOICE_ID = '0193c3f0-0000-7000-8000-0000000000i1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['billing-officer'],
  permissions: ['invoice:write', 'payment:write'],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const invoice = (over: Record<string, unknown> = {}) => ({
  id: INVOICE_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  encounter_id: null,
  coverage_id: null,
  invoice_number: 'INV-2026-000001',
  status: 'issued',
  payer_type: 'cash',
  currency: 'AED',
  country_pack: 'uae',
  subtotal_minor: 100_000,
  discount_minor: 0,
  tax_minor: 5_000,
  total_minor: 105_000,
  paid_minor: 0,
  balance_minor: 105_000,
  payer_share_minor: 0,
  patient_share_minor: 105_000,
  issued_at: new Date('2026-08-01T09:00:00Z'),
  fhir_id: null,
  ...over,
});

describe('invoicing', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let billing: BillingService;
  let invoices: InvoicesService;
  let tx: Record<string, Record<string, jest.Mock>>;

  beforeEach(() => {
    tx = {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice()),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(invoice(args.data)),
        ),
      },
      payment: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'pay1', ...args.data }),
        ),
      },
    };

    prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ country_pack: 'uae', currency: 'AED' }),
      },
      coverage: { findFirst: jest.fn().mockResolvedValue(null) },
      chargeMaster: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...invoice(args.data), line_items: [] }),
        ),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(invoice(args.data)),
        ),
      },
      payment: {
        // BillingService mints the next receipt number before opening the transaction.
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      },
      claimResponse: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    billing = new BillingService(prisma, kafka);
    invoices = new InvoicesService(prisma, billing);
  });

  const created = () => (prisma.invoice.create as jest.Mock).mock.calls[0][0].data;

  describe('totals are computed server-side', () => {
    it('ignores any total the client sends and derives it from the lines', async () => {
      await run(() =>
        invoices.create({
          patient_id: PATIENT_ID,
          payer_type: 'cash',
          due_days: 30,
          regulatory_fields: {},
          // A client trying to name its own figures — every one of these is ignored.
          total_minor: 1,
          subtotal_minor: 1,
          tax_minor: 0,
          lines: [
            { charge_code: 'CONS-01', description: 'Consultation', quantity: 2, unit_price_minor: 20_000, discount_minor: 0, tax_rate_bp: 500 },
          ],
        } as never),
      );

      const data = created();
      // 2 × 20 000 = 40 000 net, 5% tax = 2 000, total 42 000.
      expect(data.subtotal_minor).toBe(40_000);
      expect(data.tax_minor).toBe(2_000);
      expect(data.total_minor).toBe(42_000);
      expect(data.balance_minor).toBe(42_000);
    });

    it('keeps every amount an integer number of minor units', async () => {
      await run(() =>
        invoices.create({
          patient_id: PATIENT_ID,
          payer_type: 'cash',
          due_days: 30,
          regulatory_fields: {},
          lines: [
            { charge_code: 'LAB-01', description: 'Panel', quantity: 3, unit_price_minor: 3_333, discount_minor: 0, tax_rate_bp: 500 },
          ],
        } as never),
      );

      const data = created();
      for (const key of ['subtotal_minor', 'tax_minor', 'total_minor', 'balance_minor']) {
        expect(Number.isInteger(data[key])).toBe(true);
      }
      // 9 999 net, 5% = 499.95, rounded half-up to 500.
      expect(data.tax_minor).toBe(500);
    });

    it('applies a discount before tax', async () => {
      await run(() =>
        invoices.create({
          patient_id: PATIENT_ID,
          payer_type: 'cash',
          due_days: 30,
          regulatory_fields: {},
          lines: [
            { charge_code: 'X', description: 'X', quantity: 1, unit_price_minor: 10_000, discount_minor: 2_000, tax_rate_bp: 500 },
          ],
        } as never),
      );
      const data = created();
      expect(data.subtotal_minor).toBe(8_000);
      expect(data.tax_minor).toBe(400);
    });

    it('stamps the payer type after pricing', async () => {
      await run(() =>
        invoices.create({
          patient_id: PATIENT_ID,
          payer_type: 'insurance',
          due_days: 30,
          regulatory_fields: {},
          lines: [{ charge_code: 'X', description: 'X', quantity: 1, unit_price_minor: 1_000, discount_minor: 0 }],
        } as never),
      );
      expect((prisma.invoice.update as jest.Mock).mock.calls[0][0].data.payer_type).toBe('insurance');
    });
  });

  describe('payments', () => {
    it('moves an unpaid invoice to partially paid', async () => {
      const result = await run(() =>
        invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 40_000, method: 'cash' }),
      );

      expect(tx.invoice.update.mock.calls[0][0].data.status).toBe('partially_paid');
      expect(tx.invoice.update.mock.calls[0][0].data.paid_minor).toBe(40_000);
      expect(result.balance_minor).toBe(65_000);
    });

    it('closes the invoice once the balance reaches zero', async () => {
      const result = await run(() =>
        invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 105_000, method: 'card' }),
      );
      expect(tx.invoice.update.mock.calls[0][0].data.status).toBe('paid');
      expect(result.balance_minor).toBe(0);
    });

    it('closes it on the final instalment, not before', async () => {
      tx.invoice.findFirst.mockResolvedValue(
        invoice({ status: 'partially_paid', paid_minor: 100_000, balance_minor: 5_000 }),
      );
      await run(() => invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 5_000, method: 'cash' }));
      expect(tx.invoice.update.mock.calls[0][0].data.status).toBe('paid');
    });

    it('refuses to take more than is outstanding', async () => {
      await expect(
        run(() => invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 200_000, method: 'cash' })),
      ).rejects.toThrow(/exceeds the outstanding balance/);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('maps an online payment onto the card method the ledger uses', async () => {
      await run(() => invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 1_000, method: 'online' }));
      expect(tx.payment.create.mock.calls[0][0].data.method).toBe('card');
    });

    it('refuses a payment in a different currency to the invoice', async () => {
      await expect(
        run(() =>
          invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 1_000, method: 'cash', currency: 'USD' }),
        ),
      ).rejects.toThrow(/cannot be applied/);
    });

    it('refuses a payment against a voided invoice', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice({ status: 'cancelled' }));

      let thrown: unknown;
      await run(() =>
        invoices.pay({ invoice_id: INVOICE_ID, amount_minor: 1_000, method: 'cash' }),
      ).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(((thrown as ConflictException).getResponse() as Record<string, unknown>).code).toBe(
        'INVOICE_VOIDED',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('void', () => {
    it('cancels an unpaid invoice and records why', async () => {
      const result = await run(() => invoices.void(INVOICE_ID, { reason: 'Raised against the wrong patient' }));
      expect(result.status).toBe('cancelled');
      const data = (prisma.invoice.update as jest.Mock).mock.calls[0][0].data;
      expect(data.deleted_reason).toBe('Raised against the wrong patient');
      expect(data.balance_minor).toBe(0);
    });

    it('refuses to void an invoice that has taken money', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(
        invoice({ paid_minor: 20_000, balance_minor: 85_000, status: 'partially_paid' }),
      );

      let thrown: unknown;
      await run(() => invoices.void(INVOICE_ID, { reason: 'Changed my mind' })).catch(
        (e: unknown) => {
          thrown = e;
        },
      );

      expect(thrown).toBeInstanceOf(ConflictException);
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('INVOICE_HAS_PAYMENTS');
      expect(body.paid_minor).toBe(20_000);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });

    it('refuses to void twice', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue(invoice({ status: 'cancelled' }));
      await expect(run(() => invoices.void(INVOICE_ID, { reason: 'Again' }))).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('dashboard', () => {
    it('ages open receivables and reports the month to date', async () => {
      const now = new Date('2026-08-02T12:00:00Z');
      (prisma.invoice.findMany as jest.Mock)
        .mockResolvedValueOnce([
          invoice({ balance_minor: 10_000, issued_at: new Date('2026-07-30T00:00:00Z') }),
          invoice({ id: 'old', balance_minor: 40_000, issued_at: new Date('2026-01-01T00:00:00Z') }),
        ])
        .mockResolvedValueOnce([
          invoice({ total_minor: 105_000, paid_minor: 50_000, payer_type: 'insurance' }),
        ]);
      (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
        _sum: { amount_minor: 60_000, refunded_minor: 10_000 },
      });
      (prisma.claimResponse.findMany as jest.Mock).mockResolvedValue([
        { outcome: 'approved', denied_minor: 0, approved_minor: 1_000, denial_codes: [] },
        { outcome: 'denied', denied_minor: 5_000, approved_minor: 0, denial_codes: ['NO_AUTH'] },
      ]);

      const result = await run(() => invoices.dashboard(now));

      expect(result.aging.total_outstanding_minor).toBe(50_000);
      expect(result.aging.over_90_minor).toBe(40_000);
      // Refunds come back out of the collected figure.
      expect(result.collection.collected_minor).toBe(50_000);
      expect(result.collection.billed_minor).toBe(105_000);
      expect(result.denials.rate_bp).toBe(5_000);
      expect(result.top_denial_reasons[0]!.code).toBe('NO_AUTH');
      expect(result.revenue_by_payer[0]!.payer_type).toBe('insurance');
    });
  });
});
