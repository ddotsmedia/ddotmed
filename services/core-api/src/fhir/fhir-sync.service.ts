import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KAFKA_TOPICS, type FhirResourceType, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';

type Row = Record<string, unknown>;

/** Internal resource type → the Prisma delegate that stores its fhir_id. */
const FHIR_ID_TARGET: Partial<Record<FhirResourceType, string>> = {
  Patient: 'patient',
  Encounter: 'encounter',
  Condition: 'condition',
  AllergyIntolerance: 'allergy',
  MedicationRequest: 'medication',
  MedicationDispense: 'medicationDispense',
  MedicationAdministration: 'medicationAdministration',
  ServiceRequest: 'serviceRequest',
  ImagingStudy: 'imagingStudy',
  Appointment: 'appointment',
  Coverage: 'coverage',
  Invoice: 'invoice',
  Composition: 'clinicalNote',
};

/**
 * Consumes medicore.fhir.sync and mirrors each write into HAPI FHIR.
 * The internal database stays the source of truth; HAPI is the interoperability
 * surface, so a sync failure is retried rather than rolled back into clinical data.
 */
@Injectable()
export class FhirSyncService implements OnModuleInit {
  private readonly logger = new Logger(FhirSyncService.name);
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(
    private readonly kafka: KafkaService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.baseUrl = (config.get<string>('FHIR_SERVER_URL') ?? '').replace(/\/$/, '');
    this.enabled = Boolean(this.baseUrl) && config.get('FHIR_SYNC_ENABLED') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('FHIR_SERVER_URL not configured — FHIR sync is disabled');
      return;
    }
    await this.kafka.subscribe(KAFKA_TOPICS.FHIR_SYNC, 'medicore-fhir-sync', async (payload) => {
      await this.handle(payload as FhirSyncEvent);
    });
  }

  private async handle(event: FhirSyncEvent): Promise<void> {
    // Vitals fan out to several Observations from one internal row.
    const bundle = (event.payload as { observations?: Row[] }).observations;
    if (Array.isArray(bundle)) {
      for (const observation of bundle) await this.upsert('Observation', observation, event);
      return;
    }
    await this.upsert(event.resource_type, event.payload as Row, event);
  }

  private async upsert(
    resourceType: string,
    resource: Row,
    event: FhirSyncEvent,
  ): Promise<void> {
    try {
      // Conditional update keyed on our internal id keeps the operation idempotent.
      const identifier = `urn:medicore:${event.resource_type.toLowerCase()}|${event.internal_id}`;
      const body = {
        ...resource,
        identifier: [
          ...((resource.identifier as Row[] | undefined) ?? []),
          { system: `urn:medicore:${event.resource_type.toLowerCase()}`, value: event.internal_id },
        ],
      };

      const response = await fetch(
        `${this.baseUrl}/${resourceType}?identifier=${encodeURIComponent(identifier)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/fhir+json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) {
        this.logger.error(
          `FHIR ${resourceType} sync failed (${response.status}) for ${event.internal_id}`,
        );
        return;
      }

      const created = (await response.json()) as { id?: string };
      if (created.id) await this.storeFhirId(event.resource_type, event.internal_id, created.id);
    } catch (e) {
      this.logger.error(`FHIR sync error for ${resourceType} ${event.internal_id}: ${String(e)}`);
    }
  }

  /** Writes the server-assigned FHIR id back so later reads can reference it directly. */
  private async storeFhirId(
    resourceType: FhirResourceType,
    internalId: string,
    fhirId: string,
  ): Promise<void> {
    const delegateName = FHIR_ID_TARGET[resourceType];
    if (!delegateName) return;
    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // The fhir_id column is a UUID; HAPI may return a numeric server id, which we skip.
    if (!uuidLike.test(fhirId)) return;

    const delegate = (this.prisma as unknown as Record<string, { update: (a: unknown) => Promise<unknown> }>)[
      delegateName
    ];
    if (!delegate) return;
    try {
      await delegate.update({ where: { id: internalId }, data: { fhir_id: fhirId } });
    } catch (e) {
      this.logger.warn(`Could not store fhir_id for ${resourceType} ${internalId}: ${String(e)}`);
    }
  }

  /** Passthrough read used by the SMART on FHIR facade. */
  async read(resourceType: string, id: string): Promise<Row | null> {
    if (!this.enabled) return null;
    const res = await fetch(`${this.baseUrl}/${resourceType}/${id}`, {
      headers: { accept: 'application/fhir+json' },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? ((await res.json()) as Row) : null;
  }

  async search(resourceType: string, query: Record<string, string>): Promise<Row | null> {
    if (!this.enabled) return null;
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(`${this.baseUrl}/${resourceType}?${qs}`, {
      headers: { accept: 'application/fhir+json' },
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? ((await res.json()) as Row) : null;
  }
}
