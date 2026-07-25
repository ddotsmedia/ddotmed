'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { PatientBanner } from '@medicore/ui-components';
import type { Allergy, Patient } from '@medicore/shared-types';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { useChannel } from '@/lib/realtime';
import { useAllergies, useMedications, usePatient, usePatientTimeline, useVitals } from '@/lib/queries';
import { PageHeader, QueryState, EwsBadge } from '@/components/ui';

type Tab = 'timeline' | 'problems' | 'medications' | 'vitals' | 'results';

const TAB_KEYS: Record<Tab, string> = {
  timeline: 'clinical.encounters',
  problems: 'clinical.problemList',
  medications: 'clinical.medications',
  vitals: 'clinical.vitals',
  results: 'clinical.labResults',
};

export default function PatientWorkstation({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, date } = useI18n();
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>('timeline');

  // Subscribing keeps vitals, results and alerts for this patient live on screen.
  useChannel(`patient:${id}`);

  const patient = usePatient(id);
  const allergies = useAllergies(id);
  const timeline = usePatientTimeline(id);
  const medications = useMedications(id);
  const vitals = useVitals(id);

  const record = patient.data as (Patient & { conditions?: Record<string, unknown>[] }) | undefined;

  return (
    <QueryState isLoading={patient.isLoading} error={patient.error}>
      {record && (
        <>
          <PatientBanner
            patient={{
              id: record.id,
              mrn: record.mrn,
              name: {
                given: (record as unknown as { given_names: string[] }).given_names,
                family: (record as unknown as { family_name: string }).family_name,
              },
              gender: record.gender,
              birth_date: String(record.birth_date).slice(0, 10),
              blood_group: record.blood_group,
              is_vip: record.is_vip,
            }}
            allergies={(allergies.data ?? []) as unknown as Allergy[]}
            t={t}
            className="-mx-4 -mt-4 mb-4"
          />

          <PageHeader
            title={t('clinical.patient')}
            actions={
              can('encounter:write') && (
                <Link href={`/encounters/new?patient=${id}`} className="btn-primary">
                  {t('clinical.encounter')}
                </Link>
              )
            }
          />

          <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-700">
            {(Object.keys(TAB_KEYS) as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? 'border-b-2 border-sky-600 px-3 py-2 text-sm font-semibold text-sky-700'
                    : 'px-3 py-2 text-sm text-slate-600 hover:text-slate-900'
                }
              >
                {t(TAB_KEYS[key])}
              </button>
            ))}
          </div>

          {tab === 'timeline' && (
            <QueryState
              isLoading={timeline.isLoading}
              error={timeline.error}
              isEmpty={timeline.data?.length === 0}
            >
              <ol className="space-y-2">
                {timeline.data?.map((entry) => (
                  <li key={`${entry.type}-${entry.id}`} className="card flex gap-3">
                    <span className="w-24 shrink-0 text-xs text-slate-500">{date(entry.at, true)}</span>
                    <span className="w-24 shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium dark:bg-slate-800">
                      {entry.type}
                    </span>
                    <span className="min-w-0 flex-1 text-sm">{entry.summary}</span>
                  </li>
                ))}
              </ol>
            </QueryState>
          )}

          {tab === 'problems' && (
            <div className="card overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('clinical.diagnosis')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('common.date')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(record.conditions ?? []).map((c) => (
                    <tr key={String(c.id)}>
                      <td>
                        <span className="font-mono text-xs">{String(c.code)}</span>{' '}
                        {String(c.code_display ?? '')}
                      </td>
                      <td>{String(c.clinical_status)}</td>
                      <td className="text-xs">{c.onset_date ? date(String(c.onset_date)) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'medications' && (
            <QueryState
              isLoading={medications.isLoading}
              error={medications.error}
              isEmpty={medications.data?.length === 0}
            >
              <div className="card overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('clinical.medications')}</th>
                      <th>{t('common.notes')}</th>
                      <th>{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {medications.data?.map((m) => (
                      <tr key={String(m.id)}>
                        <td className="font-medium">
                          {String(m.code_display)}
                          {Boolean(m.is_controlled) && (
                            <span className="ms-2 rounded bg-red-100 px-1 text-xs text-red-800">CD</span>
                          )}
                        </td>
                        <td className="text-xs">
                          {String(m.dose_quantity)} {String(m.dose_unit)} {String(m.route)}{' '}
                          {String(m.frequency)}
                        </td>
                        <td>{String(m.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </QueryState>
          )}

          {tab === 'vitals' && (
            <QueryState
              isLoading={vitals.isLoading}
              error={vitals.error}
              isEmpty={vitals.data?.length === 0}
            >
              <div className="card overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.time')}</th>
                      <th>{t('clinical.bloodPressure')}</th>
                      <th>{t('clinical.heartRate')}</th>
                      <th>{t('clinical.spo2')}</th>
                      <th>{t('clinical.temperature')}</th>
                      <th>{t('clinical.ews')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vitals.data?.map((v) => (
                      <tr key={String(v.id)}>
                        <td className="text-xs">{date(String(v.recorded_at), true)}</td>
                        <td className="tabular-nums">
                          {v.systolic_bp ? `${String(v.systolic_bp)}/${String(v.diastolic_bp ?? '')}` : '—'}
                        </td>
                        <td className="tabular-nums">{String(v.heart_rate ?? '—')}</td>
                        <td className="tabular-nums">{String(v.spo2 ?? '—')}</td>
                        <td className="tabular-nums">{String(v.temperature_c ?? '—')}</td>
                        <td>
                          <EwsBadge
                            score={v.ews_score as number | null}
                            risk={v.ews_risk as string | null}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </QueryState>
          )}

          {tab === 'results' && (
            <div className="card">
              <Link href={`/lab?patient=${id}`} className="text-sky-700 underline">
                {t('clinical.labResults')}
              </Link>
            </div>
          )}
        </>
      )}
    </QueryState>
  );
}
