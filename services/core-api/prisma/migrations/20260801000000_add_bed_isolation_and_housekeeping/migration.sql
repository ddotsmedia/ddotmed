-- Bed management and ADT. Additive only: nothing is dropped, altered or renamed.

-- Postgres has no CREATE TYPE IF NOT EXISTS, so the guard is explicit.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HousekeepingStatus') THEN
    CREATE TYPE "HousekeepingStatus" AS ENUM ('clean', 'dirty', 'in_progress');
  END IF;
END
$$;

-- Cleaning state is tracked apart from occupancy: a bed can be occupied and dirty,
-- and an empty bed is not usable until someone has signed it off. Existing rows
-- default to clean, which is how they behave today.
ALTER TABLE "beds" ADD COLUMN IF NOT EXISTS "housekeeping_status" "HousekeepingStatus" NOT NULL DEFAULT 'clean';

-- Isolation precautions. A flag rather than a bed_type because the same bay moves
-- in and out of precautions as patients change.
ALTER TABLE "beds" ADD COLUMN IF NOT EXISTS "isolation_flag" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "beds" ADD COLUMN IF NOT EXISTS "isolation_reason" TEXT;

-- The ward as a Location row, for sites that model wards that way. Deliberately
-- left without a foreign key: the column is nullable and unpopulated, and adding a
-- constraint here would couple this migration to Location seeding order. The
-- existing `ward` text column stays authoritative for display and for the unique key.
ALTER TABLE "beds" ADD COLUMN IF NOT EXISTS "ward_id" UUID;

-- The bed board reads by location and status.
CREATE INDEX IF NOT EXISTS "beds_tenant_id_location_id_status_idx"
  ON "beds" ("tenant_id", "location_id", "status");
CREATE INDEX IF NOT EXISTS "beds_tenant_id_ward_id_status_idx"
  ON "beds" ("tenant_id", "ward_id", "status");

-- "Is this patient currently admitted" is asked on every chart open.
CREATE INDEX IF NOT EXISTS "admissions_tenant_id_patient_id_status_idx"
  ON "admissions" ("tenant_id", "patient_id", "status");
