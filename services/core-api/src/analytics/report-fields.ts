/**
 * The custom report builder's whitelist.
 *
 * This file is the security boundary of the reporting feature. A report builder
 * that passes client-named columns into a query is an arbitrary-read primitive
 * over a database holding every patient's record — so nothing here is derived
 * from the request. A field is usable only if it is named below, and the column
 * that ends up in the query is the one this table supplies, never the string the
 * client sent.
 *
 * Deliberately excluded, and worth stating explicitly: password hashes, MFA
 * secrets, session tokens, note bodies, and free-text clinical narrative. A
 * report is an aggregate instrument; it is not a way to read a chart.
 */
import { BadRequestException } from '@nestjs/common';

/** Which table a report runs over. */
export type ReportSource = 'encounters' | 'admissions' | 'invoices' | 'appointments' | 'lab_results';

export type FieldKind = 'string' | 'number' | 'date' | 'boolean';

export interface ReportField {
  /** The name the client uses. */
  key: string;
  /** The Prisma path this resolves to. Dotted paths cross exactly one relation. */
  path: string;
  label: string;
  kind: FieldKind;
  /** Groupable fields are the ones that make sense as a bucket. */
  groupable?: boolean;
  /** Summable fields are integer minor units or counts. */
  summable?: boolean;
  /**
   * True when the value identifies a person. Present so the export can be
   * labelled and audited as PHI rather than treated as an anonymous extract.
   */
  phi?: boolean;
}

const FIELD_LIST: Record<ReportSource, readonly ReportField[]> = {
  encounters: [
    { key: 'encounter_id', path: 'id', label: 'Encounter ID', kind: 'string' },
    { key: 'mrn', path: 'patient.mrn', label: 'MRN', kind: 'string', phi: true },
    { key: 'patient_name', path: 'patient.family_name', label: 'Patient', kind: 'string', phi: true },
    { key: 'status', path: 'status', label: 'Status', kind: 'string', groupable: true },
    { key: 'class', path: 'class', label: 'Class', kind: 'string', groupable: true },
    { key: 'type_display', path: 'type_display', label: 'Type', kind: 'string', groupable: true },
    { key: 'period_start', path: 'period_start', label: 'Start', kind: 'date' },
    { key: 'period_end', path: 'period_end', label: 'End', kind: 'date' },
    { key: 'triage_level', path: 'triage_level', label: 'Triage level', kind: 'number', groupable: true },
    { key: 'discharge_disposition', path: 'discharge_disposition', label: 'Disposition', kind: 'string', groupable: true },
  ],
  admissions: [
    { key: 'admission_id', path: 'id', label: 'Admission ID', kind: 'string' },
    { key: 'admission_number', path: 'admission_number', label: 'Admission no.', kind: 'string' },
    { key: 'mrn', path: 'patient.mrn', label: 'MRN', kind: 'string', phi: true },
    { key: 'patient_name', path: 'patient.family_name', label: 'Patient', kind: 'string', phi: true },
    { key: 'status', path: 'status', label: 'Status', kind: 'string', groupable: true },
    { key: 'admission_type', path: 'admission_type', label: 'Type', kind: 'string', groupable: true },
    { key: 'ward', path: 'bed.ward', label: 'Ward', kind: 'string', groupable: true },
    { key: 'bed_number', path: 'bed.bed_number', label: 'Bed', kind: 'string' },
    { key: 'admitted_at', path: 'admitted_at', label: 'Admitted', kind: 'date' },
    { key: 'discharged_at', path: 'discharged_at', label: 'Discharged', kind: 'date' },
    { key: 'discharge_disposition', path: 'discharge_disposition', label: 'Disposition', kind: 'string', groupable: true },
  ],
  invoices: [
    { key: 'invoice_id', path: 'id', label: 'Invoice ID', kind: 'string' },
    { key: 'invoice_number', path: 'invoice_number', label: 'Invoice no.', kind: 'string' },
    { key: 'mrn', path: 'patient.mrn', label: 'MRN', kind: 'string', phi: true },
    { key: 'status', path: 'status', label: 'Status', kind: 'string', groupable: true },
    { key: 'payer_type', path: 'payer_type', label: 'Payer type', kind: 'string', groupable: true },
    { key: 'currency', path: 'currency', label: 'Currency', kind: 'string', groupable: true },
    { key: 'total_minor', path: 'total_minor', label: 'Total', kind: 'number', summable: true },
    { key: 'paid_minor', path: 'paid_minor', label: 'Paid', kind: 'number', summable: true },
    { key: 'balance_minor', path: 'balance_minor', label: 'Balance', kind: 'number', summable: true },
    { key: 'issued_at', path: 'issued_at', label: 'Issued', kind: 'date' },
    { key: 'due_at', path: 'due_at', label: 'Due', kind: 'date' },
  ],
  appointments: [
    { key: 'appointment_id', path: 'id', label: 'Appointment ID', kind: 'string' },
    { key: 'mrn', path: 'patient.mrn', label: 'MRN', kind: 'string', phi: true },
    { key: 'status', path: 'status', label: 'Status', kind: 'string', groupable: true },
    { key: 'service_type', path: 'service_type', label: 'Service', kind: 'string', groupable: true },
    { key: 'specialty', path: 'specialty', label: 'Specialty', kind: 'string', groupable: true },
    { key: 'channel', path: 'channel', label: 'Channel', kind: 'string', groupable: true },
    { key: 'is_telehealth', path: 'is_telehealth', label: 'Telehealth', kind: 'boolean', groupable: true },
    { key: 'start', path: 'start', label: 'Start', kind: 'date' },
    { key: 'minutes_duration', path: 'minutes_duration', label: 'Minutes', kind: 'number', summable: true },
  ],
  lab_results: [
    { key: 'result_id', path: 'id', label: 'Result ID', kind: 'string' },
    { key: 'mrn', path: 'patient.mrn', label: 'MRN', kind: 'string', phi: true },
    { key: 'loinc_code', path: 'loinc_code', label: 'LOINC', kind: 'string', groupable: true },
    { key: 'display', path: 'display', label: 'Test', kind: 'string', groupable: true },
    { key: 'status', path: 'status', label: 'Status', kind: 'string', groupable: true },
    { key: 'interpretation', path: 'interpretation', label: 'Interpretation', kind: 'string', groupable: true },
    { key: 'is_critical', path: 'is_critical', label: 'Critical', kind: 'boolean', groupable: true },
    { key: 'unit', path: 'unit', label: 'Unit', kind: 'string', groupable: true },
    { key: 'performed_at', path: 'performed_at', label: 'Performed', kind: 'date' },
  ],
};

export const REPORT_SOURCES = Object.keys(FIELD_LIST) as ReportSource[];

/** The column each source's date range filters on. */
export const SOURCE_DATE_FIELD: Record<ReportSource, string> = {
  encounters: 'period_start',
  admissions: 'admitted_at',
  invoices: 'created_at',
  appointments: 'start',
  lab_results: 'performed_at',
};

/** The Prisma model delegate each source maps to. */
export const SOURCE_MODEL: Record<ReportSource, string> = {
  encounters: 'encounter',
  admissions: 'admission',
  invoices: 'invoice',
  appointments: 'appointment',
  lab_results: 'labResult',
};

/** Relations a source may include, so a dotted field path can resolve. */
export const SOURCE_RELATIONS: Record<ReportSource, Record<string, Record<string, boolean>>> = {
  encounters: { patient: { mrn: true, given_names: true, family_name: true } },
  admissions: {
    patient: { mrn: true, given_names: true, family_name: true },
    bed: { ward: true, bed_number: true },
  },
  invoices: { patient: { mrn: true, given_names: true, family_name: true } },
  appointments: { patient: { mrn: true, given_names: true, family_name: true } },
  lab_results: { patient: { mrn: true, given_names: true, family_name: true } },
};

export function isReportSource(value: unknown): value is ReportSource {
  return typeof value === 'string' && value in FIELD_LIST;
}

export function fieldsFor(source: ReportSource): readonly ReportField[] {
  return FIELD_LIST[source];
}

/** The catalogue the report builder UI renders its checklist from. */
export function fieldCatalogue(): Array<{
  source: ReportSource;
  date_field: string;
  fields: readonly ReportField[];
}> {
  return REPORT_SOURCES.map((source) => ({
    source,
    date_field: SOURCE_DATE_FIELD[source],
    fields: FIELD_LIST[source],
  }));
}

/**
 * Resolves requested field keys, refusing anything not on the list.
 *
 * Rejects rather than silently dropping. A report that quietly returns fewer
 * columns than were asked for gets read as though the missing data did not exist.
 */
export function resolveFields(source: ReportSource, keys: readonly string[]): ReportField[] {
  const known = new Map(FIELD_LIST[source].map((f) => [f.key, f]));
  const unknown = keys.filter((key) => !known.has(key));

  if (unknown.length > 0) {
    throw new BadRequestException({
      code: 'UNKNOWN_REPORT_FIELD',
      message: `Not a reportable field on ${source}: ${unknown.join(', ')}`,
      unknown_fields: unknown,
      allowed_fields: [...known.keys()],
    });
  }

  // Duplicates collapse; the order the client asked for is the column order.
  const seen = new Set<string>();
  return keys
    .filter((key) => (seen.has(key) ? false : (seen.add(key), true)))
    .map((key) => known.get(key)!);
}

// ── filters ───────────────────────────────────────────────────────────────────

export const FILTER_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface ReportFilter {
  field: string;
  operator: FilterOperator;
  value: string | number | boolean | Array<string | number>;
}

export function isFilterOperator(value: unknown): value is FilterOperator {
  return typeof value === 'string' && (FILTER_OPERATORS as readonly string[]).includes(value);
}

/** Operators that make no sense on a given kind are refused, not coerced. */
const OPERATORS_BY_KIND: Record<FieldKind, readonly FilterOperator[]> = {
  string: ['eq', 'ne', 'contains', 'in'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq', 'ne'],
};

function coerce(field: ReportField, raw: unknown): unknown {
  if (field.kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new BadRequestException(`${field.key} takes a number, not "${String(raw)}"`);
    }
    return n;
  }
  if (field.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new BadRequestException(`${field.key} takes true or false, not "${String(raw)}"`);
  }
  if (field.kind === 'date') {
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field.key} takes a date, not "${String(raw)}"`);
    }
    return d;
  }
  return String(raw);
}

/** Nests `{a: {b: v}}` for a dotted path, which is the shape Prisma `where` takes. */
function nest(path: string, leaf: unknown): Record<string, unknown> {
  const parts = path.split('.');
  return parts.reduceRight<unknown>((acc, part) => ({ [part]: acc }), leaf) as Record<
    string,
    unknown
  >;
}

/**
 * Translates client filters into a Prisma `where` fragment.
 *
 * Every field is resolved through the whitelist first, so the key on the left of
 * a comparison is always one this file chose. `contains` is case-insensitive
 * because nobody searching a report types the casing the database happens to hold.
 */
export function buildWhere(source: ReportSource, filters: readonly ReportFilter[]): Record<string, unknown>[] {
  const known = new Map(FIELD_LIST[source].map((f) => [f.key, f]));

  return filters.map((filter) => {
    const field = known.get(filter.field);
    if (!field) {
      throw new BadRequestException({
        code: 'UNKNOWN_REPORT_FIELD',
        message: `Not a filterable field on ${source}: ${filter.field}`,
        unknown_fields: [filter.field],
        allowed_fields: [...known.keys()],
      });
    }

    if (!isFilterOperator(filter.operator)) {
      throw new BadRequestException(`Unsupported operator: ${String(filter.operator)}`);
    }
    if (!OPERATORS_BY_KIND[field.kind].includes(filter.operator)) {
      throw new BadRequestException(
        `${filter.operator} cannot be applied to ${field.key}, which is a ${field.kind}`,
      );
    }

    if (filter.operator === 'in') {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      if (list.length === 0) throw new BadRequestException(`${field.key} in [] matches nothing`);
      if (list.length > 100) throw new BadRequestException(`${field.key} in [...] takes at most 100 values`);
      return nest(field.path, { in: list.map((v) => coerce(field, v)) });
    }

    const value = coerce(field, Array.isArray(filter.value) ? filter.value[0] : filter.value);

    if (filter.operator === 'contains') {
      return nest(field.path, { contains: value, mode: 'insensitive' });
    }
    if (filter.operator === 'eq') return nest(field.path, value);
    if (filter.operator === 'ne') return nest(field.path, { not: value });
    return nest(field.path, { [filter.operator]: value });
  });
}

/** Reads a dotted path off a result row, tolerating a null relation. */
export function readPath(row: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return null;
    return (acc as Record<string, unknown>)[part] ?? null;
  }, row);
}

/** The `select` a source needs to satisfy the requested fields, and nothing more. */
export function selectFor(source: ReportSource, fields: readonly ReportField[]): Record<string, unknown> {
  const select: Record<string, unknown> = {};

  for (const field of fields) {
    const [head, tail] = field.path.split('.');
    if (!tail) {
      select[head] = true;
      continue;
    }
    const relation = SOURCE_RELATIONS[source][head];
    if (!relation) continue;
    const existing = (select[head] as { select?: Record<string, boolean> } | undefined)?.select ?? {};
    select[head] = { select: { ...existing, [tail]: true } };
  }

  return select;
}

/** Flattens a row to the requested columns, keyed by the client's field names. */
export function shapeRow(
  row: Record<string, unknown>,
  fields: readonly ReportField[],
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  for (const field of fields) {
    const value = readPath(row, field.path);
    shaped[field.key] = value instanceof Date ? value.toISOString() : value;
  }
  return shaped;
}

// ── grouping ──────────────────────────────────────────────────────────────────

export interface GroupedRow {
  group: string;
  count: number;
  [key: string]: unknown;
}

/**
 * Collapses rows onto a group key, counting rows and summing every summable field.
 *
 * Done in code rather than as a `groupBy` because the group key may sit across a
 * relation — ward lives on the bed, not the admission — and Prisma cannot group by
 * a joined column. The row cap is applied before this runs, so the input is
 * bounded.
 */
export function groupRows(
  rows: readonly Record<string, unknown>[],
  groupField: ReportField,
  fields: readonly ReportField[],
): GroupedRow[] {
  const summable = fields.filter((f) => f.summable);
  const groups = new Map<string, GroupedRow>();

  for (const row of rows) {
    const raw = row[groupField.key];
    const key = raw === null || raw === undefined || raw === '' ? '—' : String(raw);
    const group = groups.get(key) ?? { group: key, count: 0 };
    group.count += 1;
    for (const field of summable) {
      const value = Number(row[field.key] ?? 0);
      group[field.key] = Number(group[field.key] ?? 0) + (Number.isFinite(value) ? value : 0);
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/**
 * Escapes one CSV cell.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote: spreadsheet software
 * treats those as formulas, and a report full of patient-supplied text is exactly
 * where a formula-injection payload would be waiting.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** A whole CSV document, header first. CRLF because Excel still wants it. */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly { key: string; label: string }[],
): string {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(','));
  return [header, ...body].join('\r\n') + '\r\n';
}

/** Escapes text for interpolation into the printable HTML export. */
export function htmlEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A self-contained printable document.
 *
 * The PDF path is a print stylesheet rather than a headless browser: shipping
 * Chromium into a clinical container to render a table is a large attack surface
 * and a large image for a job the browser's own print pipeline already does. The
 * page carries `@page` sizing and repeating table headers, so Print → Save as PDF
 * produces a properly paginated document.
 */
export function toPrintableHtml(input: {
  title: string;
  subtitle?: string;
  rows: readonly Record<string, unknown>[];
  columns: readonly { key: string; label: string }[];
  generatedAt: Date;
  truncated: boolean;
}): string {
  const head = input.columns.map((c) => `<th>${htmlEscape(c.label)}</th>`).join('');
  const body = input.rows
    .map(
      (row) =>
        `<tr>${input.columns.map((c) => `<td>${htmlEscape(row[c.key])}</td>`).join('')}</tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(input.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { color: #64748b; margin: 0 0 12px; font-size: 11px; }
  .notice { background: #fef3c7; color: #78350f; padding: 6px 8px; border-radius: 4px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 600; }
  tr:nth-child(even) td { background: #f8fafc; }
  /* Repeat the header on every printed page and never split a row across pages. */
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  @media print { .no-print { display: none; } body { padding: 0; } }
</style>
</head>
<body>
<h1>${htmlEscape(input.title)}</h1>
<p class="meta">${htmlEscape(input.subtitle ?? '')}${input.subtitle ? ' · ' : ''}Generated ${htmlEscape(
    input.generatedAt.toISOString(),
  )} · ${input.rows.length} row${input.rows.length === 1 ? '' : 's'}</p>
${input.truncated ? '<p class="notice">Truncated at the row limit — narrow the date range or add a filter to see the rest.</p>' : ''}
<p class="no-print"><button onclick="window.print()">Print / Save as PDF</button></p>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body>
</html>`;
}
