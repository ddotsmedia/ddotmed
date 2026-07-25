'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { PageHeader, QueryState } from '@/components/ui';

interface HieStatus {
  name: string;
  country_pack: string;
  configured: boolean;
}

const COUNTRY_PACKS = ['uae', 'saudi', 'india', 'usa', 'eu', 'uk', 'africa'] as const;

const MODULES = [
  'patients',
  'appointments',
  'encounters',
  'notes',
  'conditions',
  'allergies',
  'medications',
  'vitals',
  'lab',
  'radiology',
  'pharmacy',
  'beds',
  'billing',
  'insurance',
  'inventory',
  'hr',
] as const;

export default function ConfigPage() {
  const { t } = useI18n();
  const { can, roles } = usePermissions();

  const hie = useQuery<HieStatus[]>({
    queryKey: ['fhir', 'hie', 'status'],
    queryFn: () => api.get<HieStatus[]>('/fhir/hie/status'),
    enabled: can('config:manage'),
  });

  return (
    <>
      <PageHeader title={t('common.settings')} subtitle={roles.join(', ')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-2 font-semibold">{t('common.appName')}</h2>
          <p className="mb-2 text-sm text-slate-600">Country pack</p>
          <div className="flex flex-wrap gap-2">
            {COUNTRY_PACKS.map((pack) => (
              <span
                key={pack}
                className="rounded border border-slate-300 px-2 py-1 text-xs uppercase dark:border-slate-600"
              >
                {pack}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            The active pack drives identifier validation, invoice format, tax rules and claim
            format. It is set per tenant at provisioning time.
          </p>
        </section>

        <section className="card">
          <h2 className="mb-2 font-semibold">{t('common.settings')}</h2>
          <ul className="grid grid-cols-2 gap-1 text-sm">
            {MODULES.map((moduleName) => (
              <li key={moduleName} className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
                {moduleName}
              </li>
            ))}
          </ul>
        </section>

        <section className="card lg:col-span-2">
          <h2 className="mb-2 font-semibold">HIE</h2>
          <QueryState isLoading={hie.isLoading} error={hie.error} isEmpty={hie.data?.length === 0}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.appName')}</th>
                  <th>Country pack</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {hie.data?.map((adapter) => (
                  <tr key={adapter.name}>
                    <td className="font-medium">{adapter.name}</td>
                    <td className="uppercase">{adapter.country_pack}</td>
                    <td>
                      <span
                        className={
                          adapter.configured
                            ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800'
                            : 'rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-700'
                        }
                      >
                        {adapter.configured ? t('common.online') : t('common.offline')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              An unconfigured adapter refuses to transmit patient data rather than failing silently.
            </p>
          </QueryState>
        </section>
      </div>
    </>
  );
}
