-- Additive only: new enum value and new indexes. Nothing is altered or dropped.

-- Walk-ins are a distinct lifecycle from a booked appointment: no slot, a queue
-- token instead of a start time, and they must not be counted as no-shows.
-- ADD VALUE is additive; IF NOT EXISTS makes it safe to re-apply.
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'walk_in';

-- Day-view and patient-history reads. The existing composite starts with
-- (tenant_id, start, status); these serve the queries that filter on status
-- first, and the practitioner day view.
CREATE INDEX IF NOT EXISTS "appointments_tenant_id_status_start_idx"
    ON "appointments" ("tenant_id", "status", "start");

CREATE INDEX IF NOT EXISTS "appointments_tenant_id_patient_id_status_idx"
    ON "appointments" ("tenant_id", "patient_id", "status");

-- Slot availability is always scoped to one practitioner's schedule for one day.
-- practitioner_id lives on schedules, not slots, so the slot-side index is on
-- schedule_id and the join hop is covered by schedules' own practitioner index.
CREATE INDEX IF NOT EXISTS "slots_schedule_id_status_start_idx"
    ON "slots" ("schedule_id", "status", "start");

CREATE INDEX IF NOT EXISTS "schedules_tenant_id_practitioner_id_is_active_idx"
    ON "schedules" ("tenant_id", "practitioner_id", "is_active");

-- The queue display polls one location's tokens for the current day.
CREATE INDEX IF NOT EXISTS "queues_tenant_id_location_id_queue_date_idx"
    ON "queues" ("tenant_id", "location_id", "queue_date");
