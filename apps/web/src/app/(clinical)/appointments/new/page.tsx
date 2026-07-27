'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useDebounced } from '@/lib/use-debounced';
import { PageHeader, QueryState, Field } from '@/components/ui';

interface Practitioner {
  id: string;
  given_names: string[];
  family_name: string;
  specialties: string[];
  qualifications: string[];
}

interface Slot {
  id: string;
  start: string;
  end: string;
  minutes: number;
  overbooked: boolean;
}

interface SlotsResponse {
  date: string;
  available_count: number;
  groups: Array<{ period: 'morning' | 'afternoon' | 'evening'; slots: Slot[] }>;
}

interface PatientHit {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
}

const PERIOD_LABEL: Record<string, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
};

const today = () => new Date().toISOString().slice(0, 10);

export default function NewAppointmentPage() {
  return (
    <Suspense fallback={null}>
      <BookingFlow />
    </Suspense>
  );
}

function BookingFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const { t, date } = useI18n();

  const [step, setStep] = useState(0);
  const [specialty, setSpecialty] = useState('');
  const [practitioner, setPractitioner] = useState<Practitioner | null>(null);
  const [day, setDay] = useState(today());
  const [slot, setSlot] = useState<Slot | null>(null);
  const [patientId, setPatientId] = useState(params.get('patient') ?? '');
  const [patientQuery, setPatientQuery] = useState('');
  const [reason, setReason] = useState('');

  const debouncedPatient = useDebounced(patientQuery.trim(), 300);

  const specialties = useQuery<string[]>({
    queryKey: ['practitioners', 'specialties'],
    queryFn: () => api.get<string[]>('/practitioners/specialties'),
    staleTime: 30 * 60_000,
  });

  const practitioners = useQuery<Practitioner[]>({
    queryKey: ['practitioners', specialty],
    queryFn: () => api.get<Practitioner[]>('/practitioners', { specialty: specialty || undefined }),
    enabled: step >= 1,
  });

  const slots = useQuery<SlotsResponse>({
    queryKey: ['slots', practitioner?.id, day],
    queryFn: () =>
      api.get<SlotsResponse>(`/practitioners/${practitioner!.id}/slots`, {
        date: day,
        min_lead_minutes: 30,
      }),
    enabled: Boolean(practitioner?.id) && step >= 2,
  });

  const patients = useQuery<{ data: PatientHit[] }>({
    queryKey: ['patients', 'picker', debouncedPatient],
    queryFn: () => api.get<{ data: PatientHit[] }>('/patients', { q: debouncedPatient, limit: 6 }),
    enabled: debouncedPatient.length >= 2 && !patientId,
  });

  const book = useMutation<{ id: string }, Error>({
    mutationFn: () =>
      api.post<{ id: string }>('/appointments', {
        patient_id: patientId,
        practitioner_id: practitioner?.id,
        slot_id: slot?.id,
        service_type: specialty || 'consultation',
        specialty: specialty || undefined,
        start: slot?.start,
        minutes_duration: slot?.minutes ?? 15,
        reason_text: reason || undefined,
        channel: 'online',
      }),
    onSuccess: () => router.push('/appointments'),
  });

  const steps = ['Specialty', 'Doctor & date', 'Time', 'Confirm'];
  const progress = useMemo(() => ((step + 1) / steps.length) * 100, [step, steps.length]);

  const canAdvance =
    (step === 0 && specialty !== '') ||
    (step === 1 && practitioner !== null && day !== '') ||
    (step === 2 && slot !== null) ||
    (step === 3 && patientId !== '');

  return (
    <>
      <PageHeader title="Book appointment" subtitle={steps[step]} />

      <div className="mb-4">
        <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
          <span className="font-medium">{steps[step]}</span>
          <span>
            {step + 1}/{steps.length}
          </span>
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="h-1.5 rounded-full bg-sky-600 transition-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="card space-y-4">
        {step === 0 && (
          <QueryState isLoading={specialties.isLoading} error={specialties.error}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(specialties.data ?? []).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSpecialty(s);
                    setPractitioner(null);
                    setStep(1);
                  }}
                  className={
                    specialty === s
                      ? 'rounded-lg border-2 border-sky-600 bg-sky-50 p-3 text-sm font-semibold text-sky-900'
                      : 'rounded-lg border border-slate-300 p-3 text-sm hover:border-sky-400 dark:border-slate-600'
                  }
                >
                  {s}
                </button>
              ))}
              {(specialties.data?.length ?? 0) === 0 && (
                <p className="col-span-full text-sm text-slate-500">
                  No specialties configured yet.
                </p>
              )}
            </div>
          </QueryState>
        )}

        {step === 1 && (
          <>
            <Field label={t('common.date')} required>
              <input
                className="input"
                type="date"
                min={today()}
                value={day}
                onChange={(e) => {
                  setDay(e.target.value);
                  setSlot(null);
                }}
              />
            </Field>

            <QueryState
              isLoading={practitioners.isLoading}
              error={practitioners.error}
              isEmpty={(practitioners.data?.length ?? 0) === 0}
              emptyMessage="No available doctors in this specialty"
            >
              <ul className="space-y-2">
                {(practitioners.data ?? []).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPractitioner(p);
                        setSlot(null);
                      }}
                      className={
                        practitioner?.id === p.id
                          ? 'w-full rounded-lg border-2 border-sky-600 bg-sky-50 p-3 text-start'
                          : 'w-full rounded-lg border border-slate-300 p-3 text-start hover:border-sky-400 dark:border-slate-600'
                      }
                    >
                      <p className="font-medium">
                        Dr {p.given_names.join(' ')} {p.family_name}
                      </p>
                      <p className="text-xs text-slate-500">
                        {p.specialties.join(', ')}
                        {p.qualifications.length > 0 && ` · ${p.qualifications.join(', ')}`}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </QueryState>
          </>
        )}

        {step === 2 && practitioner && (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Dr {practitioner.family_name} · {date(day)}
            </p>

            <QueryState
              isLoading={slots.isLoading}
              error={slots.error}
              isEmpty={(slots.data?.available_count ?? 0) === 0}
              emptyMessage="No free slots on this day — try another date"
            >
              <div className="space-y-4">
                {(slots.data?.groups ?? []).map((group) => (
                  <section key={group.period}>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {PERIOD_LABEL[group.period]}
                    </h3>
                    {/* Tap targets sized for a thumb, three across on a phone. */}
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {group.slots.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setSlot(s)}
                          className={
                            slot?.id === s.id
                              ? 'rounded-lg border-2 border-sky-600 bg-sky-600 py-3 text-sm font-semibold text-white'
                              : 'rounded-lg border border-slate-300 py-3 text-sm hover:border-sky-400 dark:border-slate-600'
                          }
                        >
                          {new Date(s.start).toISOString().slice(11, 16)}
                          {s.overbooked && (
                            <span className="block text-[10px] font-normal opacity-75">extra</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </QueryState>
          </>
        )}

        {step === 3 && (
          <>
            {!patientId ? (
              <>
                <Field label={t('clinical.patient')} required>
                  <input
                    className="input"
                    placeholder="Name, MRN or phone"
                    value={patientQuery}
                    onChange={(e) => setPatientQuery(e.target.value)}
                    autoFocus
                  />
                </Field>
                <ul className="space-y-1">
                  {(patients.data?.data ?? []).map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg border border-slate-300 p-2 text-start text-sm hover:border-sky-400 dark:border-slate-600"
                        onClick={() => setPatientId(p.id)}
                      >
                        {p.given_names.join(' ')} {p.family_name}
                        <span className="ms-2 font-mono text-xs text-slate-500">{p.mrn}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <button
                type="button"
                className="text-xs text-sky-700 underline"
                onClick={() => setPatientId('')}
              >
                Change patient
              </button>
            )}

            <Field label={t('common.notes')}>
              <textarea
                className="input min-h-20"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for visit"
              />
            </Field>

            <dl className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">
              <div className="flex justify-between">
                <dt className="text-slate-500">Specialty</dt>
                <dd>{specialty}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Doctor</dt>
                <dd>Dr {practitioner?.family_name}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">{t('common.date')}</dt>
                <dd>{date(day)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">{t('common.time')}</dt>
                <dd className="font-semibold">
                  {slot ? new Date(slot.start).toISOString().slice(11, 16) : '—'}
                </dd>
              </div>
            </dl>

            {book.isError && (
              <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {book.error instanceof ApiError && book.error.status === 409
                  ? 'That slot was just taken — pick another time.'
                  : book.error.message}
              </p>
            )}
          </>
        )}

        {/* Sticky so the primary action stays reachable one-handed. */}
        <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
          {step > 0 && (
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => setStep((s) => s - 1)}
            >
              {t('common.back')}
            </button>
          )}
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={!canAdvance || book.isPending}
            onClick={() => (step === 3 ? book.mutate() : setStep((s) => s + 1))}
          >
            {book.isPending
              ? t('common.loading')
              : step === 3
                ? t('common.confirm')
                : t('common.next')}
          </button>
        </div>
      </div>
    </>
  );
}
