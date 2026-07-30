'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { api } from '@/lib/api-client';
import { keys, useApiMutation, useServiceRequests, type LabOrder } from '@/lib/queries';
import { QueryState, Field } from '@/components/ui';

/**
 * Common bench tests, keyed by LOINC.
 *
 * Typing a LOINC code from memory is how the wrong test gets ordered, so the
 * search is over names and the code is carried behind it. A site with its own
 * catalogue can still order anything by typing the code directly.
 */
const COMMON_TESTS: ReadonlyArray<{ loinc: string; name: string; fasting?: boolean }> = [
  { loinc: '718-7', name: 'Haemoglobin' },
  { loinc: '6690-2', name: 'White cell count' },
  { loinc: '777-3', name: 'Platelet count' },
  { loinc: '4544-3', name: 'Haematocrit' },
  { loinc: '2345-7', name: 'Glucose', fasting: true },
  { loinc: '4548-4', name: 'HbA1c' },
  { loinc: '2160-0', name: 'Creatinine' },
  { loinc: '3094-0', name: 'Urea nitrogen' },
  { loinc: '2823-3', name: 'Potassium' },
  { loinc: '2951-2', name: 'Sodium' },
  { loinc: '2075-0', name: 'Chloride' },
  { loinc: '17861-6', name: 'Calcium' },
  { loinc: '1742-6', name: 'ALT' },
  { loinc: '1920-8', name: 'AST' },
  { loinc: '1975-2', name: 'Bilirubin total' },
  { loinc: '3016-3', name: 'TSH' },
  { loinc: '1988-5', name: 'C-reactive protein' },
  { loinc: '10839-9', name: 'Troponin I' },
  { loinc: '6301-6', name: 'INR' },
  { loinc: '5902-2', name: 'Prothrombin time' },
  { loinc: '2524-7', name: 'Lactate' },
  { loinc: '33762-6', name: 'NT-proBNP' },
];

const PRIORITIES = ['routine', 'urgent', 'asap', 'stat'] as const;

const STATUS_TONE: Record<string, string> = {
  active: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  on_hold: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  revoked: 'bg-slate-200 text-slate-600 line-through dark:bg-slate-800 dark:text-slate-400',
};

const PRIORITY_TONE: Record<string, string> = {
  stat: 'bg-red-600 text-white',
  asap: 'bg-orange-500 text-white',
  urgent: 'bg-amber-200 text-amber-900',
  routine: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

/** Opens the browser print dialog on a label-sized window. */
function printLabel(label: Record<string, unknown>): void {
  const win = window.open('', '_blank', 'width=420,height=280');
  if (!win) return;
  const line = (value: unknown) => String(value ?? '');
  win.document.write(`<!doctype html><html><head><title>${line(label.order_number)}</title>
<style>
  body { font-family: ui-monospace, monospace; margin: 8px; }
  .big { font-size: 15px; font-weight: 700; }
  .code { font-size: 20px; letter-spacing: 3px; }
  .flag { font-weight: 700; text-transform: uppercase; }
</style></head><body>
  <div class="big">${line(label.patient_name)}</div>
  <div>MRN ${line(label.mrn)}</div>
  <div class="big">${line(label.test_name)}</div>
  <div class="code">${line(label.barcode)}</div>
  <div>${line(label.order_number)}</div>
  ${label.priority !== 'routine' ? `<div class="flag">${line(label.priority)}</div>` : ''}
  ${label.fasting_required ? '<div class="flag">FASTING</div>' : ''}
  <div>${line(label.printed_at)}</div>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

export function LabOrdersTab({
  patientId,
  encounterId,
}: {
  patientId: string;
  encounterId?: string;
}) {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [query, setQuery] = useState('');
  const [test, setTest] = useState<{ loinc: string; name: string } | null>(null);
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('routine');
  const [fasting, setFasting] = useState(false);
  const [notes, setNotes] = useState('');
  const [printing, setPrinting] = useState<string | null>(null);

  const params = { patientId: patientId || undefined, encounterId: encounterId || undefined };
  const orders = useServiceRequests({ ...params, category: 'laboratory' });

  const create = useApiMutation<Record<string, unknown>, LabOrder & { barcode_id: string }>(
    '/service-requests',
    [keys.serviceRequests({ ...params, category: 'laboratory' }), keys.labWorklist()],
  );
  // Cancelling needs a documented reason — the server refuses without one.
  const cancel = useApiMutation<{ orderId: string; status: 'revoked'; reason: string }, unknown>(
    (body) => `/service-requests/${body.orderId}`,
    [keys.serviceRequests({ ...params, category: 'laboratory' }), keys.labWorklist()],
    'patch',
  );

  const matches = query.trim().length
    ? COMMON_TESTS.filter(
        (candidate) =>
          candidate.name.toLowerCase().includes(query.trim().toLowerCase()) ||
          candidate.loinc.startsWith(query.trim()),
      ).slice(0, 8)
    : [];

  const label = async (orderId: string) => {
    setPrinting(orderId);
    try {
      const fields = await api.get<Record<string, unknown>>(`/service-requests/${orderId}/label`);
      printLabel(fields);
    } finally {
      setPrinting(null);
    }
  };

  return (
    <div className="space-y-4">
      {can('lab:order') && (
        <form
          className="card space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!test || !patientId) return;
            create.mutate(
              {
                patient_id: patientId,
                encounter_id: encounterId || null,
                loinc_code: test.loinc,
                test_name: test.name,
                priority,
                fasting_required: fasting,
                clinical_notes: notes || undefined,
              },
              {
                onSuccess: () => {
                  setTest(null);
                  setQuery('');
                  setNotes('');
                  setFasting(false);
                  setPriority('routine');
                },
              },
            );
          }}
        >
          <h2 className="font-semibold">{t('clinical.newLabOrder')}</h2>

          {!test ? (
            <>
              <label className="block">
                <span className="label">{t('clinical.loincSearch')}</span>
                <input
                  type="search"
                  className="input"
                  value={query}
                  autoComplete="off"
                  placeholder="potassium / 2823-3"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              {matches.length > 0 && (
                <ul className="max-h-56 overflow-y-auto rounded border border-slate-200 dark:border-slate-700">
                  {matches.map((candidate) => (
                    <li
                      key={candidate.loinc}
                      className="border-b border-slate-100 last:border-b-0 dark:border-slate-800"
                    >
                      <button
                        type="button"
                        className="w-full p-2 text-start text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                        onClick={() => {
                          setTest({ loinc: candidate.loinc, name: candidate.name });
                          setFasting(Boolean(candidate.fasting));
                        }}
                      >
                        {candidate.name}
                        <span className="ms-2 font-mono text-xs text-slate-500">{candidate.loinc}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded border border-slate-300 px-2 py-1 dark:border-slate-600">
              <span className="text-sm font-medium">{test.name}</span>
              <span className="font-mono text-xs text-slate-500">{test.loinc}</span>
              <button
                type="button"
                className="ms-auto text-xs underline"
                onClick={() => {
                  setTest(null);
                  setQuery('');
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('clinical.priority')}>
              <select
                className="input"
                value={priority}
                onChange={(e) => setPriority(e.target.value as (typeof PRIORITIES)[number])}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('clinical.fastingRequired')}>
              <select
                className="input"
                value={fasting ? 'true' : 'false'}
                onChange={(e) => setFasting(e.target.value === 'true')}
              >
                <option value="false">{t('common.no')}</option>
                <option value="true">{t('common.yes')}</option>
              </select>
            </Field>
          </div>

          <Field label={t('common.notes')}>
            <textarea
              className="input min-h-16"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <button
            type="submit"
            className="btn-primary"
            disabled={!test || !patientId || create.isPending}
          >
            {t('clinical.newLabOrder')}
          </button>

          {create.error && (
            <p className="text-sm text-red-700" role="alert">
              {create.error.message}
            </p>
          )}
          {create.data && (
            <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              {t('clinical.orderPlaced')} — {create.data.order_number} ·{' '}
              <span className="font-mono">{create.data.barcode_id}</span>
            </p>
          )}
        </form>
      )}

      <section className="card">
        <h2 className="mb-2 font-semibold">{t('clinical.pendingOrders')}</h2>
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={orders.data?.length === 0}
          emptyMessage={t('common.noData')}
        >
          <ul className="space-y-2">
            {orders.data?.map((order) => (
              <li
                key={order.id}
                className="rounded border border-slate-200 p-2 text-sm dark:border-slate-700"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{order.code_display}</span>
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-xs font-semibold',
                      PRIORITY_TONE[order.priority] ?? PRIORITY_TONE.routine,
                    )}
                  >
                    {order.priority}
                  </span>
                  <span
                    className={clsx(
                      'rounded px-1.5 py-0.5 text-xs font-medium',
                      STATUS_TONE[order.status] ?? STATUS_TONE.active,
                    )}
                  >
                    {order.status}
                  </span>
                  {order.fasting_required && (
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-semibold text-violet-900">
                      {t('clinical.fastingRequired')}
                    </span>
                  )}
                </div>

                <p className="mt-0.5 text-xs text-slate-500">
                  {order.order_number} ·{' '}
                  <span className="font-mono">{order.barcode ?? '—'}</span> ·{' '}
                  {date(order.created_at, true)}
                </p>
                {order.clinical_notes && <p className="mt-0.5 text-xs">{order.clinical_notes}</p>}

                {can('lab:order') && order.status !== 'revoked' && order.status !== 'completed' && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary py-1 text-xs"
                      onClick={() => void label(order.id)}
                      disabled={printing === order.id}
                    >
                      🖨 {t('clinical.printLabel')}
                    </button>
                    <button
                      type="button"
                      className="text-xs text-red-700 underline"
                      onClick={() =>
                        cancel.mutate({
                          orderId: order.id,
                          status: 'revoked',
                          reason: 'Cancelled by the ordering clinician',
                        })
                      }
                      disabled={cancel.isPending}
                    >
                      {t('clinical.cancelOrder')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </QueryState>
        {cancel.error && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {cancel.error.message}
          </p>
        )}
      </section>
    </div>
  );
}
