'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/session';
import { keys, useApiMutation, useStock, type StockItem } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

/** Days ahead that count as expiring soon, matching the server's nightly sweep. */
const EXPIRY_WARNING_DAYS = 30;

type Band = 'expired' | 'expiring' | 'ok';

function expiryBand(expiry: string | null, now = Date.now()): Band {
  if (!expiry) return 'ok';
  const at = new Date(expiry).getTime();
  if (at <= now) return 'expired';
  return (at - now) / 86_400_000 <= EXPIRY_WARNING_DAYS ? 'expiring' : 'ok';
}

const isLow = (item: StockItem): boolean =>
  item.safety_stock > 0 && item.quantity_on_hand <= item.safety_stock;

/** RFC 4180 quoting: a field containing a quote, comma or newline is wrapped. */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: readonly StockItem[]): string {
  const header = [
    'item_code',
    'name',
    'category',
    'batch_number',
    'expiry_date',
    'quantity_on_hand',
    'safety_stock',
    'unit',
    'unit_cost_minor',
    'currency',
    'is_recalled',
  ];
  const body = rows.map((r) =>
    [
      r.item_code,
      r.name,
      r.category,
      r.batch_number,
      r.expiry_date?.slice(0, 10) ?? '',
      r.quantity_on_hand,
      r.safety_stock,
      r.unit,
      r.unit_cost_minor,
      r.currency,
      r.is_recalled,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...body].join('\r\n');
}

const EMPTY_RECEIPT = {
  item_code: '',
  name: '',
  category: 'medication',
  quantity: '',
  unit: 'unit',
  unit_cost_minor: '0',
  currency: 'AED',
  batch_number: '',
  expiry_date: '',
  supplier_id: '',
  safety_stock: '0',
  reorder_quantity: '0',
  location_id: '',
};

export default function InventoryPage() {
  const { t, date } = useI18n();
  const { can } = usePermissions();

  const [locationId, setLocationId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [receipt, setReceipt] = useState(EMPTY_RECEIPT);
  const [adjusting, setAdjusting] = useState<StockItem | null>(null);
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');

  const params = {
    locationId: locationId || undefined,
    lowStock: lowOnly ? 'true' : undefined,
    limit: '200',
  };
  const stock = useStock(params);

  const receive = useApiMutation<Record<string, unknown>, StockItem>('/inventory/receive', [
    keys.inventory(params),
  ]);
  const adjust = useApiMutation<Record<string, unknown>, unknown>(
    (body) => `/inventory/${body.id as string}`,
    [keys.inventory(params)],
    'patch',
  );

  const rows = useMemo(() => stock.data?.data ?? [], [stock.data]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title={t('clinical.stockList')}
        subtitle={stock.data ? `${stock.data.total}` : undefined}
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={exportCsv}
            disabled={rows.length === 0}
          >
            {t('clinical.exportCsv')}
          </button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label={t('clinical.ward')}>
          <input
            className="input"
            value={locationId}
            placeholder="Location id (all if blank)"
            onChange={(e) => setLocationId(e.target.value.trim())}
          />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          {t('clinical.lowStock')}
        </label>
      </div>

      {can('inventory:manage') && (
        <form
          className="card mb-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            receive.mutate(
              {
                item_code: receipt.item_code,
                name: receipt.name,
                category: receipt.category,
                quantity: Number(receipt.quantity),
                unit: receipt.unit,
                unit_cost_minor: Number(receipt.unit_cost_minor),
                currency: receipt.currency,
                batch_number: receipt.batch_number || undefined,
                expiry_date: receipt.expiry_date || null,
                supplier_id: receipt.supplier_id || null,
                safety_stock: Number(receipt.safety_stock),
                reorder_quantity: Number(receipt.reorder_quantity),
                location_id: receipt.location_id || null,
              },
              { onSuccess: () => setReceipt(EMPTY_RECEIPT) },
            );
          }}
        >
          <h2 className="font-semibold">{t('clinical.receiveStock')}</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('clinical.searchDrug')} required>
              <input
                className="input"
                value={receipt.name}
                onChange={(e) => setReceipt({ ...receipt, name: e.target.value })}
              />
            </Field>
            <Field label="Item code" required>
              <input
                className="input font-mono"
                value={receipt.item_code}
                onChange={(e) => setReceipt({ ...receipt, item_code: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.batch')}>
              <input
                className="input"
                value={receipt.batch_number}
                onChange={(e) => setReceipt({ ...receipt, batch_number: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.expiry')}>
              <input
                type="date"
                className="input"
                value={receipt.expiry_date}
                onChange={(e) => setReceipt({ ...receipt, expiry_date: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.quantity')} required>
              <input
                type="number"
                min="1"
                className="input"
                value={receipt.quantity}
                onChange={(e) => setReceipt({ ...receipt, quantity: e.target.value })}
              />
            </Field>
            <Field label={t('common.unit')} required>
              <input
                className="input"
                value={receipt.unit}
                onChange={(e) => setReceipt({ ...receipt, unit: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.safetyStock')}>
              <input
                type="number"
                min="0"
                className="input"
                value={receipt.safety_stock}
                onChange={(e) => setReceipt({ ...receipt, safety_stock: e.target.value })}
              />
            </Field>
            <Field label={t('clinical.supplier')}>
              <input
                className="input"
                value={receipt.supplier_id}
                placeholder="Supplier id"
                onChange={(e) => setReceipt({ ...receipt, supplier_id: e.target.value })}
              />
            </Field>
          </div>

          <button
            type="submit"
            className="btn-primary"
            disabled={
              receive.isPending ||
              !receipt.item_code ||
              !receipt.name ||
              Number(receipt.quantity) <= 0
            }
          >
            {t('clinical.receiveStock')}
          </button>

          {receive.error && (
            <p className="text-sm text-red-700" role="alert">
              {receive.error.message}
            </p>
          )}
        </form>
      )}

      <QueryState
        isLoading={stock.isLoading}
        error={stock.error}
        isEmpty={rows.length === 0}
        emptyMessage={t('common.noData')}
      >
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('clinical.stockList')}</th>
                <th>{t('clinical.batch')}</th>
                <th className="text-end">{t('clinical.onHand')}</th>
                <th>{t('clinical.expiry')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const band = expiryBand(item.expiry_date);
                const low = isLow(item);
                return (
                  <tr key={item.id} className={clsx(low && 'bg-red-50 dark:bg-red-950/20')}>
                    <td>
                      <span className="font-medium">{item.name}</span>
                      <span className="ms-2 font-mono text-xs text-slate-500">{item.item_code}</span>
                      {item.is_recalled && (
                        <span className="ms-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                          RECALL
                        </span>
                      )}
                    </td>
                    <td className="text-xs">{item.batch_number ?? '—'}</td>
                    <td className="text-end tabular-nums">
                      <span className={clsx(low && 'font-bold text-red-700')}>
                        {item.quantity_on_hand}
                      </span>{' '}
                      <span className="text-xs opacity-70">{item.unit}</span>
                      {low && (
                        <span className="ms-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                          {t('clinical.lowStock')}
                        </span>
                      )}
                    </td>
                    <td className="text-xs">
                      {item.expiry_date ? date(item.expiry_date) : '—'}
                      {band === 'expiring' && (
                        <span className="ms-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
                          {t('clinical.expiringSoon')}
                        </span>
                      )}
                      {band === 'expired' && (
                        <span className="ms-2 rounded bg-red-600 px-1.5 py-0.5 text-xs font-bold text-white">
                          {t('clinical.expired')}
                        </span>
                      )}
                    </td>
                    <td>
                      {can('inventory:manage') && (
                        <button
                          type="button"
                          className="btn-secondary py-1 text-xs"
                          onClick={() => {
                            setAdjusting(item);
                            setCounted(String(item.quantity_on_hand));
                            setReason('');
                            adjust.reset();
                          }}
                        >
                          {t('clinical.adjustStock')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </QueryState>

      {adjusting && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={t('clinical.adjustStock')}
        >
          <form
            className="w-full rounded-t-xl bg-white p-4 shadow-xl sm:max-w-md sm:rounded-xl dark:bg-slate-900"
            onSubmit={(e) => {
              e.preventDefault();
              adjust.mutate(
                { id: adjusting.id, quantity_on_hand: Number(counted), reason },
                { onSuccess: () => setAdjusting(null) },
              );
            }}
          >
            <h2 className="mb-2 font-semibold">{t('clinical.adjustStock')}</h2>
            <p className="mb-3 text-sm">
              {adjusting.name}{' '}
              <span className="font-mono text-xs text-slate-500">{adjusting.item_code}</span>
            </p>

            <Field label={t('clinical.countedQuantity')} required>
              <input
                type="number"
                min="0"
                className="input"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
              />
            </Field>
            <Field label={t('clinical.adjustmentReason')} required>
              <textarea
                className="input min-h-16"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>

            {adjust.error && (
              <p className="mt-2 text-sm text-red-700" role="alert">
                {adjust.error.message}
              </p>
            )}

            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                className="btn-primary flex-1"
                disabled={adjust.isPending || reason.trim().length < 5}
              >
                {t('common.save')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setAdjusting(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
