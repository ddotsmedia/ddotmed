'use client';

import { useI18n } from '@/lib/i18n';
import { useBedBoard, useNurseRatios, useReorderReport } from '@/lib/queries';
import { PageHeader, QueryState, StatTile } from '@/components/ui';

interface WardRatio {
  ward: string;
  acuity: string;
  patients: number;
  nurses: number;
  max_patients_per_nurse: number;
  actual_ratio: number | null;
  breaching: boolean;
  shortfall_nurses: number;
}

export default function AnalyticsPage() {
  const { t } = useI18n();
  const beds = useBedBoard();
  const ratios = useNurseRatios();
  const reorder = useReorderReport();

  const wards = (ratios.data?.wards ?? []) as WardRatio[];
  const breaching = wards.filter((w) => w.breaching);
  const totals = beds.data?.totals;
  const occupancy = totals?.total ? Math.round((totals.occupied / totals.total) * 100) : 0;

  return (
    <>
      <PageHeader title={t('common.dashboard')} subtitle={t('common.export')} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={t('clinical.bed')}
          value={`${occupancy}%`}
          tone={occupancy >= 95 ? 'critical' : occupancy >= 85 ? 'warning' : 'ok'}
        />
        <StatTile
          label={t('clinical.ward')}
          value={breaching.length}
          hint={t('clinical.patient')}
          tone={breaching.length > 0 ? 'critical' : 'ok'}
        />
        <StatTile
          label={t('common.filter')}
          value={reorder.data?.length ?? 0}
          tone={(reorder.data?.length ?? 0) > 0 ? 'warning' : 'ok'}
        />
        <StatTile label={t('clinical.patients')} value={totals?.occupied ?? 0} />
      </div>

      <section className="card mb-4">
        <h2 className="mb-2 font-semibold">{t('clinical.ward')}</h2>
        <QueryState isLoading={ratios.isLoading} error={ratios.error} isEmpty={wards.length === 0}>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('clinical.ward')}</th>
                  <th>{t('common.status')}</th>
                  <th className="text-end">{t('clinical.patients')}</th>
                  <th className="text-end">Nurses</th>
                  <th className="text-end">Ratio</th>
                  <th className="text-end">Max</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {wards.map((w) => (
                  <tr key={w.ward} className={w.breaching ? 'bg-red-50' : undefined}>
                    <td className="font-medium">{w.ward}</td>
                    <td className="text-xs uppercase">{w.acuity}</td>
                    <td className="text-end tabular-nums">{w.patients}</td>
                    <td className="text-end tabular-nums">{w.nurses}</td>
                    <td className="text-end tabular-nums font-semibold">{w.actual_ratio ?? '—'}</td>
                    <td className="text-end tabular-nums text-slate-500">
                      {w.max_patients_per_nurse}
                    </td>
                    <td>
                      {w.breaching && (
                        <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">
                          +{w.shortfall_nurses}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>

      <section className="card">
        <h2 className="mb-2 font-semibold">{t('common.filter')}</h2>
        <QueryState
          isLoading={reorder.isLoading}
          error={reorder.error}
          isEmpty={reorder.data?.length === 0}
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('common.notes')}</th>
                  <th className="text-end">On hand</th>
                  <th className="text-end">Safety</th>
                  <th className="text-end">{t('common.submit')}</th>
                </tr>
              </thead>
              <tbody>
                {reorder.data?.map((r) => {
                  const row = r as {
                    item: { id: string; name: string; item_code: string; quantity_on_hand: number; safety_stock: number };
                    suggested_order_quantity: number;
                  };
                  return (
                    <tr key={row.item.id}>
                      <td>
                        {row.item.name}
                        <span className="ms-2 font-mono text-xs text-slate-500">
                          {row.item.item_code}
                        </span>
                      </td>
                      <td className="text-end tabular-nums text-red-700">
                        {row.item.quantity_on_hand}
                      </td>
                      <td className="text-end tabular-nums">{row.item.safety_stock}</td>
                      <td className="text-end tabular-nums font-semibold">
                        {row.suggested_order_quantity}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </QueryState>
      </section>
    </>
  );
}
