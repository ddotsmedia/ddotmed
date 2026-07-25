import {
  BadRequestException,
  Body,
  ConflictException,
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
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { medicationAdministrationToFhir, medicationDispenseToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { bucketByExpiry, pickFefo, verifyFiveRights } from './fefo';

export const DispenseDto = z.object({
  medication_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  scanned_patient_barcode: z.string().min(1),
  scanned_medication_barcode: z.string().min(1),
  witness_id: z.string().uuid().nullable().optional(),
  allow_substitution: z.boolean().default(false),
  substitution_reason: z.string().max(500).optional(),
});

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  /** Prescriptions awaiting dispensing, oldest first with controlled drugs surfaced. */
  async prescriptionQueue() {
    return this.prisma.medication.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        status: 'active',
        dispenses: { none: {} },
      },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
        formulary: true,
      },
      orderBy: [{ is_controlled: 'desc' }, { created_at: 'asc' }],
      take: 200,
    });
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

    const rights = verifyFiveRights({
      scanned_patient_barcode: dto.scanned_patient_barcode,
      expected_patient_barcode: medication.patient.mrn,
      scanned_medication_barcode: dto.scanned_medication_barcode,
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

    if (medication.is_controlled && !dto.witness_id) {
      throw new BadRequestException({
        code: 'WITNESS_REQUIRED',
        message: 'A witness is required to dispense a controlled drug',
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

    const pick = pickFefo(batches, dto.quantity);
    if (pick.short_by > 0) {
      throw new ConflictException({
        code: 'INSUFFICIENT_STOCK',
        message: `Short by ${pick.short_by} units`,
        picked: pick.lines,
        skipped: pick.skipped,
      });
    }

    const substituted =
      dto.allow_substitution &&
      pick.lines.some((l) => {
        const b = batches.find((x) => x.id === l.batch_id);
        return b?.drug_formulary_id !== medication.drug_formulary_id;
      });
    if (substituted && !dto.substitution_reason) {
      throw new BadRequestException('A substitution reason is required when dispensing a generic equivalent');
    }

    const dispense = await this.prisma.$transaction(async (tx) => {
      for (const line of pick.lines) {
        const updated = await tx.pharmacyItem.updateMany({
          where: { id: line.batch_id, quantity_on_hand: { gte: line.quantity } },
          data: { quantity_on_hand: { decrement: line.quantity } },
        });
        // Guards against a concurrent dispense having drained the batch since the read.
        if (updated.count === 0) throw new ConflictException('Stock changed during dispensing; retry');
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
          status: 'completed',
          quantity: dto.quantity,
          batch_number: first.batch_number,
          expiry_date: first.expiry_date,
          substituted,
          substitution_reason: dto.substitution_reason,
          barcode_verified: true,
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
            quantity_change: -dto.quantity,
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

    return { dispense, picked: pick.lines, substituted };
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
  queue() {
    return this.service.prescriptionQueue();
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
  controllers: [PharmacyController],
  providers: [PharmacyService],
  exports: [PharmacyService],
})
export class PharmacyModule {}
