import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { BillingService } from './billing.module';
import {
  ageReceivables,
  collectionRate,
  denialRate,
  revenueByPayer,
  startOfMonth,
  topDenialReasons,
  OPEN_INVOICE_STATUSES,
} from './ar-aging';

const CURRENCIES = ['AED', 'SAR', 'INR', 'USD', 'EUR', 'GBP'] as const;

/**
 * `line_items` is the name the billing screen sends; `lines` is what the existing
 * endpoint uses. Both are accepted, and neither carries a total — the server
 * computes every figure from unit price, quantity and the country-pack tax rate.
 */
export const CreateInvoiceRequestDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    const lines = (v.lines ?? v.line_items) as unknown;
    return {
      ...v,
      lines: Array.isArray(lines)
        ? lines.map((raw) => {
            const line = raw as Record<string, unknown>;
            return { ...line, charge_code: line.charge_code ?? line.service_code };
          })
        : lines,
    };
  },
  z.object({
    patient_id: z.string().uuid(),
    encounter_id: z.string().uuid().nullable().optional(),
    coverage_id: z.string().uuid().nullable().optional(),
    payer_type: z.enum(['cash', 'insurance', 'corporate']).default('cash'),
    currency: z.enum(CURRENCIES).optional(),
    due_days: z.number().int().min(0).max(365).default(30),
    lines: z
      .array(
        z.object({
          charge_code: z.string().min(1),
          description: z.string().min(1),
          quantity: z.number().int().positive().default(1),
          unit_price_minor: z.number().int().min(0).optional(),
          discount_minor: z.number().int().min(0).default(0),
          tax_rate_bp: z.number().int().min(0).max(10_000).optional(),
          service_date: z.coerce.date().optional(),
          source_type: z.string().optional(),
          source_id: z.string().uuid().optional(),
        }),
      )
      .min(1),
    regulatory_fields: z.record(z.string()).default({}),
  }),
);

export const VoidInvoiceDto = z.object({
  reason: z.string().min(5).max(500),
});

export const RecordPaymentRequestDto = z.object({
  invoice_id: z.string().uuid(),
  amount_minor: z.number().int().positive(),
  currency: z.enum(CURRENCIES).optional(),
  method: z.enum([
    'cash',
    'card',
    'online',
    'insurance',
    'bank_transfer',
    'wallet',
    'apple_pay',
    'google_pay',
    'cheque',
  ]),
  gateway_reference: z.string().optional(),
  notes: z.string().max(500).optional(),
});

/** `online` is what the client calls a gateway payment; the ledger calls it a card. */
const METHOD_ALIASES: Record<string, string> = { online: 'card' };

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async create(dto: z.infer<typeof CreateInvoiceRequestDto>) {
    const invoice = await this.billing.createInvoice(dto);
    // Payer type is not part of the pricing calculation, so it is stamped after.
    return this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { payer_type: dto.payer_type },
      include: { line_items: true },
    });
  }

  async list(params: { patientId?: string; status?: string; payerType?: string; page: number; limit: number }) {
    const where = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      ...(params.patientId ? { patient_id: params.patientId } : {}),
      ...(params.status === 'open'
        ? { status: { in: [...OPEN_INVOICE_STATUSES] as never } }
        : params.status
          ? { status: params.status as never }
          : {}),
      ...(params.payerType ? { payer_type: params.payerType as never } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          line_items: true,
          patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
        },
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { data, total, page: params.page, limit: params.limit, pages: Math.ceil(total / params.limit) };
  }

  async get(id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: {
        line_items: true,
        payments: { where: { deleted_at: null }, orderBy: { received_at: 'desc' } },
        claims: true,
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
      },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');
    return invoice;
  }

  /**
   * Voids an invoice.
   *
   * Refused once money has been taken: a paid invoice is reversed with a credit
   * note, not erased, because the receipt is already in the patient's hands.
   */
  async void(id: string, dto: z.infer<typeof VoidInvoiceDto>) {
    const ctx = currentContext();
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');
    if (invoice.status === 'cancelled') {
      throw new BadRequestException('This invoice has already been voided');
    }
    if (invoice.paid_minor > 0) {
      throw new ConflictException({
        code: 'INVOICE_HAS_PAYMENTS',
        message: `${invoice.paid_minor} has already been paid against this invoice; raise a refund or a credit note instead`,
        paid_minor: invoice.paid_minor,
      });
    }

    return this.prisma.invoice.update({
      where: { id },
      data: { status: 'cancelled', deleted_reason: dto.reason, balance_minor: 0 },
    });
  }

  /**
   * Records a payment.
   *
   * Delegates the ledger write to BillingService, which re-reads the balance
   * inside a transaction so two concurrent receipts cannot together overpay.
   */
  async pay(dto: z.infer<typeof RecordPaymentRequestDto>) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: dto.invoice_id, tenant_id: currentContext().tenantId, deleted_at: null },
      select: { currency: true, status: true },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');
    if (invoice.status === 'cancelled') {
      throw new ConflictException({
        code: 'INVOICE_VOIDED',
        message: 'This invoice has been voided and cannot take a payment',
      });
    }
    if (dto.currency && dto.currency !== invoice.currency) {
      throw new BadRequestException(
        `The invoice is in ${invoice.currency}; a payment in ${dto.currency} cannot be applied to it`,
      );
    }

    return this.billing.recordPayment({
      invoice_id: dto.invoice_id,
      method: (METHOD_ALIASES[dto.method] ?? dto.method) as never,
      amount_minor: dto.amount_minor,
      gateway_reference: dto.gateway_reference,
      notes: dto.notes,
    });
  }

  /**
   * The revenue-cycle dashboard.
   *
   * Aging is computed over open invoices in code rather than in SQL: the buckets
   * are date arithmetic on a status set, and expressing that as four correlated
   * subqueries makes it harder to check than it is worth.
   */
  async dashboard(now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    const monthStart = startOfMonth(now);

    const [invoices, monthInvoices, monthPayments, monthResponses] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenant_id: tenantId, deleted_at: null, status: { in: [...OPEN_INVOICE_STATUSES] as never } },
        select: {
          id: true,
          status: true,
          balance_minor: true,
          total_minor: true,
          paid_minor: true,
          issued_at: true,
          created_at: true,
          payer_type: true,
        },
        take: 10_000,
      }),
      this.prisma.invoice.findMany({
        where: { tenant_id: tenantId, deleted_at: null, created_at: { gte: monthStart } },
        select: {
          id: true,
          status: true,
          balance_minor: true,
          total_minor: true,
          paid_minor: true,
          issued_at: true,
          created_at: true,
          payer_type: true,
        },
        take: 10_000,
      }),
      this.prisma.payment.aggregate({
        where: { tenant_id: tenantId, deleted_at: null, status: 'succeeded', received_at: { gte: monthStart } },
        _sum: { amount_minor: true, refunded_minor: true },
      }),
      this.prisma.claimResponse.findMany({
        where: { tenant_id: tenantId, deleted_at: null, received_at: { gte: monthStart } },
        select: { outcome: true, denied_minor: true, approved_minor: true, denial_codes: true },
        take: 10_000,
      }),
    ]);

    const billed = monthInvoices
      .filter((i) => i.status !== 'cancelled')
      .reduce((sum, i) => sum + i.total_minor, 0);
    // Refunds are money that came back out; the net is what was actually collected.
    const collected =
      (monthPayments._sum.amount_minor ?? 0) - (monthPayments._sum.refunded_minor ?? 0);

    return {
      period_start: monthStart.toISOString(),
      aging: ageReceivables(invoices, now),
      collection: collectionRate(billed, collected),
      denials: denialRate(monthResponses),
      top_denial_reasons: topDenialReasons(monthResponses),
      revenue_by_payer: revenueByPayer(monthInvoices),
    };
  }
}

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly service: InvoicesService) {}

  @Post()
  @RequirePermissions('invoice:write')
  @Audit({ action: 'invoice.create', resourceType: 'Invoice', isPhi: true })
  @ApiOperation({ summary: 'Raise an invoice; every total is computed server-side' })
  create(@ZodBody(CreateInvoiceRequestDto) dto: z.infer<typeof CreateInvoiceRequestDto>) {
    return this.service.create(dto);
  }

  @Get()
  @RequirePermissions('invoice:read')
  list(@Query() q: Record<string, string>) {
    return this.service.list({
      patientId: q.patientId ?? q.patient_id,
      status: q.status,
      payerType: q.payerType ?? q.payer_type,
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 25),
    });
  }

  @Get(':id')
  @RequirePermissions('invoice:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch(':id/void')
  @RequirePermissions('invoice:write')
  @Audit({ action: 'invoice.void', resourceType: 'Invoice', isPhi: true })
  @ApiOperation({ summary: 'Void an unpaid invoice; a paid one needs a credit note' })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(VoidInvoiceDto) dto: z.infer<typeof VoidInvoiceDto>,
  ) {
    return this.service.void(id, dto);
  }
}

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: InvoicesService) {}

  @Post()
  @RequirePermissions('payment:write')
  @Audit({ action: 'payment.record', resourceType: 'Payment', isPhi: true })
  @ApiOperation({ summary: 'Record a payment; partial payments move the invoice to partially paid' })
  pay(@ZodBody(RecordPaymentRequestDto) dto: z.infer<typeof RecordPaymentRequestDto>) {
    return this.service.pay(dto);
  }
}
