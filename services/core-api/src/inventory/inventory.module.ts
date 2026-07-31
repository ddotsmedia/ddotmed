import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

export const ReceiveStockDto = z.object({
  item_code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  quantity: z.number().int().positive(),
  unit: z.string().min(1),
  unit_cost_minor: z.number().int().min(0),
  currency: z.string().length(3),
  batch_number: z.string().optional(),
  serial_number: z.string().optional(),
  expiry_date: z.coerce.date().nullable().optional(),
  gtin: z.string().optional(),
  udi: z.string().optional(),
  supplier_id: z.string().uuid().nullable().optional(),
  purchase_order_ref: z.string().optional(),
  safety_stock: z.number().int().min(0).default(0),
  reorder_quantity: z.number().int().min(0).default(0),
  location_id: z.string().uuid().nullable().optional(),
});

export const IssueStockDto = z.object({
  inventory_item_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  reason: z.string().max(500).optional(),
});

export const AdjustStockDto = z.object({
  /** The counted figure. Absolute, not a delta — a stock take produces a number. */
  quantity_on_hand: z.number().int().min(0).optional(),
  /** Signed correction, for a known loss or a found box. */
  adjustment: z.number().int().optional(),
  safety_stock: z.number().int().min(0).optional(),
  reorder_quantity: z.number().int().min(0).optional(),
  location_id: z.string().uuid().nullable().optional(),
  expiry_date: z.coerce.date().nullable().optional(),
  /** Mandatory. An unexplained stock correction is indistinguishable from theft. */
  reason: z.string().min(5).max(500),
});

export const RecallDto = z.object({
  gtin: z.string().optional(),
  item_code: z.string().optional(),
  batch_number: z.string().optional(),
  recall_reference: z.string().min(1),
  reason: z.string().min(5).max(1000),
});

/** GS1 Application Identifiers used on healthcare packaging. */
const GS1_AI: Record<string, { name: string; length: number | null }> = {
  '01': { name: 'gtin', length: 14 },
  '10': { name: 'batch', length: null },
  '11': { name: 'production_date', length: 6 },
  '17': { name: 'expiry_date', length: 6 },
  '21': { name: 'serial', length: null },
  '30': { name: 'quantity', length: null },
};

export interface ParsedGs1 {
  gtin?: string;
  batch?: string;
  serial?: string;
  expiry_date?: Date;
  production_date?: Date;
  quantity?: number;
  unparsed?: string;
}

const FNC1 = String.fromCharCode(29);

/** Parses a GS1-128 / GS1 DataMatrix payload, using FNC1 (ASCII 29) as the separator. */
export function parseGs1(raw: string): ParsedGs1 {
  const out: ParsedGs1 = {};
  let s = raw.replace(/^\]d2|^\]C1/, '');
  let guard = 0;

  while (s.length >= 2 && guard++ < 20) {
    const ai = s.slice(0, 2);
    const def = GS1_AI[ai];
    if (!def) {
      out.unparsed = s;
      break;
    }
    s = s.slice(2);

    let value: string;
    if (def.length !== null) {
      value = s.slice(0, def.length);
      s = s.slice(def.length);
    } else {
      const fnc1 = s.indexOf(FNC1);
      value = fnc1 === -1 ? s : s.slice(0, fnc1);
      s = fnc1 === -1 ? '' : s.slice(fnc1 + 1);
    }

    switch (def.name) {
      case 'gtin':
        out.gtin = value;
        break;
      case 'batch':
        out.batch = value;
        break;
      case 'serial':
        out.serial = value;
        break;
      case 'quantity':
        out.quantity = Number(value);
        break;
      case 'expiry_date':
      case 'production_date': {
        // YYMMDD; DD of 00 means "end of month" per the GS1 general specification.
        const yy = Number(value.slice(0, 2));
        const mm = Number(value.slice(2, 4));
        const dd = Number(value.slice(4, 6));
        const year = 2000 + yy;
        const date =
          dd === 0 ? new Date(Date.UTC(year, mm, 0)) : new Date(Date.UTC(year, mm - 1, dd));
        if (def.name === 'expiry_date') out.expiry_date = date;
        else out.production_date = date;
        break;
      }
    }
  }

  return out;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async receive(dto: z.infer<typeof ReceiveStockDto>) {
    const ctx = currentContext();
    const batch = dto.batch_number ?? 'NOBATCH';

    // Receiving the same item/batch again increments rather than creating a duplicate row.
    const existing = await this.prisma.inventoryItem.findFirst({
      where: { tenant_id: ctx.tenantId, item_code: dto.item_code, batch_number: batch, deleted_at: null },
    });

    if (existing) {
      return this.prisma.inventoryItem.update({
        where: { id: existing.id },
        data: {
          quantity_on_hand: { increment: dto.quantity },
          unit_cost_minor: dto.unit_cost_minor,
          purchase_order_ref: dto.purchase_order_ref ?? existing.purchase_order_ref,
        },
      });
    }

    return this.prisma.inventoryItem.create({
      data: {
        tenant_id: ctx.tenantId,
        location_id: dto.location_id ?? null,
        item_code: dto.item_code,
        name: dto.name,
        category: dto.category,
        gtin: dto.gtin,
        udi: dto.udi,
        batch_number: batch,
        serial_number: dto.serial_number,
        expiry_date: dto.expiry_date ?? null,
        quantity_on_hand: dto.quantity,
        safety_stock: dto.safety_stock,
        reorder_quantity: dto.reorder_quantity,
        unit: dto.unit,
        unit_cost_minor: dto.unit_cost_minor,
        currency: dto.currency,
        supplier_id: dto.supplier_id ?? null,
        purchase_order_ref: dto.purchase_order_ref,
      },
    });
  }

  /** Scan-to-receive: decodes a GS1 barcode into a receiving payload. */
  scanBarcode(raw: string): ParsedGs1 {
    const parsed = parseGs1(raw);
    if (!parsed.gtin && !parsed.batch && !parsed.serial) {
      throw new BadRequestException('Barcode did not decode to a recognised GS1 structure');
    }
    return parsed;
  }

  async issue(dto: z.infer<typeof IssueStockDto>) {
    const ctx = currentContext();
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({
        where: { id: dto.inventory_item_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!item) throw new BadRequestException('Inventory item not found');
      if (item.is_recalled) throw new BadRequestException('This batch is under recall and cannot be issued');

      const updated = await tx.inventoryItem.updateMany({
        where: { id: dto.inventory_item_id, quantity_on_hand: { gte: dto.quantity } },
        data: { quantity_on_hand: { decrement: dto.quantity } },
      });
      if (updated.count === 0) {
        throw new BadRequestException(`Insufficient stock: ${item.quantity_on_hand} available`);
      }

      const after = await tx.inventoryItem.findUnique({ where: { id: dto.inventory_item_id } });
      return after;
    });
  }

  /** Items at or below safety stock, with a suggested order quantity. */
  async reorderReport() {
    const items = await this.prisma.inventoryItem.findMany({
      where: { tenant_id: currentContext().tenantId, deleted_at: null, safety_stock: { gt: 0 } },
    });
    return items
      .filter((i) => i.quantity_on_hand <= i.safety_stock)
      .map((i) => ({
        item: i,
        shortfall: i.safety_stock - i.quantity_on_hand,
        suggested_order_quantity: Math.max(i.reorder_quantity, i.safety_stock - i.quantity_on_hand),
      }));
  }

  /**
   * Recall: flags every matching batch and returns the affected patient trace so the
   * clinical team can contact anyone who already received the product.
   */
  async recall(dto: z.infer<typeof RecallDto>) {
    const ctx = currentContext();
    if (!dto.gtin && !dto.item_code && !dto.batch_number) {
      throw new BadRequestException('Provide at least one of gtin, item_code or batch_number');
    }

    const where = {
      tenant_id: ctx.tenantId,
      deleted_at: null,
      ...(dto.gtin ? { gtin: dto.gtin } : {}),
      ...(dto.item_code ? { item_code: dto.item_code } : {}),
      ...(dto.batch_number ? { batch_number: dto.batch_number } : {}),
    };

    const [inventoryUpdated, pharmacyUpdated] = await Promise.all([
      this.prisma.inventoryItem.updateMany({
        where,
        data: { is_recalled: true, recall_reference: dto.recall_reference },
      }),
      this.prisma.pharmacyItem.updateMany({
        where: {
          tenant_id: ctx.tenantId,
          deleted_at: null,
          ...(dto.gtin ? { gtin: dto.gtin } : {}),
          ...(dto.item_code ? { item_code: dto.item_code } : {}),
          ...(dto.batch_number ? { batch_number: dto.batch_number } : {}),
        },
        data: { is_recalled: true, recall_reason: dto.reason },
      }),
    ]);

    const affectedPatients = dto.batch_number
      ? await this.prisma.medicationDispense.findMany({
          where: { tenant_id: ctx.tenantId, batch_number: dto.batch_number, deleted_at: null },
          include: {
            patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
          },
        })
      : [];

    await this.kafka.emit(KAFKA_TOPICS.INVENTORY, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      event: 'recall',
      reference: dto.recall_reference,
      reason: dto.reason,
      affected_patients: affectedPatients.length,
      occurred_at: new Date().toISOString(),
    });

    return {
      recall_reference: dto.recall_reference,
      inventory_batches_flagged: inventoryUpdated.count,
      pharmacy_batches_flagged: pharmacyUpdated.count,
      affected_patients: affectedPatients.map((d) => ({
        patient: d.patient,
        dispensed_at: d.dispensed_at,
        quantity: d.quantity,
      })),
    };
  }

  /**
   * Stock list.
   *
   * "Low stock" compares two columns, which Prisma cannot express in a where
   * clause, so those rows are filtered in code — before paging, not after. Paging
   * a page and then filtering it returns a short page and a wrong total, which is
   * how a stock-out stays hidden on page two.
   */
  async list(params: {
    category?: string;
    locationId?: string;
    lowStockOnly?: boolean;
    expiringWithinDays?: number;
    page: number;
    limit: number;
  }) {
    const where = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      ...(params.category ? { category: params.category } : {}),
      ...(params.locationId ? { location_id: params.locationId } : {}),
      ...(params.expiringWithinDays
        ? {
            expiry_date: {
              not: null,
              lte: new Date(Date.now() + params.expiringWithinDays * 86_400_000),
            },
          }
        : {}),
    };

    if (!params.lowStockOnly) {
      const [data, total] = await Promise.all([
        this.prisma.inventoryItem.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (params.page - 1) * params.limit,
          take: params.limit,
        }),
        this.prisma.inventoryItem.count({ where }),
      ]);
      return {
        data,
        total,
        page: params.page,
        limit: params.limit,
        pages: Math.ceil(total / params.limit),
      };
    }

    const all = await this.prisma.inventoryItem.findMany({
      where: { ...where, safety_stock: { gt: 0 } },
      orderBy: { name: 'asc' },
      take: 5000,
    });
    const low = all.filter((i) => i.quantity_on_hand <= i.safety_stock);
    const start = (params.page - 1) * params.limit;
    return {
      data: low.slice(start, start + params.limit),
      total: low.length,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(low.length / params.limit),
    };
  }

  /**
   * Manual correction after a stock take or a known loss.
   *
   * Either an absolute count or a signed adjustment, never both, and always with
   * a reason: the difference between a correction and a discrepancy is whether
   * anyone wrote down why.
   */
  async adjust(id: string, dto: z.infer<typeof AdjustStockDto>) {
    const ctx = currentContext();
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!item) throw new BadRequestException('Inventory item not found');

    if (dto.quantity_on_hand !== undefined && dto.adjustment !== undefined) {
      throw new BadRequestException('Give either a counted quantity or an adjustment, not both');
    }

    const next =
      dto.quantity_on_hand ??
      (dto.adjustment !== undefined ? item.quantity_on_hand + dto.adjustment : item.quantity_on_hand);
    if (next < 0) {
      throw new BadRequestException(
        `That adjustment would take ${item.name} below zero (${item.quantity_on_hand} on hand)`,
      );
    }

    const updated = await this.prisma.inventoryItem.update({
      where: { id },
      data: {
        quantity_on_hand: next,
        ...(dto.safety_stock !== undefined ? { safety_stock: dto.safety_stock } : {}),
        ...(dto.reorder_quantity !== undefined ? { reorder_quantity: dto.reorder_quantity } : {}),
        ...(dto.location_id !== undefined ? { location_id: dto.location_id } : {}),
        ...(dto.expiry_date !== undefined ? { expiry_date: dto.expiry_date } : {}),
        last_counted_at: dto.quantity_on_hand !== undefined ? new Date() : item.last_counted_at,
      },
    });

    await this.kafka.emit(KAFKA_TOPICS.INVENTORY, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      event: 'adjusted',
      item_id: updated.id,
      item_code: updated.item_code,
      from: item.quantity_on_hand,
      to: updated.quantity_on_hand,
      reason: dto.reason,
      adjusted_by: ctx.userId,
      occurred_at: new Date().toISOString(),
    });

    return { item: updated, previous_quantity: item.quantity_on_hand, reason: dto.reason };
  }

  /** Nightly sweep emitting reorder events for anything at or below safety stock. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async autoReorderSweep(): Promise<void> {
    const low = await this.prisma.inventoryItem.findMany({
      where: { deleted_at: null, safety_stock: { gt: 0 } },
      take: 5000,
    });
    const due = low.filter((i) => i.quantity_on_hand <= i.safety_stock);

    for (const item of due) {
      await this.kafka.emit(KAFKA_TOPICS.INVENTORY, item.tenant_id, {
        tenant_id: item.tenant_id,
        event: 'reorder-required',
        item_code: item.item_code,
        name: item.name,
        on_hand: item.quantity_on_hand,
        safety_stock: item.safety_stock,
        suggested_quantity: Math.max(item.reorder_quantity, item.safety_stock - item.quantity_on_hand),
        occurred_at: new Date().toISOString(),
      });
    }
    if (due.length) this.logger.log(`Raised ${due.length} reorder events`);
  }
}

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get()
  @RequirePermissions('inventory:manage')
  @ApiOperation({ summary: 'Stock list, optionally only what is at or below safety stock' })
  list(@Query() q: Record<string, string>) {
    return this.service.list({
      category: q.category,
      locationId: q.locationId ?? q.location_id,
      // Both spellings are in use across the clients.
      lowStockOnly: q.lowStock === 'true' || q.low_stock === 'true',
      expiringWithinDays: q.expiringWithinDays ? Number(q.expiringWithinDays) : undefined,
      page: Number(q.page ?? 1),
      limit: Number(q.limit ?? 50),
    });
  }

  @Get('reorder-report')
  @RequirePermissions('inventory:manage')
  reorder() {
    return this.service.reorderReport();
  }

  @Post('receive')
  @RequirePermissions('inventory:manage')
  @Audit({ action: 'inventory.receive', resourceType: 'InventoryItem' })
  receive(@ZodBody(ReceiveStockDto) dto: z.infer<typeof ReceiveStockDto>) {
    return this.service.receive(dto);
  }

  @Post('scan')
  @RequirePermissions('inventory:manage')
  @ApiOperation({ summary: 'Decode a GS1-128 / DataMatrix barcode into a receiving payload' })
  scan(@Body('barcode') barcode: string) {
    return this.service.scanBarcode(barcode);
  }

  @Post('issue')
  @RequirePermissions('inventory:manage')
  @Audit({ action: 'inventory.issue', resourceType: 'InventoryItem' })
  issue(@ZodBody(IssueStockDto) dto: z.infer<typeof IssueStockDto>) {
    return this.service.issue(dto);
  }

  @Patch(':id')
  @RequirePermissions('inventory:manage')
  @Audit({ action: 'inventory.adjust', resourceType: 'InventoryItem' })
  @ApiOperation({ summary: 'Correct stock after a count or a known loss; a reason is required' })
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(AdjustStockDto) dto: z.infer<typeof AdjustStockDto>,
  ) {
    return this.service.adjust(id, dto);
  }

  @Post('recall')
  @RequirePermissions('inventory:manage')
  @Audit({ action: 'inventory.recall', resourceType: 'InventoryItem' })
  @ApiOperation({ summary: 'Flag a recalled batch and trace which patients received it' })
  recall(@ZodBody(RecallDto) dto: z.infer<typeof RecallDto>) {
    return this.service.recall(dto);
  }
}

@Module({
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
