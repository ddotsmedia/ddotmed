'use client';

/**
 * The custom report builder.
 *
 * The field picker is rendered from the server's own whitelist rather than from a
 * list kept here: the server is the authority on what may be reported, and a UI
 * that offers a field the API will refuse is a UI that teaches people the tool is
 * broken. Anything the server does not publish simply cannot be ticked.
 *
 * Mobile-first — the picker and the filters stack into one column, and the preview
 * table scrolls horizontally rather than forcing the page to.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { API_BASE, ApiError, api, getAccessToken } from '@/lib/api-client';
import { useI18n } from '@/lib/i18n';
import { useReportFields, type ReportFieldDef } from '@/lib/queries';
import { PageHeader, QueryState, Field } from '@/components/ui';

const PREVIEW_ROWS = 100;

interface FilterRow {
  id: string;
  field: string;
  operator: string;
  value: string;
}

interface ReportResult {
  source: string;
  columns: Array<{ key: string; label: string }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  grouped_by: string | null;
  contains_phi: boolean;
  generated_at: string;
}

interface ExportUrlResult {
  delivery: 'url';
  download_url: string;
  expires_at: string;
  row_count: number;
  truncated: boolean;
}

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());

export default function ReportsPage() {
  const { t } = useI18n();
  const catalogue = useReportFields();

  const [source, setSource] = useState('encounters');
  const [selected, setSelected] = useState<string[]>([]);
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [groupBy, setGroupBy] = useState('');
  const [from, setFrom] = useState(() => isoDay(-30));
  const [to, setTo] = useState(() => isoDay(0));
  const [result, setResult] = useState<ReportResult | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const sources = catalogue.data?.sources ?? [];
  const fields: ReportFieldDef[] = useMemo(
    () => sources.find((s) => s.source === source)?.fields ?? [],
    [sources, source],
  );
  const operators = catalogue.data?.operators ?? [];

  // Changing source invalidates every field choice made against the old one.
  useEffect(() => {
    setSelected([]);
    setFilters([]);
    setGroupBy('');
    setResult(null);
  }, [source]);

  // Default to the first few columns so the builder is usable immediately.
  // The functional updater reads the current selection without depending on it,
  // so clearing every checkbox by hand does not silently refill the list.
  useEffect(() => {
    if (!fields.length) return;
    setSelected((current) => (current.length ? current : fields.slice(0, 4).map((f) => f.key)));
  }, [fields]);

  const body = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      source,
      fields: selected,
      filters: filters
        .filter((f) => f.field && f.value !== '')
        .map((f) => ({
          field: f.field,
          operator: f.operator,
          value: f.operator === 'in' ? f.value.split(',').map((v) => v.trim()).filter(Boolean) : f.value,
        })),
      date_range: { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` },
      group_by: groupBy || null,
      ...extra,
    }),
    [source, selected, filters, from, to, groupBy],
  );

  const runReport = useMutation<ReportResult, Error>({
    mutationFn: () => api.post<ReportResult>('/analytics/reports/custom', body({ limit: PREVIEW_ROWS })),
    onSuccess: (data) => {
      setResult(data);
      setExportNote(null);
    },
  });

  /**
   * Export goes through `fetch` rather than the JSON helper because the response
   * is either a JSON envelope carrying a MinIO link or the file itself — and the
   * inline case has to reach `saveAs` as bytes, not be parsed.
   */
  const runExport = useMutation<void, Error, 'csv' | 'pdf'>({
    mutationFn: async (format) => {
      const token = getAccessToken();
      const response = await fetch(`${API_BASE}/analytics/reports/export`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body({ format })),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new ApiError(
          response.status,
          undefined,
          payload?.message ?? `Export failed with ${response.status}`,
          payload,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const stored = (await response.json()) as ExportUrlResult;
        window.open(stored.download_url, '_blank', 'noopener,noreferrer');
        setExportNote(
          `${stored.row_count} row${stored.row_count === 1 ? '' : 's'} exported. The link expires ${new Date(
            stored.expires_at,
          ).toLocaleTimeString()}.`,
        );
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${source}-report.${format === 'pdf' ? 'html' : 'csv'}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportNote(
        format === 'pdf'
          ? 'Downloaded a printable page — open it and use Print → Save as PDF.'
          : `Downloaded ${response.headers.get('x-report-rows') ?? ''} rows.`,
      );
    },
  });

  const toggleField = (key: string) =>
    setSelected((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );

  const canRun = selected.length > 0 && !runReport.isPending;
  const groupable = fields.filter((f) => f.groupable);
  const phiSelected = fields.some((f) => f.phi && selected.includes(f.key)) && !groupBy;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Build an extract from the fields this system permits"
      />

      <QueryState isLoading={catalogue.isLoading} error={catalogue.error}>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
          <div className="space-y-4">
            <section className="card">
              <Field label="Data source">
                <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                  {sources.map((s) => (
                    <option key={s.source} value={s.source}>
                      {s.source.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="From">
                  <input
                    type="date"
                    className="input"
                    value={from}
                    max={to}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </Field>
                <Field label="To">
                  <input
                    type="date"
                    className="input"
                    value={to}
                    min={from}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Group by">
                <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  <option value="">No grouping</option>
                  {groupable.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
            </section>

            <section className="card">
              <h2 className="mb-2 font-semibold">Fields</h2>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {fields.map((field) => (
                  <li key={field.key}>
                    <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                      <input
                        type="checkbox"
                        checked={selected.includes(field.key)}
                        onChange={() => toggleField(field.key)}
                      />
                      <span className="flex-1">{field.label}</span>
                      {field.phi && (
                        <span
                          className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900"
                          title="Identifies a patient"
                        >
                          PHI
                        </span>
                      )}
                      <span className="text-[10px] uppercase text-slate-400">{field.kind}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                {selected.length} selected. Only fields this server publishes can be reported on.
              </p>
            </section>

            <section className="card">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-semibold">Filters</h2>
                <button
                  type="button"
                  className="btn-secondary py-1 text-xs"
                  onClick={() =>
                    setFilters((current) => [
                      ...current,
                      { id: newId(), field: fields[0]?.key ?? '', operator: 'eq', value: '' },
                    ])
                  }
                  disabled={fields.length === 0}
                >
                  + Add
                </button>
              </div>

              {filters.length === 0 && (
                <p className="text-xs text-slate-500">No filters — the date range still applies.</p>
              )}

              <ul className="space-y-2">
                {filters.map((filter) => (
                  <li key={filter.id} className="grid grid-cols-[1fr_auto] gap-2">
                    <div className="grid gap-1">
                      <select
                        className="input py-1 text-xs"
                        value={filter.field}
                        onChange={(e) =>
                          setFilters((c) =>
                            c.map((f) => (f.id === filter.id ? { ...f, field: e.target.value } : f)),
                          )
                        }
                      >
                        {fields.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <div className="grid grid-cols-[auto_1fr] gap-1">
                        <select
                          className="input w-auto py-1 text-xs"
                          value={filter.operator}
                          onChange={(e) =>
                            setFilters((c) =>
                              c.map((f) =>
                                f.id === filter.id ? { ...f, operator: e.target.value } : f,
                              ),
                            )
                          }
                        >
                          {operators.map((op) => (
                            <option key={op} value={op}>
                              {op}
                            </option>
                          ))}
                        </select>
                        <input
                          className="input py-1 text-xs"
                          placeholder={filter.operator === 'in' ? 'a, b, c' : 'value'}
                          value={filter.value}
                          onChange={(e) =>
                            setFilters((c) =>
                              c.map((f) => (f.id === filter.id ? { ...f, value: e.target.value } : f)),
                            )
                          }
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="self-start text-xs text-red-700 underline"
                      onClick={() => setFilters((c) => c.filter((f) => f.id !== filter.id))}
                    >
                      {t('common.delete')}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <button type="button" className="btn-primary w-full" disabled={!canRun} onClick={() => runReport.mutate()}>
              {runReport.isPending ? 'Running…' : 'Run report'}
            </button>
          </div>

          <div className="min-w-0">
            {runReport.isError && (
              <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {runReport.error.message}
              </p>
            )}
            {runExport.isError && (
              <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {runExport.error.message}
              </p>
            )}
            {exportNote && (
              <p className="mb-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
                {exportNote}
              </p>
            )}

            {!result ? (
              <div className="card text-center text-sm text-slate-500">
                Pick your fields and run the report to see a preview.
              </div>
            ) : (
              <section className="card">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">
                    Preview
                    <span className="ms-2 text-xs font-normal text-slate-500">
                      {result.row_count} row{result.row_count === 1 ? '' : 's'}
                      {result.truncated && ` (capped at ${PREVIEW_ROWS})`}
                    </span>
                  </h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary py-1 text-xs"
                      onClick={() => runExport.mutate('csv')}
                      disabled={runExport.isPending}
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      className="btn-secondary py-1 text-xs"
                      onClick={() => runExport.mutate('pdf')}
                      disabled={runExport.isPending}
                    >
                      Export PDF
                    </button>
                  </div>
                </div>

                {phiSelected && (
                  <p className="mb-2 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    This extract identifies patients. Exporting it is recorded in the audit log.
                  </p>
                )}
                {result.truncated && (
                  <p className="mb-2 rounded bg-sky-50 px-3 py-2 text-xs text-sky-900">
                    The preview stops at {PREVIEW_ROWS} rows. An export returns the full result, up to
                    10 000 rows.
                  </p>
                )}

                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        {result.columns.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, index) => (
                        <tr key={index}>
                          {result.columns.map((column) => (
                            <td key={column.key} className="whitespace-nowrap text-xs">
                              {row[column.key] === null || row[column.key] === undefined
                                ? '—'
                                : String(row[column.key])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {result.rows.length === 0 && (
                  <p className="py-6 text-center text-sm text-slate-500">
                    Nothing matched. Widen the date range or drop a filter.
                  </p>
                )}
              </section>
            )}
          </div>
        </div>
      </QueryState>
    </>
  );
}
