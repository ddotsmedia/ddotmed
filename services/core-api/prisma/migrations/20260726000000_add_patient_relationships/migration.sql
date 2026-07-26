-- Additive only: creates one new table. No existing table, column or constraint
-- is altered or dropped, so this is safe to apply to a populated database.

-- CreateTable
CREATE TABLE "patient_relationships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fhir_id" UUID,
    "patient_id" UUID NOT NULL,
    "related_patient_id" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "is_primary_record" BOOLEAN NOT NULL DEFAULT true,
    "is_biological" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency_contact" BOOLEAN NOT NULL DEFAULT false,
    "is_guarantor" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "recorded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "patient_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_relationships_fhir_id_key" ON "patient_relationships"("fhir_id");

-- CreateIndex
CREATE INDEX "patient_relationships_tenant_id_patient_id_idx" ON "patient_relationships"("tenant_id", "patient_id");

-- CreateIndex
CREATE INDEX "patient_relationships_tenant_id_related_patient_id_idx" ON "patient_relationships"("tenant_id", "related_patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_relationships_patient_id_related_patient_id_relations_key" ON "patient_relationships"("patient_id", "related_patient_id", "relationship");

-- AddForeignKey
ALTER TABLE "patient_relationships" ADD CONSTRAINT "patient_relationships_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_relationships" ADD CONSTRAINT "patient_relationships_related_patient_id_fkey" FOREIGN KEY ("related_patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
