'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PatientBanner, ageFrom } from '@medicore/ui-components';
import type { Allergy } from '@medicore/shared-types';
import { api } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useChannel } from '@/lib/realtime';
import { PageHeader, QueryState } from '@/components/ui';
import { IdCard } from './IdCard';

type Tab = 'timeline' | 'medications' | 'insurance' | 'documents';

interface TimelineEntry {
  id: string;
  type: string;
  at: string;
  title: string;
  detail: string | null;
  severity: 'normal' | 'warning' | 'critical';
  encounter_id: string | null;
}

interface Profile {
  id: string;
  mrn: string;
  given_names: string[];
  family_name: string;
  gender: 'male' | 'female' | 'other' | 'unknown';
  birth_date: string;
  blood_group: string | null;
  is_vip: boolean;
  photo_url: string | null;
  allergies: Allergy[];
  conditions: Array<{ id: string; code: string; code_display: string | null; clinical_status: string }>;
  medications: Array<{
    id: string;
    code_display: string;
    dose_quantity: string | number;
    dose_unit: string;
    route: string;
    frequency: string;
    status: string;
    is_controlled: boolean;
    end_date: string | null;
  }>;
  coverages: Array<{
    id: string;
    member_id: string;
    policy_number: string;
    plan_name: string | null;
    status: string;
    starts_at: string;
    ends_at: string | null;
    copay_bp: number;
    payer: { name: string; code: string } | null;
  }>;
  contacts: Array<{ id: string; relationship: string; system: string; value: string; is_emergency: boolean }>;
  identifiers: Array<{ id: string; type: string; value: string }>;
}

const TYPE_ICON: Record<string, string> = {
  encounter: '🏥',
  condition: '🩺',
  medication: '💊',
  lab: '🧪',
  imaging: '📷',
  note: '📝',
  vitals: '📈',
  admission: '🛏',
};

const SEVERITY_STYLE: Record<TimelineEntry['severity'], string> = {
  critical: 'border-red-400 bg-red-50 dark:bg-red-950/30',
  warning: 'border-amber-400 bg-amber-50 dark:bg-amber-950/30',
  normal: 'border-slate-200 dark:border-slate-700',
};

export default function PatientProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>('timeline');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [showCard, setShowCard] = useState(false);

  // Keeps vitals, results and alerts for this patient live while the chart is open.
  useChannel(`patient:${id}`);

  const profile = useQuery<Profile>({
    queryKey: ['patient', id],
    queryFn: () => api.get<Profile>(`/patients/${id}`),
    enabled: Boolean(id),
  });

  const timeline = useQuery<TimelineEntry[]>({
    queryKey: ['patient', id, 'timeline'],
    queryFn: () => api.get<TimelineEntry[]>(`/patients/${id}/timeline`, { limit: 200 }),
    enabled: Boolean(id) && tab === 'timeline',
  });

  const grouped = useMemo(() => {
    const entries = (timeline.data ?? []).filter((e) => !typeFilter || e.type === typeFilter);
    const days = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const day = entry.at.slice(0, 10);
      const bucket = days.get(day);
      if (bucket) bucket.push(entry);
      else days.set(day, [entry]);
    }
    return [...days.entries()];
  }, [timeline.data, typeFilter]);

  const patient = profile.data;
  const activeMeds = patient?.medications.filter((m) => m.status === 'active') ?? [];

  return (
    <QueryState isLoading={profile.isLoading} error={profile.error}>
      {patient && (
        <>
          <PatientBanner
            patient={{
              id: patient.id,
              mrn: patient.mrn,
              name: { given: patient.given_names, family: patient.family_name },
              gender: patient.gender,
              birth_date: patient.birth_date.slice(0, 10),
              blood_group: patient.blood_group as never,
              is_vip: patient.is_vip,
            }}
            allergies={patient.allergies}
            t={t}
            className="-mx-4 -mt-4 mb-4"
          />

          <PageHeader
            title={`${patient.given_names.join(' ')} ${patient.family_name}`}
            subtitle={`${ageFrom(patient.birth_date)}y · ${t(`clinical.${patient.gender}`)} · ${patient.mrn}`}
            actions={
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => setShowCard(true)}>
                  ID card
                </button>
                {can('encounter:write') && (
                  <Link href={`/encounters/new?patient=${id}`} className="btn-primary">
                    {t('clinical.encounter')}
                  </Link>
                )}
              </div>
            }
          />

          {/* Problem list sits above the tabs: it is context for everything below. */}
          {patient.conditions.length > 0 && (
            <div className="card mb-3">
              <h2 className="mb-2 text-sm font-semibold">{t('clinical.problemList')}</h2>
              <ul className="flex flex-wrap gap-1.5">
                {patient.conditions.map((c) => (
                  <li
                    key={c.id}
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-600"
                  >
                    <span className="font-mono text-[10px] text-slate-500">{c.code}</span>{' '}
                    {c.code_display ?? ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700">
            {(['timeline', 'medications', 'insurance', 'documents'] as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? 'whitespace-nowrap border-b-2 border-sky-600 px-3 py-2 text-sm font-semibold text-sky-700'
                    : 'whitespace-nowrap px-3 py-2 text-sm text-slate-600 hover:text-slate-900'
                }
              >
                {key === 'timeline' && t('clinical.encounters')}
                {key === 'medications' && `${t('clinical.medications')} (${activeMeds.length})`}
                {key === 'insurance' && t('billing.insurance')}
                {key === 'documents' && 'Documents'}
              </button>
            ))}
          </div>

          {tab === 'timeline' && (
            <>
              <div className="mb-3 flex gap-1 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setTypeFilter('')}
                  className={
                    typeFilter === ''
                      ? 'rounded-full bg-sky-600 px-3 py-1 text-xs font-medium text-white'
                      : 'rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-800'
                  }
                >
                  {t('common.all')}
                </button>
                {Object.keys(TYPE_ICON).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTypeFilter(type)}
                    className={
                      typeFilter === type
                        ? 'whitespace-nowrap rounded-full bg-sky-600 px-3 py-1 text-xs font-medium text-white'
                        : 'whitespace-nowrap rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-800'
                    }
                  >
                    {TYPE_ICON[type]} {type}
                  </button>
                ))}
              </div>

              <QueryState
                isLoading={timeline.isLoading}
                error={timeline.error}
                isEmpty={grouped.length === 0}
                emptyMessage={t('common.noData')}
              >
                <div className="max-h-[70dvh] space-y-4 overflow-y-auto pe-1">
                  {grouped.map(([day, entries]) => (
                    <section key={day}>
                      <h3 className="sticky top-0 z-10 bg-slate-50 py-1 text-xs font-semibold text-slate-500 dark:bg-slate-950">
                        {date(day)}
                      </h3>
                      <ol className="space-y-2">
                        {entries.map((entry) => (
                          <li
                            key={`${entry.type}-${entry.id}`}
                            className={`rounded-lg border p-3 ${SEVERITY_STYLE[entry.severity]}`}
                          >
                            <div className="flex items-start gap-2">
                              <span aria-hidden className="text-base leading-none">
                                {TYPE_ICON[entry.type] ?? '•'}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium">{entry.title}</p>
                                {entry.detail && (
                                  <p className="text-xs text-slate-600 dark:text-slate-300">
                                    {entry.detail}
                                  </p>
                                )}
                                {/* Severity is spelled out, never colour alone. */}
                                {entry.severity !== 'normal' && (
                                  <p
                                    className={
                                      entry.severity === 'critical'
                                        ? 'mt-1 text-xs font-bold uppercase text-red-800'
                                        : 'mt-1 text-xs font-semibold uppercase text-amber-800'
                                    }
                                  >
                                    {entry.severity}
                                  </p>
                                )}
                              </div>
                              <time className="shrink-0 text-xs tabular-nums text-slate-500">
                                {new Date(entry.at).toISOString().slice(11, 16)}
                              </time>
                            </div>
                            {entry.encounter_id && (
                              <Link
                                href={`/encounters/${entry.encounter_id}`}
                                className="mt-1 inline-block text-xs text-sky-700 underline"
                              >
                                {t('clinical.encounter')}
                              </Link>
                            )}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              </QueryState>
            </>
          )}

          {tab === 'medications' && (
            <div className="space-y-2">
              {activeMeds.length === 0 && (
                <p className="card text-center text-sm text-slate-500">{t('common.noData')}</p>
              )}
              {activeMeds.map((m) => (
                <article key={m.id} className="card">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium">{m.code_display}</h3>
                    {m.is_controlled && (
                      <span className="rounded bg-red-100 px-1.5 text-xs font-bold text-red-800">
                        CD
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    {String(m.dose_quantity)} {m.dose_unit} · {m.route} · {m.frequency}
                  </p>
                  {m.end_date && (
                    <p className="text-xs text-slate-500">Until {date(m.end_date)}</p>
                  )}
                </article>
              ))}
            </div>
          )}

          {tab === 'insurance' && (
            <div className="space-y-2">
              {patient.coverages.length === 0 && (
                <p className="card text-center text-sm text-slate-500">Self-pay</p>
              )}
              {patient.coverages.map((c) => (
                <article key={c.id} className="card">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{c.payer?.name ?? c.plan_name ?? 'Coverage'}</h3>
                    <span
                      className={
                        c.status === 'active'
                          ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800'
                          : 'rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700'
                      }
                    >
                      {c.status}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-slate-500">Member ID</dt>
                    <dd className="font-mono">{c.member_id}</dd>
                    <dt className="text-slate-500">Policy</dt>
                    <dd className="font-mono">{c.policy_number}</dd>
                    <dt className="text-slate-500">Copay</dt>
                    <dd>{(c.copay_bp / 100).toFixed(1)}%</dd>
                    <dt className="text-slate-500">Valid</dt>
                    <dd>
                      {date(c.starts_at)} — {c.ends_at ? date(c.ends_at) : '—'}
                    </dd>
                  </dl>
                </article>
              ))}
            </div>
          )}

          {tab === 'documents' && (
            <div className="space-y-3">
              <div className="card">
                <h3 className="mb-2 text-sm font-semibold">{t('clinical.mrn')} &amp; identifiers</h3>
                <dl className="space-y-1 text-xs">
                  {patient.identifiers.map((i) => (
                    <div key={i.id} className="flex justify-between gap-2">
                      <dt className="text-slate-500">{i.type}</dt>
                      <dd className="font-mono">{i.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="card">
                <h3 className="mb-2 text-sm font-semibold">Contacts</h3>
                <ul className="space-y-1 text-xs">
                  {patient.contacts.map((c) => (
                    <li key={c.id} className="flex justify-between gap-2">
                      <span className="text-slate-500">
                        {c.relationship}
                        {c.is_emergency && (
                          <span className="ms-1 rounded bg-red-100 px-1 text-[10px] text-red-800">
                            emergency
                          </span>
                        )}
                      </span>
                      <span className="font-mono">{c.value}</span>
                    </li>
                  ))}
                  {patient.contacts.length === 0 && (
                    <li className="text-slate-500">{t('common.noData')}</li>
                  )}
                </ul>
              </div>

              <div className="card">
                <h3 className="mb-2 text-sm font-semibold">Uploaded documents</h3>
                {/* Document storage lands with the MinIO upload pipeline; the tab is
                    here so identifiers and contacts have a home in the meantime. */}
                <p className="text-sm text-slate-500">
                  No documents uploaded. Scanned records and consent forms will appear here.
                </p>
              </div>
            </div>
          )}

          {showCard && (
            <IdCard
              patient={patient}
              facilityName={t('common.appName')}
              onClose={() => setShowCard(false)}
            />
          )}
        </>
      )}
    </QueryState>
  );
}
