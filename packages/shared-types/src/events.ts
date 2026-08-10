export const KAFKA_TOPICS = {
  FHIR_SYNC: 'medicore.fhir.sync',
  CRITICAL_ALERT: 'medicore.clinical.critical-alert',
  LAB_CRITICAL_VALUE: 'medicore.lab.critical-value',
  PHARMACY_DISPENSED: 'medicore.pharmacy.dispensed',
  INVENTORY_LOW_STOCK: 'medicore.inventory.low-stock',
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
/**
 * A lab value that is dangerous on its own, published the moment it is filed.
 *
 * Deliberately separate from the general critical-alert stream: this one names the
 * clinician who ordered the test, because a critical result has to reach the person
 * who is expecting it, not only whoever happens to be on the ward.
 */
export interface LabCriticalValueEvent {
  tenant_id: string;
  patient_id: string;
  encounter_id: string | null;
  result_id: string;
  service_request_id: string | null;
  loinc_code: string;
  test_name: string;
  value: string;
  unit: string | null;
  reference_range: string | null;
  interpretation: string | null;
  ordering_practitioner_id: string | null;
  occurred_at: string;
}

export interface PharmacyDispensedEvent {
  tenant_id: string;
  dispense_id: string;
  medication_id: string;
  patient_id: string;
  drug_name: string;
  quantity: number;
  batches: Array<{ batch_number: string; quantity: number; expiry_date: string }>;
  is_controlled: boolean;
  partial: boolean;
  dispensed_by: string | null;
  witness_id: string | null;
  occurred_at: string;
}

/**
 * Raised on the dispense that took stock across the reorder point, not on every
 * dispense below it — an alert that repeats is an alert that gets muted.
 */
export interface InventoryLowStockEvent {
  tenant_id: string;
  source: 'pharmacy' | 'inventory';
  item_id: string;
  item_code: string;
  name: string;
  batch_number: string | null;
  location_id: string | null;
  quantity_on_hand: number;
  reorder_level: number;
  suggested_order_quantity: number;
  occurred_at: string;
}

/**
 * A finished video consultation, published for billing.
 *
 * Carries the duration as both seconds and billable minutes: the seconds are the
 * record of what happened, the minutes are what a charge is raised against, and
 * rounding that in the consumer would let two consumers round it differently.
 */
export interface TeleconsultCompletedEvent {
  tenant_id: string;
  event: 'teleconsult_completed';
  session_id: string;
  appointment_id: string;
  patient_id: string;
  practitioner_id: string | null;
  encounter_id: string | null;
  provider: string;
  room_id: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
  billable_minutes: number;
  occurred_at: string;
}

export const WS_EVENTS = {
  QUEUE_UPDATED: 'queue.updated',
  BED_UPDATED: 'bed.updated',
  CRITICAL_ALERT: 'alert.critical',
  VITALS_RECORDED: 'vitals.recorded',
  LAB_RESULT: 'lab.result',
  TASK_UPDATED: 'task.updated',
  NOTIFICATION: 'notification.created',
  SCRIBE_PARTIAL: 'scribe.partial',
  /** A message posted to an appointment thread, fanned out on `appointment:<id>`. */
  MESSAGE_CREATED: 'message.created',
} as const;
export type WsEvent = (typeof WS_EVENTS)[keyof typeof WS_EVENTS];
