-- Pharmacy dispensing and inventory. Additive only: nothing is dropped or altered.

-- Column naming note: pharmacy_items has no `drug_code` or `status` column. The
-- drug is identified by `drug_formulary_id` (with `item_code` already covered by
-- the unique on (tenant_id, item_code, batch_number)), and a batch's usability is
-- decided by expiry, recall and on-hand quantity rather than by a status field.
-- These are the indexes the FEFO pick actually walks.

-- Picking stock for one drug, first-expiring first.
CREATE INDEX IF NOT EXISTS "pharmacy_items_tenant_id_drug_formulary_id_expiry_date_idx"
  ON "pharmacy_items" ("tenant_id", "drug_formulary_id", "expiry_date");

-- Picking within one dispensing location.
CREATE INDEX IF NOT EXISTS "pharmacy_items_tenant_id_location_id_expiry_date_idx"
  ON "pharmacy_items" ("tenant_id", "location_id", "expiry_date");

-- The expiry sweep and the stock list, both scoped to a store room.
-- The column is `expiry_date`; there is no `expires_at`.
CREATE INDEX IF NOT EXISTS "inventory_items_tenant_id_location_id_expiry_date_idx"
  ON "inventory_items" ("tenant_id", "location_id", "expiry_date");

-- Reorder thresholds for pharmacy stock. Nullable-free with a zero default, which
-- means "no alert" — so existing rows keep behaving exactly as they do today.
ALTER TABLE "pharmacy_items" ADD COLUMN IF NOT EXISTS "reorder_level" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "pharmacy_items" ADD COLUMN IF NOT EXISTS "reorder_quantity" INTEGER NOT NULL DEFAULT 0;
