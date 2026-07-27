'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useChannel } from '@/lib/realtime';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface Appointment {
  id: string;
  status: string;
  service_type: string;
  specialty: string | null;
  start: string;
  minutes_duration: number;
  queue_token: string | null;
  noshow_risk: string | number | null;
  reason_text: string | null;
  is_telehealth: boolean;
  patient?: { id: string; mrn: string; given_names: string[]; family_name: string };
  practitioner?: { given_names: string[]; family_name: string } | null;
}

interface PatientHit {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
}

const STATUS_TONE: Record<string, string> = {
  booked: 'bg-sky-100 text-sky-800',
  arrived: 'bg-indigo-100 text-indigo-800',
  checked_in: 'bg-indigo-100 text-indigo-800',
  walk_in: 'bg-violet-100 text-violet-800',
  fulfilled: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-slate-200 text-slate-700',
  noshow: 'bg-red-100 text-red-800',
  waitlist: 'bg-amber-100 text-amber-800',
};

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function AppointmentsPage() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const queryClient = useQueryClient();

  const [day, setDay] = useState(todayIso());
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [rescheduling, setRescheduling] = useState<Appointment | null>(null);

  useChannel('queue:general');

  const appointments = useQuery<Appointment[]>({
    queryKey: ['appointments', day],
    queryFn: () =>
      api.get<Appointment[]>('/appointments', {
        from: `${day}T00:00:00.000Z`,
        to: `${day}T23:59:59.999Z`,
      }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };

  const cancel = useMutation<unknown, Error, string>({
    mutationFn: (id) => api.patch(`/appointments/${id}`, { action: 'cancel' }),
    onSuccess: invalidate,
  });

  const now = new Date();
  const rows = appointments.data ?? [];
  const upcoming = rows.filter(
    (a) => new Date(a.start) >= now && !['cancelled', 'noshow', 'fulfilled'].includes(a.status),
  );
  const past = rows.filter((a) => !upcoming.includes(a));

  const renderCard = (appointment: Appointment) => {
    const risk = Number(appointment.noshow_risk ?? 0);
    const patient = appointment.patient;
    const isPast = !upcoming.includes(appointment);

    return (
      <li key={appointment.id} className="card">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums font-semibold">
                {appointment.status === 'walk_in'
                  ? (appointment.queue_token ?? 'Walk-in')
                  : new Date(appointment.start).toISOString().slice(11, 16)}
              </span>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${
                  STATUS_TONE[appointment.status] ?? 'bg-slate-100 text-slate-700'
                }`}
              >
                {appointment.status.replace(/_/g, ' ')}
              </span>
              {appointment.is_telehealth && (
                <span className="rounded bg-teal-100 px-2 py-0.5 text-xs text-teal-800">video</span>
              )}
            </div>

            <p className="mt-1 truncate font-medium">
              {patient ? (
                <Link href={`/patients/${patient.id}`} className="hover:underline">
                  {patient.given_names.join(' ')} {patient.family_name}
                </Link>
              ) : (
                '—'
              )}
              {patient && (
                <span className="ms-2 font-mono text-xs text-slate-500">{patient.mrn}</span>
              )}
            </p>

            <p className="text-xs text-slate-600 dark:text-slate-300">
              {appointment.service_type}
              {appointment.practitioner &&
                ` · Dr ${appointment.practitioner.family_name}`}
              {` · ${appointment.minutes_duration}m`}
            </p>

            {appointment.reason_text && (
              <p className="truncate text-xs text-slate-500">{appointment.reason_text}</p>
            )}
          </div>

          {risk >= 0.3 && !isPast && (
            <span
              className={
                risk >= 0.6
                  ? 'rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800'
                  : 'rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800'
              }
              title="Predicted no-show risk"
            >
              no-show {(risk * 100).toFixed(0)}%
            </span>
          )}
        </div>

        {can('patient:write') && !isPast && appointment.status !== 'cancelled' && (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary py-1 text-xs"
              onClick={() => setRescheduling(appointment)}
            >
              Reschedule
            </button>
            <button
              type="button"
              className="btn-secondary py-1 text-xs text-red-700"
              onClick={() => cancel.mutate(appointment.id)}
              disabled={cancel.isPending}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title={t('clinical.appointment')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/appointments/queue" className="btn-secondary">
              Queue
            </Link>
            {can('patient:write') && (
              <>
                <button type="button" className="btn-secondary" onClick={() => setShowWalkIn(true)}>
                  Walk-in
                </button>
                <Link href="/appointments/new" className="btn-primary">
                  + Book
                </Link>
              </>
            )}
          </div>
        }
      />

      <div className="mb-3">
        <input
          className="input"
          type="date"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-label={t('common.date')}
        />
      </div>

      {cancel.isError && (
        <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {cancel.error.message}
        </p>
      )}

      <QueryState
        isLoading={appointments.isLoading}
        error={appointments.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('common.noData')}
      >
        {upcoming.length > 0 && (
          <section className="mb-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              Upcoming ({upcoming.length})
            </h2>
            <ul className="space-y-2">{upcoming.map(renderCard)}</ul>
          </section>
        )}

        {past.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
              Earlier ({past.length})
            </h2>
            <ul className="space-y-2 opacity-75">{past.map(renderCard)}</ul>
          </section>
        )}
      </QueryState>

      {showWalkIn && (
        <WalkInDialog
          onClose={() => setShowWalkIn(false)}
          onCreated={() => {
            setShowWalkIn(false);
            invalidate();
          }}
        />
      )}

      {rescheduling && (
        <RescheduleDialog
          appointment={rescheduling}
          onClose={() => setRescheduling(null)}
          onDone={() => {
            setRescheduling(null);
            invalidate();
          }}
        />
      )}
    </>
  );
}

function WalkInDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [priority, setPriority] = useState(0);
  const [reason, setReason] = useState('');
  const debounced = useDebounced(query.trim(), 300);

  const patients = useQuery<{ data: PatientHit[] }>({
    queryKey: ['patients', 'walkin', debounced],
    queryFn: () => api.get<{ data: PatientHit[] }>('/patients', { q: debounced, limit: 6 }),
    enabled: debounced.length >= 2 && !patient,
  });

  const create = useMutation<{ token: string; estimated_wait_minutes: number | null }, Error>({
    mutationFn: () =>
      api.post('/appointments/walk-in', {
        patient_id: patient!.id,
        queue_name: 'general',
        priority,
        reason_text: reason || undefined,
      }),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-t-xl bg-white p-4 sm:rounded-xl dark:bg-slate-800">
        <h2 className="text-lg font-bold">Walk-in</h2>

        {create.data ? (
          <div className="py-6 text-center">
            <p className="text-sm text-slate-500">Queue token</p>
            <p className="my-2 font-mono text-5xl font-bold tracking-wider text-sky-700">
              {create.data.token}
            </p>
            {create.data.estimated_wait_minutes !== null && (
              <p className="text-sm text-slate-600">
                Estimated wait ~{create.data.estimated_wait_minutes} min
              </p>
            )}
            <button type="button" className="btn-primary mt-4 w-full" onClick={onCreated}>
              {t('common.close')}
            </button>
          </div>
        ) : (
          <>
            {!patient ? (
              <>
                <Field label={t('clinical.patient')} required>
                  <input
                    className="input"
                    placeholder="Name, MRN or phone"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                </Field>
                <ul className="mt-2 space-y-1">
                  {(patients.data?.data ?? []).map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="w-full rounded border border-slate-300 p-2 text-start text-sm dark:border-slate-600"
                        onClick={() => setPatient(p)}
                      >
                        {p.given_names.join(' ')} {p.family_name}
                        <span className="ms-2 font-mono text-xs text-slate-500">{p.mrn}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-2 text-sm">
                {patient.given_names.join(' ')} {patient.family_name}
                <button
                  type="button"
                  className="ms-2 text-xs text-sky-700 underline"
                  onClick={() => setPatient(null)}
                >
                  change
                </button>
              </p>
            )}

            <Field label="Triage priority">
              <select
                className="input"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              >
                <option value={0}>Routine</option>
                <option value={3}>Urgent</option>
                <option value={5}>Emergency</option>
              </select>
            </Field>

            <Field label={t('common.notes')}>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>

            {create.isError && (
              <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {create.error.message}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-primary flex-1"
                disabled={!patient || create.isPending}
                onClick={() => create.mutate()}
              >
                Issue token
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RescheduleDialog({
  appointment,
  onClose,
  onDone,
}: {
  appointment: Appointment;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [start, setStart] = useState(appointment.start.slice(0, 16));
  const [reason, setReason] = useState('');

  const submit = useMutation<unknown, Error>({
    mutationFn: () =>
      api.patch(`/appointments/${appointment.id}`, {
        action: 'reschedule',
        start: new Date(start).toISOString(),
        minutes_duration: appointment.minutes_duration,
        reason: reason || undefined,
      }),
    onSuccess: onDone,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-md rounded-t-xl bg-white p-4 sm:rounded-xl dark:bg-slate-800">
        <h2 className="text-lg font-bold">Reschedule</h2>

        <Field label="New date and time" required>
          <input
            className="input"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Field>

        <Field label={t('common.notes')}>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>

        {submit.isError && (
          <p className="mt-2 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            {submit.error instanceof ApiError && submit.error.status === 409
              ? 'That time clashes with another appointment.'
              : submit.error.message}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
