export const KAFKA_TOPICS = {
  FHIR_SYNC: 'medicore.fhir.sync',
  CRITICAL_ALERT: 'medicore.clinical.critical-alert',
  EWS_ESCALATION: 'medicore.clinical.ews-escalation',
  ADT: 'medicore.adt',
  AUDIT: 'medicore.audit',
  NOTIFICATION: 'medicore.notification',
  BILLING: 'medicore.billing',
  INVENTORY: 'medicore.inventory',
} as const;
export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export type FhirResourceType =
  | 'Patient'
  | 'Encounter'
  | 'Condition'
  | 'AllergyIntolerance'
  | 'MedicationRequest'
  | 'MedicationDispense'
  | 'MedicationAdministration'
  | 'Observation'
  | 'ServiceRequest'
  | 'DiagnosticReport'
  | 'ImagingStudy'
  | 'Appointment'
  | 'Practitioner'
  | 'Organization'
  | 'Location'
  | 'Coverage'
  | 'Claim'
  | 'ClaimResponse'
  | 'Invoice'
  | 'CarePlan'
  | 'Composition';

export interface FhirSyncEvent {
  tenant_id: string;
  resource_type: FhirResourceType;
  internal_id: string;
  fhir_id: string | null;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, unknown>;
  occurred_at: string;
}

export type AlertSeverity = 'info' | 'warning' | 'critical' | 'life-threatening';

export interface CriticalAlertEvent {
  tenant_id: string;
  patient_id: string;
  encounter_id: string | null;
  source: 'lab' | 'vitals' | 'ews' | 'medication' | 'device' | 'allergy';
  severity: AlertSeverity;
  title: string;
  detail: string;
  value?: string;
  reference_range?: string;
  target_roles: string[];
  target_user_ids?: string[];
  occurred_at: string;
  dedupe_key: string;
}

export interface AdtEvent {
  tenant_id: string;
  patient_id: string;
  admission_id: string;
  event: 'admit' | 'discharge' | 'transfer' | 'bed-swap';
  from_bed_id?: string;
  to_bed_id?: string;
  occurred_at: string;
}

export interface AuditEvent {
  tenant_id: string;
  user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  patient_id: string | null;
  ip: string | null;
  user_agent: string | null;
  outcome: 'success' | 'failure';
  is_break_glass: boolean;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurred_at: string;
}

export interface NotificationEvent {
  tenant_id: string;
  channel: 'sms' | 'whatsapp' | 'email' | 'push' | 'in-app';
  recipient: string;
  template: string;
  params: Record<string, string>;
  scheduled_for?: string;
}

/** WebSocket channels served by core-api at /ws. */
export const WS_EVENTS = {
  QUEUE_UPDATED: 'queue.updated',
  BED_UPDATED: 'bed.updated',
  CRITICAL_ALERT: 'alert.critical',
  VITALS_RECORDED: 'vitals.recorded',
  LAB_RESULT: 'lab.result',
  TASK_UPDATED: 'task.updated',
  SCRIBE_PARTIAL: 'scribe.partial',
} as const;
export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];
