import { z } from 'zod';
import {
  AddressSchema,
  BaseEntitySchema,
  CodingSchema,
  ContactPointSchema,
  HumanNameSchema,
  PeriodSchema,
  isoDate,
  uuid,
} from './base.js';

export const GenderSchema = z.enum(['male', 'female', 'other', 'unknown']);
export type Gender = z.infer<typeof GenderSchema>;

export const PatientIdentifierSchema = z.object({
  type: z.string(),
  value: z.string().min(1),
  system: z.string().optional(),
  country: z.string().length(2).optional(),
  expires_at: isoDate.nullable().optional(),
});
export type PatientIdentifier = z.infer<typeof PatientIdentifierSchema>;

export const PatientSchema = BaseEntitySchema.extend({
  mrn: z.string().min(1),
  name: HumanNameSchema,
  gender: GenderSchema,
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deceased_at: isoDate.nullable().optional(),
  identifiers: z.array(PatientIdentifierSchema).default([]),
  telecom: z.array(ContactPointSchema).default([]),
  address: AddressSchema.nullable().optional(),
  marital_status: z.string().optional(),
  preferred_language: z.string().default('en'),
  nationality: z.string().length(2).optional(),
  blood_group: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']).optional(),
  photo_url: z.string().url().nullable().optional(),
  merged_into_id: uuid.nullable().optional(),
  is_vip: z.boolean().default(false),
});
export type Patient = z.infer<typeof PatientSchema>;

export const EncounterStatusSchema = z.enum([
  'planned',
  'arrived',
  'triaged',
  'in-progress',
  'onleave',
  'finished',
  'cancelled',
  'closed',
]);
export type EncounterStatus = z.infer<typeof EncounterStatusSchema>;

export const EncounterClassSchema = z.enum([
  'AMB',
  'EMER',
  'IMP',
  'ACUTE',
  'NONAC',
  'OBSENC',
  'VR',
  'HH',
]);
export type EncounterClass = z.infer<typeof EncounterClassSchema>;

export const EncounterSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  practitioner_id: uuid.nullable(),
  location_id: uuid.nullable(),
  organization_id: uuid.nullable(),
  status: EncounterStatusSchema,
  class: EncounterClassSchema,
  type: CodingSchema.nullable().optional(),
  reason_text: z.string().max(2000).nullable().optional(),
  period: PeriodSchema,
  triage_level: z.number().int().min(1).max(5).nullable().optional(),
  discharge_disposition: z.string().nullable().optional(),
  appointment_id: uuid.nullable().optional(),
});
export type Encounter = z.infer<typeof EncounterSchema>;

export const ConditionSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  code: CodingSchema,
  category: z.enum(['problem-list-item', 'encounter-diagnosis']),
  clinical_status: z.enum(['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved']),
  verification_status: z.enum([
    'unconfirmed',
    'provisional',
    'differential',
    'confirmed',
    'refuted',
    'entered-in-error',
  ]),
  severity: z.enum(['mild', 'moderate', 'severe']).nullable().optional(),
  onset_date: isoDate.nullable().optional(),
  abatement_date: isoDate.nullable().optional(),
  recorded_by: uuid,
  is_primary: z.boolean().default(false),
});
export type Condition = z.infer<typeof ConditionSchema>;

export const AllergyCriticalitySchema = z.enum(['low', 'high', 'unable-to-assess']);
export type AllergyCriticality = z.infer<typeof AllergyCriticalitySchema>;

export const AllergySchema = BaseEntitySchema.extend({
  patient_id: uuid,
  type: z.enum(['allergy', 'intolerance']),
  category: z.enum(['food', 'medication', 'environment', 'biologic', 'latex', 'contrast']),
  criticality: AllergyCriticalitySchema,
  code: CodingSchema,
  substance_rxnorm: z.string().nullable().optional(),
  reaction: z.array(z.string()).default([]),
  clinical_status: z.enum(['active', 'inactive', 'resolved']).default('active'),
  onset_date: isoDate.nullable().optional(),
  recorded_by: uuid,
});
export type Allergy = z.infer<typeof AllergySchema>;

export const MedicationSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  prescriber_id: uuid,
  status: z.enum(['draft', 'active', 'on-hold', 'cancelled', 'completed', 'stopped']),
  intent: z.enum(['proposal', 'plan', 'order', 'original-order']).default('order'),
  code: CodingSchema,
  drug_formulary_id: uuid.nullable().optional(),
  dose_quantity: z.number().positive(),
  dose_unit: z.string(),
  route: z.string(),
  frequency: z.string(),
  duration_days: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().positive(),
  refills: z.number().int().min(0).default(0),
  instructions: z.string().max(1000).nullable().optional(),
  is_controlled: z.boolean().default(false),
  controlled_schedule: z.string().nullable().optional(),
  witness_id: uuid.nullable().optional(),
  allergy_override_reason: z.string().nullable().optional(),
  interaction_override_reason: z.string().nullable().optional(),
});
export type Medication = z.infer<typeof MedicationSchema>;

export const LabResultSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  service_request_id: uuid.nullable(),
  specimen_id: uuid.nullable(),
  loinc_code: z.string(),
  display: z.string(),
  status: z.enum(['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled']),
  value_quantity: z.number().nullable(),
  value_string: z.string().nullable().optional(),
  unit: z.string().nullable(),
  reference_low: z.number().nullable(),
  reference_high: z.number().nullable(),
  interpretation: z.enum(['N', 'L', 'H', 'LL', 'HH', 'A', 'AA']).nullable(),
  is_critical: z.boolean().default(false),
  critical_notified_at: isoDate.nullable().optional(),
  performed_at: isoDate,
  verified_by: uuid.nullable(),
});
export type LabResult = z.infer<typeof LabResultSchema>;

export const VitalSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  encounter_id: uuid.nullable(),
  recorded_by: uuid.nullable(),
  recorded_at: isoDate,
  source: z.enum(['manual', 'device', 'wearable']).default('manual'),
  device_id: z.string().nullable().optional(),
  systolic_bp: z.number().int().min(0).max(300).nullable().optional(),
  diastolic_bp: z.number().int().min(0).max(200).nullable().optional(),
  heart_rate: z.number().int().min(0).max(300).nullable().optional(),
  respiratory_rate: z.number().int().min(0).max(100).nullable().optional(),
  temperature_c: z.number().min(20).max(45).nullable().optional(),
  spo2: z.number().int().min(0).max(100).nullable().optional(),
  supplemental_o2: z.boolean().default(false),
  consciousness: z.enum(['A', 'C', 'V', 'P', 'U']).nullable().optional(),
  pain_score: z.number().int().min(0).max(10).nullable().optional(),
  weight_kg: z.number().positive().nullable().optional(),
  height_cm: z.number().positive().nullable().optional(),
  bmi: z.number().positive().nullable().optional(),
  ews_score: z.number().int().min(0).nullable().optional(),
  ews_risk: z.enum(['low', 'medium', 'high']).nullable().optional(),
});
export type Vital = z.infer<typeof VitalSchema>;

export const AppointmentStatusSchema = z.enum([
  'proposed',
  'pending',
  'booked',
  'arrived',
  'fulfilled',
  'cancelled',
  'noshow',
  'checked-in',
  'waitlist',
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatusSchema>;

export const AppointmentSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  practitioner_id: uuid.nullable(),
  location_id: uuid.nullable(),
  slot_id: uuid.nullable(),
  status: AppointmentStatusSchema,
  service_type: z.string(),
  specialty: z.string().nullable().optional(),
  start: isoDate,
  end: isoDate,
  minutes_duration: z.number().int().positive(),
  reason_text: z.string().max(1000).nullable().optional(),
  channel: z.enum(['walk-in', 'phone', 'online', 'app', 'voice-agent', 'referral']),
  is_telehealth: z.boolean().default(false),
  queue_token: z.string().nullable().optional(),
  noshow_risk: z.number().min(0).max(1).nullable().optional(),
  reminder_sent_at: isoDate.nullable().optional(),
  cancellation_reason: z.string().nullable().optional(),
});
export type Appointment = z.infer<typeof AppointmentSchema>;

export const BedStatusSchema = z.enum([
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'blocked',
  'maintenance',
]);
export type BedStatus = z.infer<typeof BedStatusSchema>;

export const BedSchema = BaseEntitySchema.extend({
  location_id: uuid,
  ward: z.string(),
  room: z.string(),
  bed_number: z.string(),
  bed_type: z.enum(['general', 'icu', 'hdu', 'isolation', 'nicu', 'picu', 'ot', 'er', 'maternity']),
  status: BedStatusSchema,
  gender_restriction: GenderSchema.nullable().optional(),
  current_admission_id: uuid.nullable().optional(),
  is_oxygen_supported: z.boolean().default(false),
  is_ventilator_supported: z.boolean().default(false),
  daily_rate_minor: z.number().int().min(0).default(0),
});
export type Bed = z.infer<typeof BedSchema>;

export const PractitionerSchema = BaseEntitySchema.extend({
  user_id: uuid.nullable(),
  name: HumanNameSchema,
  gender: GenderSchema.optional(),
  license_number: z.string(),
  license_authority: z.string(),
  license_expires_at: isoDate.nullable(),
  specialties: z.array(z.string()).default([]),
  qualifications: z.array(z.string()).default([]),
  telecom: z.array(ContactPointSchema).default([]),
  npi: z.string().nullable().optional(),
  active: z.boolean().default(true),
});
export type Practitioner = z.infer<typeof PractitionerSchema>;

export const OrganizationSchema = BaseEntitySchema.extend({
  name: z.string().min(1),
  type: z.enum(['hospital', 'clinic', 'lab', 'pharmacy', 'imaging', 'payer', 'department']),
  parent_id: uuid.nullable().optional(),
  license_number: z.string().nullable().optional(),
  country: z.string().length(2),
  address: AddressSchema.nullable().optional(),
  telecom: z.array(ContactPointSchema).default([]),
  active: z.boolean().default(true),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const ClinicalNoteTypeSchema = z.enum(['soap', 'progress', 'nursing', 'discharge', 'sbar']);
export type ClinicalNoteType = z.infer<typeof ClinicalNoteTypeSchema>;

export const LinkedEvidenceSchema = z.object({
  sentence: z.string(),
  audio_offset_ms: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});
export type LinkedEvidence = z.infer<typeof LinkedEvidenceSchema>;

export const ClinicalNoteSchema = BaseEntitySchema.extend({
  patient_id: uuid,
  encounter_id: uuid,
  author_id: uuid,
  type: ClinicalNoteTypeSchema,
  status: z.enum(['draft', 'pending-approval', 'signed', 'amended', 'entered-in-error']),
  subjective: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
  assessment: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  ai_drafted: z.boolean().default(false),
  ai_session_id: uuid.nullable().optional(),
  ai_model_version: z.string().nullable().optional(),
  ai_confidence: z.number().min(0).max(1).nullable().optional(),
  linked_evidence: z.array(LinkedEvidenceSchema).default([]),
  approved_by: uuid.nullable().optional(),
  approved_at: isoDate.nullable().optional(),
  version: z.number().int().min(1).default(1),
});
export type ClinicalNote = z.infer<typeof ClinicalNoteSchema>;
