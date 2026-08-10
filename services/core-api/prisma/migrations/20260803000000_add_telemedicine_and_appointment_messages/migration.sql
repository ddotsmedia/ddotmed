-- Telemedicine: video rooms, session records and the async message thread.
-- Additive only. Every statement is IF NOT EXISTS or guarded, so a database that
-- already carries these objects is left exactly as it is and nothing is dropped.

-- ── appointment: where the video call lives ──────────────────────────────────
-- `telehealth_url` already exists and stays as the patient-facing link the portal
-- has always shown. The three columns below carry the provider's own identifiers
-- so a room can be re-joined, re-issued a token, or reconciled with the provider.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "teleconsult_url" VARCHAR(2048);
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "teleconsult_room_id" VARCHAR(255);
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "teleconsult_provider" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "appointments_tenant_id_teleconsult_room_id_idx"
  ON "appointments" ("tenant_id", "teleconsult_room_id");

-- ── teleconsult_sessions ─────────────────────────────────────────────────────
-- One row per joined call, not per appointment: a dropped connection produces a
-- second session, and the billed minutes are the sum, not the wall clock between
-- the first join and the last hang-up.
CREATE TABLE IF NOT EXISTS "teleconsult_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "room_id" VARCHAR(255) NOT NULL,
    "provider" VARCHAR(64) NOT NULL DEFAULT 'mock',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "recording_url" VARCHAR(2048),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teleconsult_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "teleconsult_sessions_tenant_id_appointment_id_idx"
  ON "teleconsult_sessions" ("tenant_id", "appointment_id");
CREATE INDEX IF NOT EXISTS "teleconsult_sessions_tenant_id_started_at_idx"
  ON "teleconsult_sessions" ("tenant_id", "started_at");

-- ── appointment_messages ─────────────────────────────────────────────────────
-- The asynchronous half of a teleconsultation: what is said between the booking
-- and the call, and afterwards. Scoped to an appointment rather than to a patient
-- so a thread cannot outlive the episode of care it belongs to.
CREATE TABLE IF NOT EXISTS "appointment_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "sender_user_id" UUID,
    "sender_role" VARCHAR(32) NOT NULL,
    "body" TEXT,
    "attachment_url" VARCHAR(2048),
    "attachment_name" VARCHAR(255),
    "attachment_content_type" VARCHAR(255),
    "attachment_size_bytes" INTEGER,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "appointment_messages_pkey" PRIMARY KEY ("id")
);

-- The thread is always read oldest-last for one appointment; this is that read.
CREATE INDEX IF NOT EXISTS "appointment_messages_tenant_id_appointment_id_created_at_idx"
  ON "appointment_messages" ("tenant_id", "appointment_id", "created_at");
-- Unread counts per thread.
CREATE INDEX IF NOT EXISTS "appointment_messages_tenant_id_read_at_idx"
  ON "appointment_messages" ("tenant_id", "read_at");

-- ── foreign keys ─────────────────────────────────────────────────────────────
-- Added separately and guarded: ALTER TABLE ... ADD CONSTRAINT has no IF NOT
-- EXISTS form, so re-running this migration would otherwise fail on the second
-- pass rather than being the no-op it is meant to be.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teleconsult_sessions_appointment_id_fkey'
  ) THEN
    ALTER TABLE "teleconsult_sessions"
      ADD CONSTRAINT "teleconsult_sessions_appointment_id_fkey"
      FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointment_messages_appointment_id_fkey'
  ) THEN
    ALTER TABLE "appointment_messages"
      ADD CONSTRAINT "appointment_messages_appointment_id_fkey"
      FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
