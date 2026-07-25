'use client';

import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useDenialQueue } from '@/lib/queries';
import { PageHeader, QueryState } from '@/components/ui';

export default function ClaimsPage() {
  const { t, money, date } = useI18n();
  const { can } = usePermissions();
  const denials = useDenialQueue();

  const appeal = useApiMutation<{ claimId: string; notes: string }, unknown>(
    (body) => `/insurance/claims/${body.claimId}/appeal`,
    [keys.denials()],
  );

  return (
    <>
      <PageHeader title={t('billing.claims')} subtitle={t('billing.denial')} />

      <QueryState
        isLoading={denials.isLoading}
        error={denials.error}
        isEmpty={denials.data?.data.length === 0}
      >
        <div className="card overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('billing.claim')}</th>
                <th>{t('billing.payer')}</th>
                <th className="text-end">{t('billing.amount')}</th>
                <th className="text-end">{t('billing.paid')}</th>
                <th>{t('billing.denialRisk')}</th>
                <th>{t('common.status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {denials.data?.data.map((c) => {
                const claim = c as Record<string, unknown>;
                const payer = claim.payer as { name?: string } | undefined;
                const currency = String(claim.currency);
                const risk = claim.denial_risk === null ? null : Number(claim.denial_risk);
                const codes = (claim.denial_reason_codes ?? []) as string[];
                return (
                  <tr key={String(claim.id)}>
                    <td className="font-mono text-xs">{String(claim.claim_number)}</td>
                    <td className="text-sm">{payer?.name}</td>
                    <td className="text-end tabular-nums">
                      {money(Number(claim.claimed_minor), currency)}
                    </td>
                    <td className="text-end tabular-nums">
                      {money(Number(claim.paid_minor), currency)}
                    </td>
                    <td>
                      {risk !== null && (
                        <span
                          className={
                            risk >= 0.6
                              ? 'rounded bg-red-100 px-1.5 text-xs font-semibold text-red-800'
                              : risk >= 0.3
                                ? 'rounded bg-amber-100 px-1.5 text-xs text-amber-800'
                                : 'text-xs text-slate-500'
                          }
                          title={((claim.denial_risk_factors ?? []) as string[]).join(', ')}
                        >
                          {(risk * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="text-xs">{String(claim.status)}</span>
                      {codes.length > 0 && (
                        <div className="font-mono text-[10px] text-red-700">{codes.join(', ')}</div>
                      )}
                      {Boolean(claim.adjudicated_at) && (
                        <div className="text-[10px] text-slate-500">
                          {date(String(claim.adjudicated_at))}
                        </div>
                      )}
                    </td>
                    <td>
                      {can('claim:write') && claim.status !== 'appealed' && (
                        <button
                          type="button"
                          className="btn-secondary py-1 text-xs"
                          onClick={() =>
                            appeal.mutate({
                              claimId: String(claim.id),
                              notes: 'Resubmitted with corrected documentation',
                            })
                          }
                          disabled={appeal.isPending}
                        >
                          {t('common.submit')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {appeal.error && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {appeal.error.message}
          </p>
        )}
      </QueryState>
    </>
  );
}
