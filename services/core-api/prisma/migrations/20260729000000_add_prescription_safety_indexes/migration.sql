-- E-prescription safety. Additive only: nothing is dropped, altered or renamed.

-- The active prescription list is read on every prescribing screen and on every
-- interaction check. Created by the initial migration; repeated here so a database
-- built before that index existed still gets it.
CREATE INDEX IF NOT EXISTS "medications_tenant_id_patient_id_status_idx"
  ON "medications" ("tenant_id", "patient_id", "status");

-- Pair lookup runs in both directions. The unique constraint on (rxnorm_a, rxnorm_b)
-- already serves one; this serves the other, so neither direction falls back to a scan.
-- The columns are named rxnorm_a / rxnorm_b — they hold the RxNorm ingredient codes
-- for the two drugs in the pair.
CREATE INDEX IF NOT EXISTS "drug_interactions_rxnorm_b_rxnorm_a_idx"
  ON "drug_interactions" ("rxnorm_b", "rxnorm_a");

-- Drug search autocomplete, by generic name and by brand.
CREATE INDEX IF NOT EXISTS "drug_formulary_tenant_id_brand_name_idx"
  ON "drug_formulary" ("tenant_id", "brand_name");
CREATE INDEX IF NOT EXISTS "drug_formulary_generic_name_trgm_idx"
  ON "drug_formulary" USING gin ("generic_name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "drug_formulary_brand_name_trgm_idx"
  ON "drug_formulary" USING gin ("brand_name" gin_trgm_ops);

-- Cache for the plain-English interaction wording. Nullable columns added to an
-- existing table: no default backfill, no rewrite, no lock beyond the catalogue update.
ALTER TABLE "drug_interactions" ADD COLUMN IF NOT EXISTS "plain_explanation" TEXT;
ALTER TABLE "drug_interactions" ADD COLUMN IF NOT EXISTS "explanation_model" TEXT;
ALTER TABLE "drug_interactions" ADD COLUMN IF NOT EXISTS "explanation_written_at" TIMESTAMPTZ(6);
