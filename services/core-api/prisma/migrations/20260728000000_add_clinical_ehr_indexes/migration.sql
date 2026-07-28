-- Clinical EHR: additive indexes only. Safe to re-run.

-- The chart opens by patient and filters to the open encounter; without this the
-- planner falls back to the (tenant_id, patient_id, period_start) index and then
-- filters status in memory.
CREATE INDEX IF NOT EXISTS "encounters_tenant_id_patient_id_status_idx"
  ON "encounters" ("tenant_id", "patient_id", "status");

-- The SOAP editor loads one note type at a time for a single encounter.
CREATE INDEX IF NOT EXISTS "clinical_notes_encounter_id_type_idx"
  ON "clinical_notes" ("encounter_id", "type");
