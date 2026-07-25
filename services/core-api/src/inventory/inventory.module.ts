import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
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

  async list(params: { category?: string; lowStockOnly?: boolean; page: number; limit: number }) {
    const where = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      ...(params.category ? { category: params.category } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.inventoryItem.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.inventoryItem.count({ where }),
    ]);
    const filtered = params.lowStockOnly
      ? data.filter((i) => i.quantity_on_hand <= i.safety_stock)
      : data;
    return { data: filtered, total, page: params.page, limit: params.limit, pages: Math.ceil(total / params.limit) };
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
  list(@Query() q: Record<string, string>) {
    return this.service.list({
      category: q.category,
      lowStockOnly: q.low_stock === 'true',
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
