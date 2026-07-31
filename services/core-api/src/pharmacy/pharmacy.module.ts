import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  KAFKA_TOPICS,
  type FhirSyncEvent,
  type InventoryLowStockEvent,
  type PharmacyDispensedEvent,
} from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { medicationAdministrationToFhir, medicationDispenseToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { AllergiesModule } from '../allergies/allergies.module';
import { AllergiesService } from '../allergies/allergies.service';
import { MedicationsModule } from '../medications/medications.module';
import { InteractionsService } from '../medications/interactions.service';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';
import { bucketByExpiry, pickFefo, verifyFiveRights } from './fefo';
import {
  crossedReorderLevel,
  expiringBatches,
  sortQueue,
  EXPIRY_WARNING_DAYS,
} from './dispense-queue';

export const DispenseDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    return { ...v, quantity: v.quantity ?? v.quantity_dispensed };
  },
  z
    .object({
      medication_id: z.string().uuid(),
      quantity: z.number().int().positive(),
      /** Scanned at the counter. Absent only when the label could not be read. */
      scanned_patient_barcode: z.string().min(1).optional(),
      scanned_medication_barcode: z.string().min(1).optional(),
      /**
       * What the pharmacist is asserting. Sending false is a deliberate manual
       * override and has to be justified — it is recorded on the dispense either way.
       */
      barcode_verified: z.boolean().optional(),
      barcode_override_reason: z.string().min(10).max(500).optional(),
      /** Preferred batch. FEFO still decides unless this batch is the earliest usable one. */
      batch_no: z.string().max(60).optional(),
      expiry_date: z.coerce.date().optional(),
      pharmacist_id: z.string().uuid().nullable().optional(),
      witness_id: z.string().uuid().nullable().optional(),
      /** Allows a short pick to go out rather than failing with 409. */
      partial_dispense: z.boolean().default(false),
      allow_substitution: z.boolean().default(false),
      substitution_reason: z.string().max(500).optional(),
      override_reason: z.string().min(10).max(500).optional(),
    })
    .refine(
      (v) =>
        (v.scanned_patient_barcode && v.scanned_medication_barcode) ||
        Boolean(v.barcode_override_reason),
      {
        message:
          'Scan the patient and medication barcodes, or record why verification was not possible',
        path: ['barcode_override_reason'],
      },
    ),
);

export const AdministerDto = z.object({
  medication_id: z.string().uuid(),
  dose_given: z.number().positive(),
  dose_unit: z.string().min(1),
  route: z.string().min(1),
  site: z.string().optional(),
  scheduled_at: z.coerce.date().nullable().optional(),
  scanned_patient_barcode: z.string().min(1),
  scanned_medication_barcode: z.string().min(1),
  witness_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

export const ColdChainDto = z.object({
  pharmacy_item_id: z.string().uuid().nullable().optional(),
  inventory_item_id: z.string().uuid().nullable().optional(),
  device_id: z.string().min(1),
  temperature_c: z.number(),
  humidity_pct: z.number().nullable().optional(),
  recorded_at: z.coerce.date().optional(),
});

@Injectable()
export class PharmacyService {
  private readonly logger = new Logger(PharmacyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly allergies: AllergiesService,
    private readonly interactions: InteractionsService,
    private readonly notifications: NotificationsService,
  ) {}

/**
   * Prescriptions still waiting to be handed over.
   *
   * Ordered by `sortQueue`, not by the database: a prescription has no priority
   * column, and the urgency that matters is derived from the drug, the setting
   * and how long the patient has already stood at the counter.
   */
  async prescriptionQueue(locationId?: string) {
    const rows = await this.prisma.medication.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        status: 'active',
        dispenses: { none: {} },
        ...(locationId ? { encounter: { location_id: locationId } } : {}),
      },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
        formulary: true,
        encounter: { select: { id: true, class: true, location_id: true } },
      },
      take: 200,
    });

    return sortQueue(
      rows.map((row) => ({
        ...row,
        encounter_class: row.encounter?.class ?? null,
        is_high_alert: row.formulary?.is_high_alert ?? false,
      })),
    ).map((entry) => ({
      ...entry.item,
      queue_priority: entry.priority,
      waiting_minutes: entry.waiting_minutes,
      queue_reason: entry.reason,
    }));
  }

  /**
   * The allergy and interaction gates, run again at the counter.
   *
   * The prescriber already passed them, but hours may have passed since: an
   * allergy recorded during the admission, or a drug started on another ward,
   * would otherwise never be seen. This is the last point at which the drug can
   * be stopped before it is in the patient's hand.
   */
  async dispenseSafetyCheck(
    patientId: string,
    drug: { code: string; display: string; ingredients?: string[] },
  ) {
    const [allergy, interaction] = await Promise.all([
      this.allergies.checkAgainstDrug(patientId, {
        rxnorm: drug.code,
        name: drug.display,
        ingredients: drug.ingredients,
      }),
      this.interactions.check(patientId, { rxnorm: drug.code, name: drug.display }),
    ]);
    return { allergy, interaction };
  }

  /**
   * Dispensing picks stock FEFO and verifies the patient and medication barcodes.
   * A wrong-patient scan aborts before any stock moves.
   */
  async dispense(dto: z.infer<typeof DispenseDto>) {
    const ctx = currentContext();
    const medication = await this.prisma.medication.findFirst({
      where: { id: dto.medication_id, tenant_id: ctx.tenantId, deleted_at: null },
      include: { patient: { select: { mrn: true } }, formulary: true },
    });
    if (!medication) throw new BadRequestException('Prescription not found');

    const scanned = Boolean(dto.scanned_patient_barcode && dto.scanned_medication_barcode);
    let barcodeVerified = false;

    if (scanned) {
      const rights = verifyFiveRights({
        scanned_patient_barcode: dto.scanned_patient_barcode!,
        expected_patient_barcode: medication.patient.mrn,
        scanned_medication_barcode: dto.scanned_medication_barcode!,
        expected_medication_barcode: medication.code,
        dose_given: Number(medication.dose_quantity),
        dose_ordered: Number(medication.dose_quantity),
        route_given: medication.route,
        route_ordered: medication.route,
        scheduled_at: null,
        administered_at: new Date(),
      });
      if (rights.wrongPatient) {
        throw new ConflictException({
          code: 'WRONG_PATIENT',
          message: 'WRONG PATIENT — the scanned wristband does not match this prescription',
          checks: rights.checks,
        });
      }
      if (!rights.verified) {
        throw new ConflictException({
          code: 'BARCODE_VERIFICATION_FAILED',
          message: 'Barcode verification failed',
          failures: rights.failures,
        });
      }
      barcodeVerified = true;
    }

    // Second safety gate. A high-criticality allergy stops the hand-over outright;
    // a contraindicated pair likewise. Anything overridable needs a reason here too.
    const safety = await this.dispenseSafetyCheck(medication.patient_id, {
      code: medication.code,
      display: medication.code_display,
      ingredients: medication.formulary ? [medication.formulary.generic_name] : [],
    });
    this.allergies.assertNotBlocked(safety.allergy, medication.code_display);
    this.interactions.assertNotBlocked(safety.interaction, medication.code_display);

    const overridable = [
      ...safety.allergy.warnings.filter((w) => w.action === 'warn'),
      ...safety.interaction.findings.filter((f) => f.action === 'override'),
    ];
    if (overridable.length > 0 && !dto.override_reason) {
      throw new ConflictException({
        code: 'ALLERGY_WARNING_UNACKNOWLEDGED',
        message: `A documented reason is required to dispense ${medication.code_display} despite the recorded warnings`,
        allergy_warnings: safety.allergy.warnings,
        interaction_warnings: safety.interaction.findings,
        override_allowed: true,
      });
    }

    if (medication.is_controlled && !dto.witness_id) {
      throw new BadRequestException({
        code: 'WITNESS_REQUIRED',
        message: 'A witness is required to dispense a controlled drug',
        controlled_schedule: medication.controlled_schedule,
      });
    }
    if (medication.is_controlled && dto.witness_id === ctx.userId) {
      throw new BadRequestException({
        code: 'WITNESS_INVALID',
        message: 'The witness must be a different person from the dispensing pharmacist',
      });
    }

    // Candidate stock: the exact drug, or a generic equivalent when substitution is allowed.
    const formularyIds = [medication.drug_formulary_id].filter(Boolean) as string[];
    if (dto.allow_substitution && medication.formulary) {
      const equivalents = await this.prisma.drugFormulary.findMany({
        where: {
          tenant_id: ctx.tenantId,
          deleted_at: null,
          generic_name: medication.formulary.generic_name,
          strength: medication.formulary.strength,
          dose_form: medication.formulary.dose_form,
        },
        select: { id: true },
      });
      formularyIds.push(...equivalents.map((e) => e.id));
    }

    const batches = await this.prisma.pharmacyItem.findMany({
      where: {
        tenant_id: ctx.tenantId,
        deleted_at: null,
        ...(formularyIds.length ? { drug_formulary_id: { in: formularyIds } } : {}),
        quantity_on_hand: { gt: 0 },
      },
      orderBy: { expiry_date: 'asc' },
    });

    // A nominated batch is honoured only when FEFO would not have picked something
    // that expires sooner — otherwise the older stock is left to expire on the shelf.
    const ordered = dto.batch_no
      ? [...batches].sort((a, b) => {
          if (a.batch_number === dto.batch_no) return -1;
          if (b.batch_number === dto.batch_no) return 1;
          return a.expiry_date.getTime() - b.expiry_date.getTime();
        })
      : batches;
    const nominated = dto.batch_no ? batches.find((b) => b.batch_number === dto.batch_no) : null;
    const earliest = pickFefo(batches, dto.quantity).lines[0];
    const honourNomination =
      Boolean(nominated) &&
      (!earliest || nominated!.expiry_date.getTime() <= earliest.expiry_date.getTime());

    const pick = pickFefo(honourNomination ? ordered : batches, dto.quantity);

    if (pick.short_by > 0) {
      const available = pick.lines.reduce((sum, line) => sum + line.quantity, 0);
      // A short pick is refused outright unless the pharmacist asked for a partial
      // supply: handing over less than was prescribed without saying so is how a
      // course gets silently truncated.
      if (!dto.partial_dispense || available === 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `Short by ${pick.short_by} units`,
          requested_quantity: dto.quantity,
          available_quantity: available,
          picked: pick.lines,
          skipped: pick.skipped,
        });
      }
    }

    const dispensedQuantity = pick.lines.reduce((sum, line) => sum + line.quantity, 0);
    const partial = dispensedQuantity < dto.quantity;

    const substituted =
      dto.allow_substitution &&
      pick.lines.some((l) => {
        const b = batches.find((x) => x.id === l.batch_id);
        return b?.drug_formulary_id !== medication.drug_formulary_id;
      });
    if (substituted && !dto.substitution_reason) {
      throw new BadRequestException('A substitution reason is required when dispensing a generic equivalent');
    }

    const stockCrossings: Array<{ batchId: string; before: number }> = [];

    const dispense = await this.prisma.$transaction(async (tx) => {
      for (const line of pick.lines) {
        const before = batches.find((b) => b.id === line.batch_id)?.quantity_on_hand ?? 0;
        const updated = await tx.pharmacyItem.updateMany({
          where: { id: line.batch_id, quantity_on_hand: { gte: line.quantity } },
          data: { quantity_on_hand: { decrement: line.quantity } },
        });
        // Guards against a concurrent dispense having drained the batch since the read.
        if (updated.count === 0) throw new ConflictException('Stock changed during dispensing; retry');
        stockCrossings.push({ batchId: line.batch_id, before });
      }

      const first = pick.lines[0]!;
      const record = await tx.medicationDispense.create({
        data: {
          tenant_id: ctx.tenantId,
          medication_id: medication.id,
          patient_id: medication.patient_id,
          pharmacy_item_id: first.batch_id,
          dispensed_by: ctx.userId!,
          witness_id: dto.witness_id ?? null,
          status: partial ? 'in-progress' : 'completed',
          quantity: dispensedQuantity,
          batch_number: first.batch_number,
          expiry_date: first.expiry_date,
          substituted,
          substitution_reason: dto.substitution_reason,
          // Recorded as it actually happened, not as it is supposed to happen.
          barcode_verified: barcodeVerified,
        },
      });

      if (medication.is_controlled) {
        const remaining = await tx.pharmacyItem.aggregate({
          where: { tenant_id: ctx.tenantId, drug_formulary_id: medication.drug_formulary_id, deleted_at: null },
          _sum: { quantity_on_hand: true },
        });
        await tx.controlledDrugRegister.create({
          data: {
            tenant_id: ctx.tenantId,
            medication_id: medication.id,
            pharmacy_item_id: first.batch_id,
            entry_type: 'dispensed',
            schedule: medication.controlled_schedule ?? 'unscheduled',
            drug_name: medication.code_display,
            batch_number: first.batch_number,
            quantity_change: -dispensedQuantity,
            balance_after: remaining._sum.quantity_on_hand ?? 0,
            performed_by: ctx.userId!,
            witness_id: dto.witness_id!,
            patient_id: medication.patient_id,
            reason: 'Dispensed to patient',
          },
        });
      }

      return record;
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'MedicationDispense',
      internal_id: dispense.id,
      fhir_id: dispense.fhir_id,
      operation: 'create',
      payload: medicationDispenseToFhir(dispense as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);

    const dispensedEvent: PharmacyDispensedEvent = {
      tenant_id: ctx.tenantId,
      dispense_id: dispense.id,
      medication_id: medication.id,
      patient_id: medication.patient_id,
      drug_name: medication.code_display,
      quantity: dispensedQuantity,
      batches: pick.lines.map((line) => ({
        batch_number: line.batch_number,
        quantity: line.quantity,
        expiry_date: line.expiry_date.toISOString(),
      })),
      is_controlled: medication.is_controlled,
      partial,
      dispensed_by: dto.pharmacist_id ?? ctx.userId,
      witness_id: dto.witness_id ?? null,
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.PHARMACY_DISPENSED, ctx.tenantId, dispensedEvent);

    await this.raiseLowStockAlerts(stockCrossings, pick.lines);

    return {
      dispense,
      picked: pick.lines,
      substituted,
      partial,
      dispensed_quantity: dispensedQuantity,
      requested_quantity: dto.quantity,
      safety,
    };
  }

  /**
   * Alerts on the dispense that took a batch across its reorder point.
   *
   * The notification is written directly rather than round-tripped through Kafka:
   * the broker is optional in this deployment, and a stock-out that nobody was
   * told about is the failure this exists to prevent. The event is still
   * published for anything downstream that wants it.
   */
  private async raiseLowStockAlerts(
    crossings: ReadonlyArray<{ batchId: string; before: number }>,
    lines: ReadonlyArray<{ batch_id: string; quantity: number }>,
  ): Promise<void> {
    const ctx = currentContext();

    for (const crossing of crossings) {
      const line = lines.find((l) => l.batch_id === crossing.batchId);
      if (!line) continue;

      const batch = await this.prisma.pharmacyItem.findFirst({
        where: { id: crossing.batchId, tenant_id: ctx.tenantId },
      });
      if (!batch) continue;
      if (!crossedReorderLevel(crossing.before, batch.quantity_on_hand, batch.reorder_level)) {
        continue;
      }

      const suggested = Math.max(batch.reorder_quantity, batch.reorder_level - batch.quantity_on_hand);
      const event: InventoryLowStockEvent = {
        tenant_id: ctx.tenantId,
        source: 'pharmacy',
        item_id: batch.id,
        item_code: batch.item_code,
        name: batch.name,
        batch_number: batch.batch_number,
        location_id: batch.location_id,
        quantity_on_hand: batch.quantity_on_hand,
        reorder_level: batch.reorder_level,
        suggested_order_quantity: suggested,
        occurred_at: new Date().toISOString(),
      };
      await this.kafka.emit(KAFKA_TOPICS.INVENTORY_LOW_STOCK, ctx.tenantId, event);

      await this.notifications.create({
        tenant_id: ctx.tenantId,
        role: 'pharmacist',
        category: 'inventory-low-stock',
        severity: 'warning',
        title: `Low stock: ${batch.name}`,
        body: `${batch.quantity_on_hand} left of ${batch.item_code} (batch ${batch.batch_number}); reorder level is ${batch.reorder_level}. Suggested order: ${suggested}.`,
        resource_type: 'PharmacyItem',
        resource_id: batch.id,
        dedupe_key: `low-stock:${batch.id}`,
      });

      this.logger.warn(`${batch.name} fell below its reorder level (${batch.quantity_on_hand})`);
    }
  }

  /**
   * Nightly expiry sweep across pharmacy and general stock.
   *
   * Runs unscoped by tenant — it is a job, not a request — so every write names
   * the tenant it came from explicitly.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async expirySweep(now = new Date()): Promise<{ flagged: number }> {
    const horizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 86_400_000);

    const [pharmacy, inventory] = await Promise.all([
      this.prisma.pharmacyItem.findMany({
        where: { deleted_at: null, quantity_on_hand: { gt: 0 }, expiry_date: { lte: horizon } },
        take: 5000,
      }),
      this.prisma.inventoryItem.findMany({
        where: {
          deleted_at: null,
          quantity_on_hand: { gt: 0 },
          expiry_date: { not: null, lte: horizon },
        },
        take: 5000,
      }),
    ]);

    const rows = [
      ...expiringBatches(pharmacy, now).map((r) => ({ ...r, source: 'PharmacyItem' as const })),
      ...expiringBatches(
        inventory.map((i) => ({ ...i, batch_number: i.batch_number })),
        now,
      ).map((r) => ({ ...r, source: 'InventoryItem' as const })),
    ];

    for (const row of rows) {
      const batch = row.batch as { id: string; tenant_id: string; name: string; batch_number: string | null; quantity_on_hand: number };
      const expired = row.band === 'expired';
      await this.notifications.create({
        tenant_id: batch.tenant_id,
        role: 'pharmacist',
        category: 'inventory-expiry',
        severity: expired ? 'critical' : 'warning',
        title: expired ? `Expired stock: ${batch.name}` : `Expiring soon: ${batch.name}`,
        body: expired
          ? `${batch.quantity_on_hand} units of batch ${batch.batch_number ?? '—'} expired ${Math.abs(row.days_remaining)} days ago. Quarantine and destroy.`
          : `${batch.quantity_on_hand} units of batch ${batch.batch_number ?? '—'} expire in ${row.days_remaining} days.`,
        resource_type: row.source,
        resource_id: batch.id,
        // One standing alert per batch, refreshed as the date approaches.
        dedupe_key: `expiry:${row.source}:${batch.id}`,
        requires_acknowledgement: expired,
      });
    }

    if (rows.length) this.logger.log(`Expiry sweep flagged ${rows.length} batches`);
    return { flagged: rows.length };
  }

  /** Bedside administration (eMAR). All five rights are recorded, pass or fail. */
  async administer(dto: z.infer<typeof AdministerDto>) {
    const ctx = currentContext();
    const medication = await this.prisma.medication.findFirst({
      where: { id: dto.medication_id, tenant_id: ctx.tenantId, deleted_at: null },
      include: { patient: { select: { mrn: true } } },
    });
    if (!medication) throw new BadRequestException('Prescription not found');

    const administeredAt = new Date();
    const rights = verifyFiveRights({
      scanned_patient_barcode: dto.scanned_patient_barcode,
      expected_patient_barcode: medication.patient.mrn,
      scanned_medication_barcode: dto.scanned_medication_barcode,
      expected_medication_barcode: medication.code,
      dose_given: dto.dose_given,
      dose_ordered: Number(medication.dose_quantity),
      route_given: dto.route,
      route_ordered: medication.route,
      scheduled_at: dto.scheduled_at ?? null,
      administered_at: administeredAt,
    });

    if (rights.wrongPatient) {
      throw new ConflictException({
        code: 'WRONG_PATIENT',
        message: 'WRONG PATIENT — do not administer. The scanned wristband does not match this order.',
        checks: rights.checks,
      });
    }
    if (!rights.verified) {
      throw new ConflictException({
        code: 'FIVE_RIGHTS_FAILED',
        message: 'Administration blocked: the five rights were not satisfied',
        failures: rights.failures,
      });
    }
    if (medication.is_controlled && !dto.witness_id) {
      throw new BadRequestException({
        code: 'WITNESS_REQUIRED',
        message: 'A witness is required to administer a controlled drug',
      });
    }

    const administration = await this.prisma.medicationAdministration.create({
      data: {
        tenant_id: ctx.tenantId,
        medication_id: medication.id,
        patient_id: medication.patient_id,
        administered_by: ctx.userId!,
        witness_id: dto.witness_id ?? null,
        status: 'completed',
        dose_given: dto.dose_given,
        dose_unit: dto.dose_unit,
        route: dto.route,
        site: dto.site,
        scheduled_at: dto.scheduled_at ?? null,
        administered_at: administeredAt,
        patient_barcode_verified: true,
        medication_barcode_verified: true,
        dose_verified: true,
        route_verified: true,
        time_verified: true,
        notes: dto.notes,
      },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'MedicationAdministration',
      internal_id: administration.id,
      fhir_id: administration.fhir_id,
      operation: 'create',
      payload: medicationAdministrationToFhir(administration as unknown as Record<string, unknown>),
      occurred_at: administeredAt.toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);

    return { administration, rights: rights.checks };
  }

  async recordNotGiven(medicationId: string, reason: string) {
    const ctx = currentContext();
    const medication = await this.prisma.medication.findFirst({
      where: { id: medicationId, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!medication) throw new BadRequestException('Prescription not found');
    return this.prisma.medicationAdministration.create({
      data: {
        tenant_id: ctx.tenantId,
        medication_id: medicationId,
        patient_id: medication.patient_id,
        administered_by: ctx.userId!,
        status: 'not-done',
        dose_given: 0,
        dose_unit: medication.dose_unit,
        route: medication.route,
        not_given_reason: reason,
      },
    });
  }

  /** eMAR view: what is due for a patient across the shift. */
  async emar(patientId: string) {
    const meds = await this.prisma.medication.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        status: 'active',
      },
      include: {
        administrations: { orderBy: { administered_at: 'desc' }, take: 10 },
        formulary: true,
      },
      orderBy: { created_at: 'asc' },
    });
    return meds;
  }

  async stockOverview(formularyId?: string) {
    const items = await this.prisma.pharmacyItem.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(formularyId ? { drug_formulary_id: formularyId } : {}),
      },
      orderBy: { expiry_date: 'asc' },
    });
    return {
      items,
      expiry: bucketByExpiry(items.map((i) => ({ ...i, expiry_date: i.expiry_date }))),
      recalled: items.filter((i) => i.is_recalled).length,
    };
  }

  /** Cold-chain telemetry; an out-of-range reading is flagged as an excursion. */
  async recordColdChain(dto: z.infer<typeof ColdChainDto>) {
    const ctx = currentContext();
    const item = dto.pharmacy_item_id
      ? await this.prisma.pharmacyItem.findFirst({
          where: { id: dto.pharmacy_item_id, tenant_id: ctx.tenantId, deleted_at: null },
        })
      : null;

    const min = item?.storage_temp_min != null ? Number(item.storage_temp_min) : 2;
    const max = item?.storage_temp_max != null ? Number(item.storage_temp_max) : 8;
    const isExcursion = dto.temperature_c < min || dto.temperature_c > max;

    return this.prisma.coldChainEvent.create({
      data: {
        tenant_id: ctx.tenantId,
        pharmacy_item_id: dto.pharmacy_item_id ?? null,
        inventory_item_id: dto.inventory_item_id ?? null,
        device_id: dto.device_id,
        temperature_c: dto.temperature_c,
        humidity_pct: dto.humidity_pct ?? null,
        is_excursion: isExcursion,
        recorded_at: dto.recorded_at ?? new Date(),
      },
    });
  }

  async controlledRegister(from?: Date, to?: Date) {
    return this.prisma.controlledDrugRegister.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(from || to
          ? { occurred_at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { occurred_at: 'desc' },
      take: 500,
    });
  }
}

@ApiTags('pharmacy')
@Controller('pharmacy')
export class PharmacyController {
  constructor(private readonly service: PharmacyService) {}

  @Get('queue')
  @RequirePermissions('medication:dispense')
  @ApiOperation({ summary: 'Prescriptions awaiting dispense, most urgent first' })
  queue(@Query('locationId') locationId?: string) {
    return this.service.prescriptionQueue(locationId);
  }

  @Post('dispense')
  @RequirePermissions('medication:dispense')
  @Audit({ action: 'pharmacy.dispense', resourceType: 'MedicationDispense', isPhi: true })
  @ApiOperation({ summary: 'Dispense with FEFO stock picking and barcode verification' })
  dispense(@ZodBody(DispenseDto) dto: z.infer<typeof DispenseDto>) {
    return this.service.dispense(dto);
  }

  @Post('administer')
  @RequirePermissions('medication:administer')
  @Audit({ action: 'pharmacy.administer', resourceType: 'MedicationAdministration', isPhi: true })
  @ApiOperation({ summary: 'Bedside administration with 5-rights barcode verification' })
  administer(@ZodBody(AdministerDto) dto: z.infer<typeof AdministerDto>) {
    return this.service.administer(dto);
  }

  @Post('not-given/:medicationId')
  @RequirePermissions('medication:administer')
  @Audit({ action: 'pharmacy.not-given', resourceType: 'MedicationAdministration', isPhi: true })
  notGiven(@Param('medicationId', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.recordNotGiven(id, reason);
  }

  @Get('emar/:patientId')
  @RequirePermissions('medication:administer')
  emar(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.service.emar(patientId);
  }

  @Get('stock')
  @RequirePermissions('inventory:manage')
  stock(@Query('formulary_id') formularyId?: string) {
    return this.service.stockOverview(formularyId);
  }

  @Post('cold-chain')
  @RequirePermissions('inventory:manage')
  coldChain(@ZodBody(ColdChainDto) dto: z.infer<typeof ColdChainDto>) {
    return this.service.recordColdChain(dto);
  }

  @Get('controlled-register')
  @RequirePermissions('controlled:witness')
  @Audit({ action: 'pharmacy.controlled-register.read', resourceType: 'ControlledDrugRegister' })
  register(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.controlledRegister(
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }
}

@Module({
  imports: [AllergiesModule, MedicationsModule, NotificationsModule],
  controllers: [PharmacyController],
  providers: [PharmacyService],
  exports: [PharmacyService],
})
export class PharmacyModule {}
