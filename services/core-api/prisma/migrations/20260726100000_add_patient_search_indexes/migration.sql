-- Additive only: creates indexes and an extension. Nothing is altered or dropped,
-- and every statement is IF NOT EXISTS, so this is safe to re-apply.

-- Instant search matches names by substring. A btree index cannot serve
-- LIKE '%x%', so trigram matching is what keeps this off a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: Prisma does not model GIN/trigram indexes, so this one is intentionally
-- unmanaged. `prisma migrate dev` will report it as drift; do not "fix" that by
-- dropping it or name search degrades to a full table scan per keystroke.
CREATE INDEX IF NOT EXISTS "patients_name_search_trgm_idx"
    ON "patients" USING gin ("name_search" gin_trgm_ops);

-- Insurance member ID is a first-class search key at the front desk; coverages
-- previously had no index that could serve it.
CREATE INDEX IF NOT EXISTS "coverages_tenant_id_member_id_idx"
    ON "coverages" ("tenant_id", "member_id");

-- The existing unique is (tenant_id, type, value_normalized). A search that knows
-- the number but not which kind of document it came from cannot use that prefix.
CREATE INDEX IF NOT EXISTS "patient_identifiers_tenant_id_value_normalized_idx"
    ON "patient_identifiers" ("tenant_id", "value_normalized");

-- Timeline queries read each clinical domain by (patient, time) and merge.
CREATE INDEX IF NOT EXISTS "clinical_notes_tenant_id_patient_id_created_at_idx"
    ON "clinical_notes" ("tenant_id", "patient_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "imaging_studies_tenant_id_patient_id_created_at_idx"
    ON "imaging_studies" ("tenant_id", "patient_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "medications_tenant_id_patient_id_created_at_idx"
    ON "medications" ("tenant_id", "patient_id", "created_at" DESC);
