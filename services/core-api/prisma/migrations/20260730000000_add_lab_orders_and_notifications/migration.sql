-- Lab orders, results and the critical-value inbox. Additive only.

-- The lab tab lists a patient's orders filtered by status; without this the
-- planner uses (tenant_id, patient_id, created_at) and filters status in memory.
CREATE INDEX IF NOT EXISTS "service_requests_tenant_id_patient_id_status_idx"
  ON "service_requests" ("tenant_id", "patient_id", "status");

-- Critical results for one order. The column is named is_critical — it is the
-- boolean critical flag set when a value crosses its critical threshold.
CREATE INDEX IF NOT EXISTS "lab_results_service_request_id_is_critical_idx"
  ON "lab_results" ("service_request_id", "is_critical");

-- Trend lookup: the last N values of one test for one patient, newest first.
CREATE INDEX IF NOT EXISTS "lab_results_tenant_patient_loinc_performed_idx"
  ON "lab_results" ("tenant_id", "patient_id", "loinc_code", "performed_at");

-- In-app notification inbox. New table, so nothing existing is touched.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"            UUID PRIMARY KEY,
  "tenant_id"     UUID NOT NULL,
  "user_id"       UUID,
  "role"          TEXT,
  "category"      TEXT NOT NULL,
  "severity"      TEXT NOT NULL DEFAULT 'info',
  "title"         TEXT NOT NULL,
  "body"          TEXT NOT NULL,
  "patient_id"    UUID,
  "encounter_id"  UUID,
  "resource_type" TEXT,
  "resource_id"   UUID,
  "dedupe_key"    TEXT,
  "requires_acknowledgement" BOOLEAN NOT NULL DEFAULT false,
  "acknowledged_at" TIMESTAMPTZ(6),
  "acknowledged_by" UUID,
  "read_at"       TIMESTAMPTZ(6),
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"    TIMESTAMPTZ(6),
  "deleted_reason" TEXT
);

-- One row per clinical fact per tenant. Postgres treats NULLs as distinct, so a
-- notification with no dedupe key is never collapsed against another.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_tenant_id_dedupe_key_key"
  ON "notifications" ("tenant_id", "dedupe_key");

-- The inbox query: unacknowledged first, by recipient.
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_user_id_acknowledged_at_idx"
  ON "notifications" ("tenant_id", "user_id", "acknowledged_at");
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_role_acknowledged_at_idx"
  ON "notifications" ("tenant_id", "role", "acknowledged_at");
CREATE INDEX IF NOT EXISTS "notifications_tenant_id_category_created_at_idx"
  ON "notifications" ("tenant_id", "category", "created_at");
