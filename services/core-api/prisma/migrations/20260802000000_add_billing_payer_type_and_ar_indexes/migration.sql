-- Billing, claims and the RCM dashboard. Additive only.

-- Column naming note: charge_master identifies a charge by `charge_code`, and that
-- is already covered by the unique on (tenant_id, charge_code) — the requested
-- (tenant_id, code) index would be a duplicate of it. The three statements below
-- are the requested indexes under their real column names, so a database built
-- before them still gets them; on a current database they are no-ops.
CREATE INDEX IF NOT EXISTS "invoices_tenant_id_patient_id_status_idx"
  ON "invoices" ("tenant_id", "patient_id", "status");
CREATE INDEX IF NOT EXISTS "insurance_claims_tenant_id_payer_id_status_idx"
  ON "insurance_claims" ("tenant_id", "payer_id", "status");
CREATE INDEX IF NOT EXISTS "charge_master_tenant_id_charge_code_idx"
  ON "charge_master" ("tenant_id", "charge_code");

-- Who settles the invoice. Defaults to cash, so every existing row keeps the
-- behaviour it has today and nothing needs backfilling.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayerType') THEN
    CREATE TYPE "PayerType" AS ENUM ('cash', 'insurance', 'corporate');
  END IF;
END
$$;

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "payer_type" "PayerType" NOT NULL DEFAULT 'cash';

-- AR aging buckets scan unpaid invoices by the date they were issued.
CREATE INDEX IF NOT EXISTS "invoices_tenant_id_status_issued_at_idx"
  ON "invoices" ("tenant_id", "status", "issued_at");
CREATE INDEX IF NOT EXISTS "invoices_tenant_id_payer_type_status_idx"
  ON "invoices" ("tenant_id", "payer_type", "status");

-- Collection rate month-to-date sums receipts by date, across all patients.
CREATE INDEX IF NOT EXISTS "payments_tenant_id_received_at_idx"
  ON "payments" ("tenant_id", "received_at");

-- Denial rate month-to-date counts responses by outcome.
CREATE INDEX IF NOT EXISTS "claim_responses_tenant_id_outcome_received_at_idx"
  ON "claim_responses" ("tenant_id", "outcome", "received_at");
