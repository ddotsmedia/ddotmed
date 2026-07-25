-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'unknown');

-- CreateEnum
CREATE TYPE "EncounterStatus" AS ENUM ('planned', 'arrived', 'triaged', 'in_progress', 'onleave', 'finished', 'cancelled', 'closed');

-- CreateEnum
CREATE TYPE "EncounterClass" AS ENUM ('AMB', 'EMER', 'IMP', 'ACUTE', 'NONAC', 'OBSENC', 'VR', 'HH');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('proposed', 'pending', 'booked', 'arrived', 'fulfilled', 'cancelled', 'noshow', 'checked_in', 'waitlist');

-- CreateEnum
CREATE TYPE "ConditionCategory" AS ENUM ('problem_list_item', 'encounter_diagnosis');

-- CreateEnum
CREATE TYPE "ClinicalStatus" AS ENUM ('active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered_in_error');

-- CreateEnum
CREATE TYPE "AllergyCriticality" AS ENUM ('low', 'high', 'unable_to_assess');

-- CreateEnum
CREATE TYPE "AllergyCategory" AS ENUM ('food', 'medication', 'environment', 'biologic', 'latex', 'contrast');

-- CreateEnum
CREATE TYPE "MedicationStatus" AS ENUM ('draft', 'active', 'on_hold', 'cancelled', 'completed', 'stopped');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('soap', 'progress', 'nursing', 'discharge', 'sbar');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('draft', 'pending_approval', 'signed', 'amended', 'entered_in_error');

-- CreateEnum
CREATE TYPE "ObservationStatus" AS ENUM ('registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('draft', 'active', 'on_hold', 'revoked', 'completed', 'entered_in_error');

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('available', 'occupied', 'reserved', 'cleaning', 'blocked', 'maintenance');

-- CreateEnum
CREATE TYPE "BedType" AS ENUM ('general', 'icu', 'hdu', 'isolation', 'nicu', 'picu', 'ot', 'er', 'maternity');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled', 'written_off');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('draft', 'pre_auth_required', 'pre_auth_approved', 'pre_auth_denied', 'submitted', 'accepted', 'rejected', 'partially_paid', 'paid', 'denied', 'appealed', 'closed');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'card', 'bank_transfer', 'insurance', 'wallet', 'apple_pay', 'google_pay', 'cheque');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('azure_openai', 'openai', 'anthropic', 'google', 'local');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "fhir_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_pack" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "currency" VARCHAR(3) NOT NULL,
    "active_modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_verified_at" TIMESTAMPTZ(6),
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" TEXT,
    "mfa_recovery_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "oidc_subject" TEXT,
    "oidc_issuer" TEXT,
    "saml_name_id" TEXT,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6),
    "preferred_locale" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "fhir_id" UUID,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "location_id" UUID,
    "granted_by" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_jti" TEXT NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "device_id" TEXT,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "user_id" UUID,
    "session_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "patient_id" UUID,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'success',
    "is_break_glass" BOOLEAN NOT NULL DEFAULT false,
    "break_glass_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "license_number" TEXT,
    "country" VARCHAR(2) NOT NULL,
    "address" JSONB,
    "telecom" JSONB NOT NULL DEFAULT '[]',
    "tax_registration_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "floor" TEXT,
    "building" TEXT,
    "address" JSONB,
    "operational_status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioners" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "user_id" UUID,
    "given_names" TEXT[],
    "family_name" TEXT NOT NULL,
    "gender" "Gender",
    "license_number" TEXT NOT NULL,
    "license_authority" TEXT NOT NULL,
    "license_expires_at" TIMESTAMPTZ(6),
    "npi" TEXT,
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "qualifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "telecom" JSONB NOT NULL DEFAULT '[]',
    "signature_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "practitioners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practitioner_roles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "practitioner_id" UUID NOT NULL,
    "organization_id" UUID,
    "location_id" UUID,
    "code" TEXT NOT NULL,
    "specialty" TEXT,
    "available_time" JSONB NOT NULL DEFAULT '[]',
    "period_start" TIMESTAMPTZ(6),
    "period_end" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "practitioner_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "mrn" TEXT NOT NULL,
    "given_names" TEXT[],
    "family_name" TEXT NOT NULL,
    "name_search" TEXT NOT NULL,
    "gender" "Gender" NOT NULL,
    "birth_date" DATE NOT NULL,
    "deceased_at" TIMESTAMPTZ(6),
    "marital_status" TEXT,
    "preferred_language" TEXT NOT NULL DEFAULT 'en',
    "nationality" VARCHAR(2),
    "blood_group" TEXT,
    "address" JSONB,
    "photo_url" TEXT,
    "is_vip" BOOLEAN NOT NULL DEFAULT false,
    "merged_into_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "merged_by" UUID,
    "country_pack" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_identifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_normalized" TEXT NOT NULL,
    "system" TEXT,
    "country" VARCHAR(2),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "patient_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "given_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "family_name" TEXT,
    "system" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "use" TEXT NOT NULL DEFAULT 'mobile',
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "rank" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "patient_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "practitioner_id" UUID,
    "location_id" UUID,
    "service_type" TEXT NOT NULL,
    "specialty" TEXT,
    "planning_start" TIMESTAMPTZ(6) NOT NULL,
    "planning_end" TIMESTAMPTZ(6) NOT NULL,
    "slot_minutes" INTEGER NOT NULL DEFAULT 15,
    "recurrence" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "schedule_id" UUID NOT NULL,
    "start" TIMESTAMPTZ(6) NOT NULL,
    "end" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'free',
    "overbooked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID,
    "location_id" UUID,
    "slot_id" UUID,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'booked',
    "service_type" TEXT NOT NULL,
    "specialty" TEXT,
    "start" TIMESTAMPTZ(6) NOT NULL,
    "end" TIMESTAMPTZ(6) NOT NULL,
    "minutes_duration" INTEGER NOT NULL,
    "reason_text" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'walk-in',
    "is_telehealth" BOOLEAN NOT NULL DEFAULT false,
    "telehealth_url" TEXT,
    "queue_token" TEXT,
    "noshow_risk" DECIMAL(4,3),
    "reminder_sent_at" TIMESTAMPTZ(6),
    "reminder_channel" TEXT,
    "checked_in_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "location_id" UUID,
    "appointment_id" UUID,
    "patient_id" UUID,
    "queue_name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "called_at" TIMESTAMPTZ(6),
    "served_at" TIMESTAMPTZ(6),
    "counter" TEXT,
    "estimated_wait_minutes" INTEGER,
    "queue_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID,
    "location_id" UUID,
    "organization_id" UUID,
    "appointment_id" UUID,
    "status" "EncounterStatus" NOT NULL DEFAULT 'planned',
    "class" "EncounterClass" NOT NULL DEFAULT 'AMB',
    "type_code" TEXT,
    "type_display" TEXT,
    "reason_text" TEXT,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6),
    "triage_level" INTEGER,
    "discharge_disposition" TEXT,
    "discharge_summary_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conditions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "code_system" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "code_display" TEXT,
    "snomed_code" TEXT,
    "category" "ConditionCategory" NOT NULL DEFAULT 'encounter_diagnosis',
    "clinical_status" "ClinicalStatus" NOT NULL DEFAULT 'active',
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'confirmed',
    "severity" TEXT,
    "body_site" TEXT,
    "onset_date" TIMESTAMPTZ(6),
    "abatement_date" TIMESTAMPTZ(6),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "recorded_by" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "type" "NoteType" NOT NULL DEFAULT 'soap',
    "status" "NoteStatus" NOT NULL DEFAULT 'draft',
    "subjective" TEXT,
    "objective" TEXT,
    "assessment" TEXT,
    "plan" TEXT,
    "body" TEXT,
    "ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "ai_session_id" UUID,
    "ai_model_version" TEXT,
    "ai_confidence" DECIMAL(4,3),
    "linked_evidence" JSONB NOT NULL DEFAULT '[]',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "clinical_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "intent" TEXT NOT NULL DEFAULT 'plan',
    "category" TEXT,
    "description" TEXT,
    "goals" JSONB NOT NULL DEFAULT '[]',
    "activities" JSONB NOT NULL DEFAULT '[]',
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6),
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "care_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allergies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'allergy',
    "category" "AllergyCategory" NOT NULL,
    "criticality" "AllergyCriticality" NOT NULL DEFAULT 'low',
    "code_system" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "code_display" TEXT,
    "substance_rxnorm" TEXT,
    "reaction" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "severity" TEXT,
    "clinical_status" TEXT NOT NULL DEFAULT 'active',
    "onset_date" TIMESTAMPTZ(6),
    "last_occurrence" TIMESTAMPTZ(6),
    "recorded_by" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vitals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "recorded_by" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "device_id" TEXT,
    "systolic_bp" INTEGER,
    "diastolic_bp" INTEGER,
    "heart_rate" INTEGER,
    "respiratory_rate" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "spo2" INTEGER,
    "supplemental_o2" BOOLEAN NOT NULL DEFAULT false,
    "consciousness" TEXT,
    "pain_score" INTEGER,
    "weight_kg" DECIMAL(6,2),
    "height_cm" DECIMAL(5,1),
    "bmi" DECIMAL(5,2),
    "ews_score" INTEGER,
    "ews_risk" TEXT,
    "escalated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_formulary" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "rxnorm_code" TEXT,
    "atc_code" TEXT,
    "generic_name" TEXT NOT NULL,
    "brand_name" TEXT,
    "strength" TEXT NOT NULL,
    "dose_form" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "is_generic" BOOLEAN NOT NULL DEFAULT false,
    "generic_of_id" UUID,
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "controlled_schedule" TEXT,
    "is_high_alert" BOOLEAN NOT NULL DEFAULT false,
    "requires_witness" BOOLEAN NOT NULL DEFAULT false,
    "max_daily_dose" DECIMAL(10,3),
    "pregnancy_category" TEXT,
    "is_formulary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "drug_formulary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_interactions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "fhir_id" UUID,
    "rxnorm_a" TEXT NOT NULL,
    "rxnorm_b" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "mechanism" TEXT,
    "clinical_effect" TEXT NOT NULL,
    "management" TEXT,
    "evidence_level" TEXT,
    "source" TEXT NOT NULL DEFAULT 'internal',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "drug_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "prescriber_id" UUID NOT NULL,
    "drug_formulary_id" UUID,
    "status" "MedicationStatus" NOT NULL DEFAULT 'active',
    "intent" TEXT NOT NULL DEFAULT 'order',
    "code_system" TEXT NOT NULL DEFAULT 'http://www.nlm.nih.gov/research/umls/rxnorm',
    "code" TEXT NOT NULL,
    "code_display" TEXT NOT NULL,
    "dose_quantity" DECIMAL(10,3) NOT NULL,
    "dose_unit" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration_days" INTEGER,
    "quantity" INTEGER NOT NULL,
    "refills" INTEGER NOT NULL DEFAULT 0,
    "refills_used" INTEGER NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "is_prn" BOOLEAN NOT NULL DEFAULT false,
    "is_controlled" BOOLEAN NOT NULL DEFAULT false,
    "controlled_schedule" TEXT,
    "witness_id" UUID,
    "allergy_checked_at" TIMESTAMPTZ(6),
    "interaction_checked_at" TIMESTAMPTZ(6),
    "allergy_override_reason" TEXT,
    "interaction_override_reason" TEXT,
    "start_date" TIMESTAMPTZ(6),
    "end_date" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication_dispenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "medication_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "pharmacy_item_id" UUID,
    "dispensed_by" UUID NOT NULL,
    "witness_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "quantity" INTEGER NOT NULL,
    "batch_number" TEXT,
    "expiry_date" DATE,
    "substituted" BOOLEAN NOT NULL DEFAULT false,
    "substitution_reason" TEXT,
    "barcode_verified" BOOLEAN NOT NULL DEFAULT false,
    "dispensed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "medication_dispenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication_administrations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "medication_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "administered_by" UUID NOT NULL,
    "witness_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "dose_given" DECIMAL(10,3) NOT NULL,
    "dose_unit" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "site" TEXT,
    "scheduled_at" TIMESTAMPTZ(6),
    "administered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "not_given_reason" TEXT,
    "patient_barcode_verified" BOOLEAN NOT NULL DEFAULT false,
    "medication_barcode_verified" BOOLEAN NOT NULL DEFAULT false,
    "dose_verified" BOOLEAN NOT NULL DEFAULT false,
    "route_verified" BOOLEAN NOT NULL DEFAULT false,
    "time_verified" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "medication_administrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controlled_drug_register" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "medication_id" UUID,
    "pharmacy_item_id" UUID,
    "entry_type" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "drug_name" TEXT NOT NULL,
    "batch_number" TEXT,
    "quantity_change" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "performed_by" UUID NOT NULL,
    "witness_id" UUID NOT NULL,
    "witness_method" TEXT NOT NULL DEFAULT 'password',
    "patient_id" UUID,
    "reason" TEXT,
    "discrepancy" BOOLEAN NOT NULL DEFAULT false,
    "discrepancy_notes" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "controlled_drug_register_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "requester_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'active',
    "intent" TEXT NOT NULL DEFAULT 'order',
    "priority" TEXT NOT NULL DEFAULT 'routine',
    "code_system" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "code_display" TEXT NOT NULL,
    "reason_text" TEXT,
    "order_number" TEXT NOT NULL,
    "barcode" TEXT,
    "scheduled_for" TIMESTAMPTZ(6),
    "performed_at" TIMESTAMPTZ(6),
    "fasting_required" BOOLEAN NOT NULL DEFAULT false,
    "clinical_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_specimens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "service_request_id" UUID,
    "accession_number" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "container" TEXT,
    "status" TEXT NOT NULL DEFAULT 'available',
    "collected_by" UUID,
    "collected_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "rejected_reason" TEXT,
    "volume_ml" DECIMAL(6,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "lab_specimens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "service_request_id" UUID,
    "specimen_id" UUID,
    "loinc_code" TEXT NOT NULL,
    "display" TEXT NOT NULL,
    "status" "ObservationStatus" NOT NULL DEFAULT 'final',
    "value_quantity" DECIMAL(14,4),
    "value_string" TEXT,
    "unit" TEXT,
    "reference_low" DECIMAL(14,4),
    "reference_high" DECIMAL(14,4),
    "reference_text" TEXT,
    "interpretation" TEXT,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "critical_notified_at" TIMESTAMPTZ(6),
    "critical_notified_to" UUID,
    "method" TEXT,
    "analyzer_id" TEXT,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "source_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imaging_studies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "service_request_id" UUID,
    "study_instance_uid" TEXT NOT NULL,
    "accession_number" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "body_site" TEXT,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'registered',
    "series_count" INTEGER NOT NULL DEFAULT 0,
    "instance_count" INTEGER NOT NULL DEFAULT 0,
    "pacs_url" TEXT,
    "radiation_dose_mgy" DECIMAL(10,3),
    "performed_by" UUID,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "imaging_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "radiology_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "imaging_study_id" UUID NOT NULL,
    "radiologist_id" UUID NOT NULL,
    "status" "ObservationStatus" NOT NULL DEFAULT 'preliminary',
    "clinical_history" TEXT,
    "technique" TEXT,
    "findings" TEXT NOT NULL,
    "impression" TEXT NOT NULL,
    "recommendation" TEXT,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "critical_notified_at" TIMESTAMPTZ(6),
    "transcription_source" TEXT,
    "ai_drafted" BOOLEAN NOT NULL DEFAULT false,
    "ai_confidence" DECIMAL(4,3),
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "radiology_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "drug_formulary_id" UUID,
    "location_id" UUID,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "batch_number" TEXT NOT NULL,
    "expiry_date" DATE NOT NULL,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "cost_price_minor" INTEGER NOT NULL DEFAULT 0,
    "sale_price_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "gtin" TEXT,
    "requires_cold_chain" BOOLEAN NOT NULL DEFAULT false,
    "storage_temp_min" DECIMAL(4,1),
    "storage_temp_max" DECIMAL(4,1),
    "is_recalled" BOOLEAN NOT NULL DEFAULT false,
    "recall_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "pharmacy_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "location_id" UUID,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "gtin" TEXT,
    "udi" TEXT,
    "batch_number" TEXT,
    "serial_number" TEXT,
    "expiry_date" DATE,
    "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "reorder_quantity" INTEGER NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "unit_cost_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "supplier_id" UUID,
    "last_counted_at" TIMESTAMPTZ(6),
    "is_recalled" BOOLEAN NOT NULL DEFAULT false,
    "recall_reference" TEXT,
    "purchase_order_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cold_chain_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "pharmacy_item_id" UUID,
    "inventory_item_id" UUID,
    "device_id" TEXT NOT NULL,
    "temperature_c" DECIMAL(4,1) NOT NULL,
    "humidity_pct" DECIMAL(5,2),
    "is_excursion" BOOLEAN NOT NULL DEFAULT false,
    "excursion_minutes" INTEGER,
    "action_taken" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "cold_chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_master" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "charge_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cpt_code" TEXT,
    "hcpcs_code" TEXT,
    "unit_price_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "charge_master_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "country_pack" TEXT NOT NULL,
    "license_number" TEXT,
    "claim_format" TEXT NOT NULL,
    "api_base_url" TEXT,
    "api_credentials_ref" TEXT,
    "supports_realtime_eligibility" BOOLEAN NOT NULL DEFAULT false,
    "supports_realtime_adjudication" BOOLEAN NOT NULL DEFAULT false,
    "average_days_to_pay" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "member_id" TEXT NOT NULL,
    "policy_number" TEXT NOT NULL,
    "plan_name" TEXT,
    "network" TEXT,
    "relationship" TEXT NOT NULL DEFAULT 'self',
    "status" TEXT NOT NULL DEFAULT 'active',
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "copay_bp" INTEGER NOT NULL DEFAULT 0,
    "deductible_minor" INTEGER NOT NULL DEFAULT 0,
    "annual_limit_minor" INTEGER,
    "used_minor" INTEGER NOT NULL DEFAULT 0,
    "requires_preauth" BOOLEAN NOT NULL DEFAULT false,
    "last_eligibility_check_at" TIMESTAMPTZ(6),
    "last_eligibility_result" JSONB,
    "is_primary" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "coverages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "invoice_number" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "coverage_id" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "currency" VARCHAR(3) NOT NULL,
    "country_pack" TEXT NOT NULL,
    "subtotal_minor" INTEGER NOT NULL DEFAULT 0,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL DEFAULT 0,
    "paid_minor" INTEGER NOT NULL DEFAULT 0,
    "balance_minor" INTEGER NOT NULL DEFAULT 0,
    "payer_share_minor" INTEGER NOT NULL DEFAULT 0,
    "patient_share_minor" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "tax_registration_number" TEXT,
    "regulatory_fields" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "invoice_id" UUID NOT NULL,
    "charge_master_id" UUID,
    "charge_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
    "tax_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL,
    "payer_share_minor" INTEGER NOT NULL DEFAULT 0,
    "patient_share_minor" INTEGER NOT NULL DEFAULT 0,
    "service_date" TIMESTAMPTZ(6) NOT NULL,
    "source_type" TEXT,
    "source_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "invoice_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'succeeded',
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "refunded_minor" INTEGER NOT NULL DEFAULT 0,
    "gateway_reference" TEXT,
    "gateway_response" JSONB,
    "received_by" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_authorizations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "coverage_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "encounter_id" UUID,
    "reference_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_minor" INTEGER NOT NULL,
    "approved_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "diagnosis_codes" JSONB NOT NULL DEFAULT '[]',
    "procedure_codes" JSONB NOT NULL DEFAULT '[]',
    "clinical_justification" TEXT,
    "payer_reference" TEXT,
    "denial_reason" TEXT,
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "pre_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "claim_number" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "invoice_id" UUID,
    "coverage_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "pre_authorization_id" UUID,
    "status" "ClaimStatus" NOT NULL DEFAULT 'draft',
    "country_pack" TEXT NOT NULL,
    "claim_format" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "claimed_minor" INTEGER NOT NULL DEFAULT 0,
    "approved_minor" INTEGER NOT NULL DEFAULT 0,
    "paid_minor" INTEGER NOT NULL DEFAULT 0,
    "denied_minor" INTEGER NOT NULL DEFAULT 0,
    "diagnosis_codes" JSONB NOT NULL DEFAULT '[]',
    "procedure_codes" JSONB NOT NULL DEFAULT '[]',
    "denial_risk" DECIMAL(4,3),
    "denial_risk_factors" JSONB NOT NULL DEFAULT '[]',
    "denial_reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "appeal_notes" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "submitted_at" TIMESTAMPTZ(6),
    "adjudicated_at" TIMESTAMPTZ(6),
    "resubmission_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_responses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "claim_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "disposition" TEXT,
    "payer_reference" TEXT,
    "approved_minor" INTEGER NOT NULL DEFAULT 0,
    "paid_minor" INTEGER NOT NULL DEFAULT 0,
    "denied_minor" INTEGER NOT NULL DEFAULT 0,
    "patient_responsibility_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "adjudication_details" JSONB NOT NULL DEFAULT '[]',
    "denial_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remittance_advice_ref" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "claim_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "location_id" UUID NOT NULL,
    "ward" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "bed_number" TEXT NOT NULL,
    "bed_type" "BedType" NOT NULL DEFAULT 'general',
    "status" "BedStatus" NOT NULL DEFAULT 'available',
    "gender_restriction" "Gender",
    "is_oxygen_supported" BOOLEAN NOT NULL DEFAULT false,
    "is_ventilator_supported" BOOLEAN NOT NULL DEFAULT false,
    "daily_rate_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "current_admission_id" UUID,
    "blocked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "beds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "bed_id" UUID,
    "admission_number" TEXT NOT NULL,
    "admitting_doctor_id" UUID NOT NULL,
    "attending_doctor_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'admitted',
    "admission_type" TEXT NOT NULL DEFAULT 'elective',
    "admission_reason" TEXT,
    "admitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_discharge_at" TIMESTAMPTZ(6),
    "discharged_at" TIMESTAMPTZ(6),
    "discharge_disposition" TEXT,
    "discharge_summary_id" UUID,
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "admission_id" UUID NOT NULL,
    "from_bed_id" UUID,
    "to_bed_id" UUID,
    "from_ward" TEXT,
    "to_ward" TEXT,
    "reason" TEXT NOT NULL,
    "transfer_type" TEXT NOT NULL DEFAULT 'internal',
    "requested_by" UUID NOT NULL,
    "approved_by" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transferred_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "housekeeping_tasks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "bed_id" UUID,
    "location_id" UUID,
    "task_type" TEXT NOT NULL DEFAULT 'terminal-clean',
    "priority" TEXT NOT NULL DEFAULT 'routine',
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "assigned_to" UUID,
    "requested_by" UUID,
    "notes" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "user_id" UUID NOT NULL,
    "employee_number" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "employment_type" TEXT NOT NULL DEFAULT 'full-time',
    "joined_at" DATE NOT NULL,
    "terminated_at" DATE,
    "reports_to_id" UUID,
    "biometric_id" TEXT,
    "contracted_hours_per_week" INTEGER NOT NULL DEFAULT 40,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "break_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_night_shift" BOOLEAN NOT NULL DEFAULT false,
    "min_nurses" INTEGER NOT NULL DEFAULT 0,
    "min_doctors" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "staff_profile_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "location_id" UUID,
    "ward" TEXT,
    "shift_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "clock_in_at" TIMESTAMPTZ(6),
    "clock_out_at" TIMESTAMPTZ(6),
    "clock_in_method" TEXT,
    "assigned_patients" INTEGER NOT NULL DEFAULT 0,
    "swap_requested_with_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "staff_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "staff_profile_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "issuing_authority" TEXT NOT NULL,
    "issued_at" DATE NOT NULL,
    "expires_at" DATE,
    "document_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'valid',
    "last_alert_sent_at" TIMESTAMPTZ(6),
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID,
    "encounter_id" UUID,
    "user_id" UUID NOT NULL,
    "session_type" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "audio_duration_ms" INTEGER,
    "audio_storage_key" TEXT,
    "transcript" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "consent_obtained" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "ai_session_id" UUID,
    "user_id" UUID,
    "patient_id" UUID,
    "operation" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model_version" TEXT NOT NULL,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "confidence_score" DECIMAL(4,3),
    "low_confidence" BOOLEAN NOT NULL DEFAULT false,
    "prompt_hash" TEXT,
    "response_hash" TEXT,
    "prompt_redacted" TEXT,
    "error" TEXT,
    "cost_minor" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "ai_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "ai_session_id" UUID NOT NULL,
    "patient_id" UUID,
    "encounter_id" UUID,
    "draft_type" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "linked_evidence" JSONB NOT NULL DEFAULT '[]',
    "suggested_codes" JSONB NOT NULL DEFAULT '[]',
    "confidence_score" DECIMAL(4,3),
    "model_version" TEXT NOT NULL,
    "requires_approval" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "edit_distance" INTEGER,
    "applied_to_type" TEXT,
    "applied_to_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "ai_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_fhir_id_key" ON "tenants"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "tenants_slug_idx" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_fhir_id_key" ON "users"("fhir_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_is_active_idx" ON "users"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "users_oidc_subject_idx" ON "users"("oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "roles_fhir_id_key" ON "roles"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenant_id_key_key" ON "roles"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_fhir_id_key" ON "permissions"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "user_roles_tenant_id_user_id_idx" ON "user_roles"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_location_id_key" ON "user_roles"("user_id", "role_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_jti_key" ON "sessions"("refresh_token_jti");

-- CreateIndex
CREATE INDEX "sessions_tenant_id_user_id_revoked_at_idx" ON "sessions"("tenant_id", "user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_refresh_expires_at_idx" ON "sessions"("refresh_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_fhir_id_key" ON "audit_logs"("fhir_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_occurred_at_idx" ON "audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_patient_id_occurred_at_idx" ON "audit_logs"("tenant_id", "patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_user_id_occurred_at_idx" ON "audit_logs"("tenant_id", "user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_is_break_glass_idx" ON "audit_logs"("tenant_id", "is_break_glass");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_fhir_id_key" ON "organizations"("fhir_id");

-- CreateIndex
CREATE INDEX "organizations_tenant_id_type_idx" ON "organizations"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "locations_fhir_id_key" ON "locations"("fhir_id");

-- CreateIndex
CREATE INDEX "locations_tenant_id_organization_id_idx" ON "locations"("tenant_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "practitioners_fhir_id_key" ON "practitioners"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "practitioners_user_id_key" ON "practitioners"("user_id");

-- CreateIndex
CREATE INDEX "practitioners_tenant_id_is_active_idx" ON "practitioners"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "practitioners_tenant_id_license_number_key" ON "practitioners"("tenant_id", "license_number");

-- CreateIndex
CREATE UNIQUE INDEX "practitioner_roles_fhir_id_key" ON "practitioner_roles"("fhir_id");

-- CreateIndex
CREATE INDEX "practitioner_roles_tenant_id_practitioner_id_idx" ON "practitioner_roles"("tenant_id", "practitioner_id");

-- CreateIndex
CREATE UNIQUE INDEX "patients_fhir_id_key" ON "patients"("fhir_id");

-- CreateIndex
CREATE INDEX "patients_tenant_id_family_name_birth_date_idx" ON "patients"("tenant_id", "family_name", "birth_date");

-- CreateIndex
CREATE INDEX "patients_tenant_id_name_search_idx" ON "patients"("tenant_id", "name_search");

-- CreateIndex
CREATE INDEX "patients_tenant_id_deleted_at_idx" ON "patients"("tenant_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenant_id_mrn_key" ON "patients"("tenant_id", "mrn");

-- CreateIndex
CREATE UNIQUE INDEX "patient_identifiers_fhir_id_key" ON "patient_identifiers"("fhir_id");

-- CreateIndex
CREATE INDEX "patient_identifiers_tenant_id_patient_id_idx" ON "patient_identifiers"("tenant_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_identifiers_tenant_id_type_value_normalized_key" ON "patient_identifiers"("tenant_id", "type", "value_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "patient_contacts_fhir_id_key" ON "patient_contacts"("fhir_id");

-- CreateIndex
CREATE INDEX "patient_contacts_tenant_id_patient_id_idx" ON "patient_contacts"("tenant_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_contacts_tenant_id_value_idx" ON "patient_contacts"("tenant_id", "value");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_fhir_id_key" ON "schedules"("fhir_id");

-- CreateIndex
CREATE INDEX "schedules_tenant_id_practitioner_id_planning_start_idx" ON "schedules"("tenant_id", "practitioner_id", "planning_start");

-- CreateIndex
CREATE UNIQUE INDEX "slots_fhir_id_key" ON "slots"("fhir_id");

-- CreateIndex
CREATE INDEX "slots_tenant_id_start_status_idx" ON "slots"("tenant_id", "start", "status");

-- CreateIndex
CREATE UNIQUE INDEX "slots_schedule_id_start_key" ON "slots"("schedule_id", "start");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_fhir_id_key" ON "appointments"("fhir_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_start_status_idx" ON "appointments"("tenant_id", "start", "status");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_patient_id_start_idx" ON "appointments"("tenant_id", "patient_id", "start");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_practitioner_id_start_idx" ON "appointments"("tenant_id", "practitioner_id", "start");

-- CreateIndex
CREATE UNIQUE INDEX "queues_fhir_id_key" ON "queues"("fhir_id");

-- CreateIndex
CREATE INDEX "queues_tenant_id_queue_name_status_sequence_idx" ON "queues"("tenant_id", "queue_name", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "queues_tenant_id_queue_name_queue_date_token_key" ON "queues"("tenant_id", "queue_name", "queue_date", "token");

-- CreateIndex
CREATE UNIQUE INDEX "encounters_fhir_id_key" ON "encounters"("fhir_id");

-- CreateIndex
CREATE INDEX "encounters_tenant_id_patient_id_period_start_idx" ON "encounters"("tenant_id", "patient_id", "period_start");

-- CreateIndex
CREATE INDEX "encounters_tenant_id_status_period_start_idx" ON "encounters"("tenant_id", "status", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "conditions_fhir_id_key" ON "conditions"("fhir_id");

-- CreateIndex
CREATE INDEX "conditions_tenant_id_patient_id_category_idx" ON "conditions"("tenant_id", "patient_id", "category");

-- CreateIndex
CREATE INDEX "conditions_tenant_id_code_idx" ON "conditions"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "clinical_notes_fhir_id_key" ON "clinical_notes"("fhir_id");

-- CreateIndex
CREATE INDEX "clinical_notes_tenant_id_encounter_id_type_idx" ON "clinical_notes"("tenant_id", "encounter_id", "type");

-- CreateIndex
CREATE INDEX "clinical_notes_tenant_id_patient_id_created_at_idx" ON "clinical_notes"("tenant_id", "patient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "care_plans_fhir_id_key" ON "care_plans"("fhir_id");

-- CreateIndex
CREATE INDEX "care_plans_tenant_id_patient_id_status_idx" ON "care_plans"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "allergies_fhir_id_key" ON "allergies"("fhir_id");

-- CreateIndex
CREATE INDEX "allergies_tenant_id_patient_id_clinical_status_idx" ON "allergies"("tenant_id", "patient_id", "clinical_status");

-- CreateIndex
CREATE INDEX "allergies_tenant_id_substance_rxnorm_idx" ON "allergies"("tenant_id", "substance_rxnorm");

-- CreateIndex
CREATE UNIQUE INDEX "vitals_fhir_id_key" ON "vitals"("fhir_id");

-- CreateIndex
CREATE INDEX "vitals_tenant_id_patient_id_recorded_at_idx" ON "vitals"("tenant_id", "patient_id", "recorded_at");

-- CreateIndex
CREATE INDEX "vitals_tenant_id_ews_risk_recorded_at_idx" ON "vitals"("tenant_id", "ews_risk", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "drug_formulary_fhir_id_key" ON "drug_formulary"("fhir_id");

-- CreateIndex
CREATE INDEX "drug_formulary_tenant_id_generic_name_idx" ON "drug_formulary"("tenant_id", "generic_name");

-- CreateIndex
CREATE INDEX "drug_formulary_tenant_id_rxnorm_code_idx" ON "drug_formulary"("tenant_id", "rxnorm_code");

-- CreateIndex
CREATE UNIQUE INDEX "drug_interactions_fhir_id_key" ON "drug_interactions"("fhir_id");

-- CreateIndex
CREATE INDEX "drug_interactions_rxnorm_a_idx" ON "drug_interactions"("rxnorm_a");

-- CreateIndex
CREATE INDEX "drug_interactions_rxnorm_b_idx" ON "drug_interactions"("rxnorm_b");

-- CreateIndex
CREATE UNIQUE INDEX "drug_interactions_rxnorm_a_rxnorm_b_key" ON "drug_interactions"("rxnorm_a", "rxnorm_b");

-- CreateIndex
CREATE UNIQUE INDEX "medications_fhir_id_key" ON "medications"("fhir_id");

-- CreateIndex
CREATE INDEX "medications_tenant_id_patient_id_status_idx" ON "medications"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "medications_tenant_id_encounter_id_idx" ON "medications"("tenant_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "medication_dispenses_fhir_id_key" ON "medication_dispenses"("fhir_id");

-- CreateIndex
CREATE INDEX "medication_dispenses_tenant_id_patient_id_dispensed_at_idx" ON "medication_dispenses"("tenant_id", "patient_id", "dispensed_at");

-- CreateIndex
CREATE UNIQUE INDEX "medication_administrations_fhir_id_key" ON "medication_administrations"("fhir_id");

-- CreateIndex
CREATE INDEX "medication_administrations_tenant_id_patient_id_administere_idx" ON "medication_administrations"("tenant_id", "patient_id", "administered_at");

-- CreateIndex
CREATE INDEX "medication_administrations_tenant_id_scheduled_at_status_idx" ON "medication_administrations"("tenant_id", "scheduled_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "controlled_drug_register_fhir_id_key" ON "controlled_drug_register"("fhir_id");

-- CreateIndex
CREATE INDEX "controlled_drug_register_tenant_id_occurred_at_idx" ON "controlled_drug_register"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "controlled_drug_register_tenant_id_schedule_occurred_at_idx" ON "controlled_drug_register"("tenant_id", "schedule", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_fhir_id_key" ON "service_requests"("fhir_id");

-- CreateIndex
CREATE INDEX "service_requests_tenant_id_category_status_idx" ON "service_requests"("tenant_id", "category", "status");

-- CreateIndex
CREATE INDEX "service_requests_tenant_id_patient_id_created_at_idx" ON "service_requests"("tenant_id", "patient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_requests_tenant_id_order_number_key" ON "service_requests"("tenant_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "lab_specimens_fhir_id_key" ON "lab_specimens"("fhir_id");

-- CreateIndex
CREATE INDEX "lab_specimens_tenant_id_barcode_idx" ON "lab_specimens"("tenant_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "lab_specimens_tenant_id_accession_number_key" ON "lab_specimens"("tenant_id", "accession_number");

-- CreateIndex
CREATE UNIQUE INDEX "lab_results_fhir_id_key" ON "lab_results"("fhir_id");

-- CreateIndex
CREATE INDEX "lab_results_tenant_id_patient_id_performed_at_idx" ON "lab_results"("tenant_id", "patient_id", "performed_at");

-- CreateIndex
CREATE INDEX "lab_results_tenant_id_is_critical_critical_notified_at_idx" ON "lab_results"("tenant_id", "is_critical", "critical_notified_at");

-- CreateIndex
CREATE INDEX "lab_results_tenant_id_loinc_code_idx" ON "lab_results"("tenant_id", "loinc_code");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_studies_fhir_id_key" ON "imaging_studies"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_studies_study_instance_uid_key" ON "imaging_studies"("study_instance_uid");

-- CreateIndex
CREATE INDEX "imaging_studies_tenant_id_patient_id_started_at_idx" ON "imaging_studies"("tenant_id", "patient_id", "started_at");

-- CreateIndex
CREATE INDEX "imaging_studies_tenant_id_modality_status_idx" ON "imaging_studies"("tenant_id", "modality", "status");

-- CreateIndex
CREATE UNIQUE INDEX "radiology_reports_fhir_id_key" ON "radiology_reports"("fhir_id");

-- CreateIndex
CREATE INDEX "radiology_reports_tenant_id_imaging_study_id_idx" ON "radiology_reports"("tenant_id", "imaging_study_id");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_items_fhir_id_key" ON "pharmacy_items"("fhir_id");

-- CreateIndex
CREATE INDEX "pharmacy_items_tenant_id_expiry_date_quantity_on_hand_idx" ON "pharmacy_items"("tenant_id", "expiry_date", "quantity_on_hand");

-- CreateIndex
CREATE INDEX "pharmacy_items_tenant_id_gtin_idx" ON "pharmacy_items"("tenant_id", "gtin");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_items_tenant_id_item_code_batch_number_key" ON "pharmacy_items"("tenant_id", "item_code", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_fhir_id_key" ON "inventory_items"("fhir_id");

-- CreateIndex
CREATE INDEX "inventory_items_tenant_id_quantity_on_hand_safety_stock_idx" ON "inventory_items"("tenant_id", "quantity_on_hand", "safety_stock");

-- CreateIndex
CREATE INDEX "inventory_items_tenant_id_udi_idx" ON "inventory_items"("tenant_id", "udi");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_tenant_id_item_code_batch_number_key" ON "inventory_items"("tenant_id", "item_code", "batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "cold_chain_events_fhir_id_key" ON "cold_chain_events"("fhir_id");

-- CreateIndex
CREATE INDEX "cold_chain_events_tenant_id_recorded_at_idx" ON "cold_chain_events"("tenant_id", "recorded_at");

-- CreateIndex
CREATE INDEX "cold_chain_events_tenant_id_is_excursion_recorded_at_idx" ON "cold_chain_events"("tenant_id", "is_excursion", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "charge_master_fhir_id_key" ON "charge_master"("fhir_id");

-- CreateIndex
CREATE INDEX "charge_master_tenant_id_category_is_active_idx" ON "charge_master"("tenant_id", "category", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "charge_master_tenant_id_charge_code_key" ON "charge_master"("tenant_id", "charge_code");

-- CreateIndex
CREATE UNIQUE INDEX "payers_fhir_id_key" ON "payers"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "payers_tenant_id_code_key" ON "payers"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "coverages_fhir_id_key" ON "coverages"("fhir_id");

-- CreateIndex
CREATE INDEX "coverages_tenant_id_patient_id_status_idx" ON "coverages"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_fhir_id_key" ON "invoices"("fhir_id");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_patient_id_status_idx" ON "invoices"("tenant_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "invoices_tenant_id_status_due_at_idx" ON "invoices"("tenant_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_tenant_id_invoice_number_key" ON "invoices"("tenant_id", "invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_items_fhir_id_key" ON "invoice_line_items"("fhir_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_tenant_id_invoice_id_idx" ON "invoice_line_items"("tenant_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_fhir_id_key" ON "payments"("fhir_id");

-- CreateIndex
CREATE INDEX "payments_tenant_id_patient_id_received_at_idx" ON "payments"("tenant_id", "patient_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_receipt_number_key" ON "payments"("tenant_id", "receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "pre_authorizations_fhir_id_key" ON "pre_authorizations"("fhir_id");

-- CreateIndex
CREATE INDEX "pre_authorizations_tenant_id_status_requested_at_idx" ON "pre_authorizations"("tenant_id", "status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "pre_authorizations_tenant_id_reference_number_key" ON "pre_authorizations"("tenant_id", "reference_number");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claims_fhir_id_key" ON "insurance_claims"("fhir_id");

-- CreateIndex
CREATE INDEX "insurance_claims_tenant_id_status_submitted_at_idx" ON "insurance_claims"("tenant_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "insurance_claims_tenant_id_payer_id_status_idx" ON "insurance_claims"("tenant_id", "payer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claims_tenant_id_claim_number_key" ON "insurance_claims"("tenant_id", "claim_number");

-- CreateIndex
CREATE UNIQUE INDEX "claim_responses_fhir_id_key" ON "claim_responses"("fhir_id");

-- CreateIndex
CREATE INDEX "claim_responses_tenant_id_claim_id_received_at_idx" ON "claim_responses"("tenant_id", "claim_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "beds_fhir_id_key" ON "beds"("fhir_id");

-- CreateIndex
CREATE INDEX "beds_tenant_id_status_bed_type_idx" ON "beds"("tenant_id", "status", "bed_type");

-- CreateIndex
CREATE UNIQUE INDEX "beds_tenant_id_ward_room_bed_number_key" ON "beds"("tenant_id", "ward", "room", "bed_number");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_fhir_id_key" ON "admissions"("fhir_id");

-- CreateIndex
CREATE INDEX "admissions_tenant_id_status_admitted_at_idx" ON "admissions"("tenant_id", "status", "admitted_at");

-- CreateIndex
CREATE INDEX "admissions_tenant_id_patient_id_idx" ON "admissions"("tenant_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_tenant_id_admission_number_key" ON "admissions"("tenant_id", "admission_number");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_fhir_id_key" ON "transfers"("fhir_id");

-- CreateIndex
CREATE INDEX "transfers_tenant_id_admission_id_idx" ON "transfers"("tenant_id", "admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "housekeeping_tasks_fhir_id_key" ON "housekeeping_tasks"("fhir_id");

-- CreateIndex
CREATE INDEX "housekeeping_tasks_tenant_id_status_priority_idx" ON "housekeeping_tasks"("tenant_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_fhir_id_key" ON "staff_profiles"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id");

-- CreateIndex
CREATE INDEX "staff_profiles_tenant_id_department_idx" ON "staff_profiles"("tenant_id", "department");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_tenant_id_employee_number_key" ON "staff_profiles"("tenant_id", "employee_number");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_fhir_id_key" ON "shifts"("fhir_id");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_tenant_id_code_key" ON "shifts"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_schedules_fhir_id_key" ON "staff_schedules"("fhir_id");

-- CreateIndex
CREATE INDEX "staff_schedules_tenant_id_shift_date_ward_idx" ON "staff_schedules"("tenant_id", "shift_date", "ward");

-- CreateIndex
CREATE UNIQUE INDEX "staff_schedules_staff_profile_id_shift_date_shift_id_key" ON "staff_schedules"("staff_profile_id", "shift_date", "shift_id");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_fhir_id_key" ON "credentials"("fhir_id");

-- CreateIndex
CREATE INDEX "credentials_tenant_id_expires_at_status_idx" ON "credentials"("tenant_id", "expires_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_sessions_fhir_id_key" ON "ai_sessions"("fhir_id");

-- CreateIndex
CREATE INDEX "ai_sessions_tenant_id_user_id_started_at_idx" ON "ai_sessions"("tenant_id", "user_id", "started_at");

-- CreateIndex
CREATE INDEX "ai_sessions_tenant_id_patient_id_idx" ON "ai_sessions"("tenant_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_audit_logs_fhir_id_key" ON "ai_audit_logs"("fhir_id");

-- CreateIndex
CREATE INDEX "ai_audit_logs_tenant_id_occurred_at_idx" ON "ai_audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ai_audit_logs_tenant_id_operation_low_confidence_idx" ON "ai_audit_logs"("tenant_id", "operation", "low_confidence");

-- CreateIndex
CREATE UNIQUE INDEX "ai_drafts_fhir_id_key" ON "ai_drafts"("fhir_id");

-- CreateIndex
CREATE INDEX "ai_drafts_tenant_id_status_created_at_idx" ON "ai_drafts"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_drafts_tenant_id_encounter_id_idx" ON "ai_drafts"("tenant_id", "encounter_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioners" ADD CONSTRAINT "practitioners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practitioner_roles" ADD CONSTRAINT "practitioner_roles_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_identifiers" ADD CONSTRAINT "patient_identifiers_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_contacts" ADD CONSTRAINT "patient_contacts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slots" ADD CONSTRAINT "slots_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_practitioner_id_fkey" FOREIGN KEY ("practitioner_id") REFERENCES "practitioners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conditions" ADD CONSTRAINT "conditions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_notes" ADD CONSTRAINT "clinical_notes_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "clinical_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_plans" ADD CONSTRAINT "care_plans_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_formulary" ADD CONSTRAINT "drug_formulary_generic_of_id_fkey" FOREIGN KEY ("generic_of_id") REFERENCES "drug_formulary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_prescriber_id_fkey" FOREIGN KEY ("prescriber_id") REFERENCES "practitioners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_drug_formulary_id_fkey" FOREIGN KEY ("drug_formulary_id") REFERENCES "drug_formulary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_dispenses" ADD CONSTRAINT "medication_dispenses_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "controlled_drug_register" ADD CONSTRAINT "controlled_drug_register_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_specimens" ADD CONSTRAINT "lab_specimens_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_specimens" ADD CONSTRAINT "lab_specimens_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_specimen_id_fkey" FOREIGN KEY ("specimen_id") REFERENCES "lab_specimens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_studies" ADD CONSTRAINT "imaging_studies_service_request_id_fkey" FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "radiology_reports" ADD CONSTRAINT "radiology_reports_imaging_study_id_fkey" FOREIGN KEY ("imaging_study_id") REFERENCES "imaging_studies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_items" ADD CONSTRAINT "pharmacy_items_drug_formulary_id_fkey" FOREIGN KEY ("drug_formulary_id") REFERENCES "drug_formulary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cold_chain_events" ADD CONSTRAINT "cold_chain_events_pharmacy_item_id_fkey" FOREIGN KEY ("pharmacy_item_id") REFERENCES "pharmacy_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cold_chain_events" ADD CONSTRAINT "cold_chain_events_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverages" ADD CONSTRAINT "coverages_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_coverage_id_fkey" FOREIGN KEY ("coverage_id") REFERENCES "coverages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_charge_master_id_fkey" FOREIGN KEY ("charge_master_id") REFERENCES "charge_master"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_coverage_id_fkey" FOREIGN KEY ("coverage_id") REFERENCES "coverages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorizations" ADD CONSTRAINT "pre_authorizations_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_coverage_id_fkey" FOREIGN KEY ("coverage_id") REFERENCES "coverages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_pre_authorization_id_fkey" FOREIGN KEY ("pre_authorization_id") REFERENCES "pre_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_responses" ADD CONSTRAINT "claim_responses_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_bed_id_fkey" FOREIGN KEY ("from_bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_bed_id_fkey" FOREIGN KEY ("to_bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "housekeeping_tasks" ADD CONSTRAINT "housekeeping_tasks_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_reports_to_id_fkey" FOREIGN KEY ("reports_to_id") REFERENCES "staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_audit_logs" ADD CONSTRAINT "ai_audit_logs_ai_session_id_fkey" FOREIGN KEY ("ai_session_id") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_drafts" ADD CONSTRAINT "ai_drafts_ai_session_id_fkey" FOREIGN KEY ("ai_session_id") REFERENCES "ai_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

