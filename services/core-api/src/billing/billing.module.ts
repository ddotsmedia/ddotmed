import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { getCountryPack } from '@medicore/country-packs';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { invoiceToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { calculateLine, splitCoverage, sumInvoice } from './money';

export const CreateInvoiceDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  coverage_id: z.string().uuid().nullable().optional(),
  currency: z.string().length(3).optional(),
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
});

export const RecordPaymentDto = z.object({
  invoice_id: z.string().uuid(),
  method: z.enum(['cash', 'card', 'bank_transfer', 'insurance', 'wallet', 'apple_pay', 'google_pay', 'cheque']),
  amount_minor: z.number().int().positive(),
  gateway_reference: z.string().optional(),
  notes: z.string().max(500).optional(),
});

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  private async tenant() {
    const t = await this.prisma.tenant.findUnique({
      where: { id: currentContext().tenantId },
      select: { country_pack: true, currency: true },
    });
    if (!t) throw new BadRequestException('Tenant not found');
    return t;
  }

  private async nextNumber(prefix: 'INV' | 'RCP' | 'CLM' | 'PA'): Promise<string> {
    const tenantId = currentContext().tenantId;
    const year = new Date().getFullYear();
    const stem = `${prefix}-${year}-`;

    if (prefix === 'INV') {
      const last = await this.prisma.invoice.findFirst({
        where: { tenant_id: tenantId, invoice_number: { startsWith: stem } },
        orderBy: { invoice_number: 'desc' },
        select: { invoice_number: true },
      });
      const n = last ? Number(last.invoice_number.slice(stem.length)) + 1 : 1;
      return `${stem}${String(n).padStart(6, '0')}`;
    }
    if (prefix === 'RCP') {
      const last = await this.prisma.payment.findFirst({
        where: { tenant_id: tenantId, receipt_number: { startsWith: stem } },
        orderBy: { receipt_number: 'desc' },
        select: { receipt_number: true },
      });
      const n = last ? Number(last.receipt_number.slice(stem.length)) + 1 : 1;
      return `${stem}${String(n).padStart(6, '0')}`;
    }
    if (prefix === 'CLM') {
      const last = await this.prisma.insuranceClaim.findFirst({
        where: { tenant_id: tenantId, claim_number: { startsWith: stem } },
        orderBy: { claim_number: 'desc' },
        select: { claim_number: true },
      });
      const n = last ? Number(last.claim_number.slice(stem.length)) + 1 : 1;
      return `${stem}${String(n).padStart(6, '0')}`;
    }
    const last = await this.prisma.preAuthorization.findFirst({
      where: { tenant_id: tenantId, reference_number: { startsWith: stem } },
      orderBy: { reference_number: 'desc' },
      select: { reference_number: true },
    });
    const n = last ? Number(last.reference_number.slice(stem.length)) + 1 : 1;
    return `${stem}${String(n).padStart(6, '0')}`;
  }

  /** Builds an invoice from the charge master, splitting each line across payer and patient. */
  async createInvoice(dto: z.infer<typeof CreateInvoiceDto>) {
    const ctx = currentContext();
    const tenant = await this.tenant();
    const pack = getCountryPack(tenant.country_pack);
    const currency = dto.currency ?? tenant.currency ?? pack.currency;

    const coverage = dto.coverage_id
      ? await this.prisma.coverage.findFirst({
          where: { id: dto.coverage_id, tenant_id: ctx.tenantId, deleted_at: null, status: 'active' },
        })
      : null;

    const codes = dto.lines.map((l) => l.charge_code);
    const chargeMaster = await this.prisma.chargeMaster.findMany({
      where: { tenant_id: ctx.tenantId, charge_code: { in: codes }, deleted_at: null, is_active: true },
    });
    const byCode = new Map(chargeMaster.map((c) => [c.charge_code, c]));

    const prepared = dto.lines.map((line) => {
      const master = byCode.get(line.charge_code);
      const unitPrice = line.unit_price_minor ?? master?.unit_price_minor;
      if (unitPrice === undefined) {
        throw new BadRequestException(
          `No price for charge code ${line.charge_code}; supply unit_price_minor or add it to the charge master`,
        );
      }
      const taxBp = line.tax_rate_bp ?? master?.tax_rate_bp ?? pack.taxRateBp;
      const totals = calculateLine({
        quantity: line.quantity,
        unit_price_minor: unitPrice,
        discount_minor: line.discount_minor,
        tax_rate_bp: taxBp,
      });
      return { line, master, unitPrice, taxBp, totals };
    });

    const invoiceTotals = sumInvoice(prepared.map((p) => p.totals));

    // Split at line level so a partially-covered invoice reports the correct shares.
    let deductibleLeft = coverage?.deductible_minor ?? 0;
    let limitLeft =
      coverage?.annual_limit_minor != null
        ? Math.max(0, coverage.annual_limit_minor - coverage.used_minor)
        : null;

    const withSplit = prepared.map((p) => {
      if (!coverage) {
        return { ...p, payer: 0, patient: p.totals.total_minor };
      }
      const split = splitCoverage({
        total_minor: p.totals.total_minor,
        copay_bp: coverage.copay_bp,
        deductible_remaining_minor: deductibleLeft,
        annual_limit_remaining_minor: limitLeft,
      });
      deductibleLeft -= split.deductible_applied_minor;
      if (limitLeft !== null) limitLeft -= split.payer_share_minor;
      return { ...p, payer: split.payer_share_minor, patient: split.patient_share_minor };
    });

    const payerShare = withSplit.reduce((a, p) => a + p.payer, 0);
    const patientShare = withSplit.reduce((a, p) => a + p.patient, 0);
    const invoiceNumber = await this.nextNumber('INV');

    const invoice = await this.prisma.invoice.create({
      data: {
        tenant_id: ctx.tenantId,
        invoice_number: invoiceNumber,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        coverage_id: coverage?.id ?? null,
        status: 'issued',
        currency,
        country_pack: pack.code,
        subtotal_minor: invoiceTotals.subtotal_minor,
        discount_minor: invoiceTotals.discount_minor,
        tax_minor: invoiceTotals.tax_minor,
        total_minor: invoiceTotals.total_minor,
        balance_minor: invoiceTotals.total_minor,
        payer_share_minor: payerShare,
        patient_share_minor: patientShare,
        issued_at: new Date(),
        due_at: new Date(Date.now() + dto.due_days * 86_400_000),
        regulatory_fields: dto.regulatory_fields,
        created_by: ctx.userId,
        line_items: {
          create: withSplit.map((p) => ({
            tenant_id: ctx.tenantId,
            charge_master_id: p.master?.id ?? null,
            charge_code: p.line.charge_code,
            description: p.line.description,
            quantity: p.line.quantity,
            unit_price_minor: p.unitPrice,
            discount_minor: p.totals.discount_minor,
            tax_rate_bp: p.taxBp,
            tax_minor: p.totals.tax_minor,
            total_minor: p.totals.total_minor,
            payer_share_minor: p.payer,
            patient_share_minor: p.patient,
            service_date: p.line.service_date ?? new Date(),
            source_type: p.line.source_type,
            source_id: p.line.source_id,
          })),
        },
      },
      include: { line_items: true },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'Invoice',
      internal_id: invoice.id,
      fhir_id: invoice.fhir_id,
      operation: 'create',
      payload: invoiceToFhir(invoice as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);

    return invoice;
  }

  /** Renders the invoice through the tenant's country pack for printing. */
  async formatInvoice(id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: { line_items: true, patient: { select: { mrn: true, given_names: true, family_name: true } } },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');

    const pack = getCountryPack(invoice.country_pack);
    return {
      invoice,
      formatted: pack.formatInvoice(invoice as never),
      required_fields: pack.getRequiredFields('invoice'),
    };
  }

  /**
   * Payments are applied inside a transaction that re-reads the balance, so two
   * concurrent receipts cannot together overpay an invoice.
   */
  async recordPayment(dto: z.infer<typeof RecordPaymentDto>) {
    const ctx = currentContext();
    const receiptNumber = await this.nextNumber('RCP');

    return this.prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: dto.invoice_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!invoice) throw new BadRequestException('Invoice not found');
      if (invoice.status === 'cancelled') throw new BadRequestException('Invoice is cancelled');
      if (dto.amount_minor > invoice.balance_minor) {
        throw new BadRequestException(
          `Payment of ${dto.amount_minor} exceeds the outstanding balance of ${invoice.balance_minor}`,
        );
      }

      const payment = await tx.payment.create({
        data: {
          tenant_id: ctx.tenantId,
          invoice_id: invoice.id,
          patient_id: invoice.patient_id,
          receipt_number: receiptNumber,
          method: dto.method,
          status: 'succeeded',
          currency: invoice.currency,
          amount_minor: dto.amount_minor,
          gateway_reference: dto.gateway_reference,
          received_by: ctx.userId,
          notes: dto.notes,
        },
      });

      const paid = invoice.paid_minor + dto.amount_minor;
      const balance = invoice.total_minor - paid;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paid_minor: paid,
          balance_minor: balance,
          status: balance === 0 ? 'paid' : 'partially_paid',
        },
      });

      return { payment, balance_minor: balance };
    });
  }

  async getInvoice(id: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: { line_items: true, payments: true, claims: true },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');
    return invoice;
  }

  async listInvoices(params: { patientId?: string; status?: string; page: number; limit: number }) {
    const where = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      ...(params.patientId ? { patient_id: params.patientId } : {}),
      ...(params.status ? { status: params.status as never } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: { line_items: true },
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { data, total, page: params.page, limit: params.limit, pages: Math.ceil(total / params.limit) };
  }
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly service: BillingService) {}

  @Get('invoices')
  @RequirePermissions('invoice:read')
  list(@Query() q: Record<string, string>) {
    return this.service.listInvoices({
      patientId: q.patient_id,
      status: q.status,
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 25),
    });
  }

  @Post('invoices')
  @RequirePermissions('invoice:write')
  @Audit({ action: 'invoice.create', resourceType: 'Invoice', isPhi: true })
  create(@ZodBody(CreateInvoiceDto) dto: z.infer<typeof CreateInvoiceDto>) {
    return this.service.createInvoice(dto);
  }

  @Get('invoices/:id')
  @RequirePermissions('invoice:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getInvoice(id);
  }

  @Get('invoices/:id/print')
  @RequirePermissions('invoice:read')
  @ApiOperation({ summary: 'Country-pack formatted invoice for printing' })
  print(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.formatInvoice(id);
  }

  @Post('payments')
  @RequirePermissions('payment:write')
  @Audit({ action: 'payment.record', resourceType: 'Payment', isPhi: true })
  pay(@ZodBody(RecordPaymentDto) dto: z.infer<typeof RecordPaymentDto>) {
    return this.service.recordPayment(dto);
  }
}

@Module({
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
