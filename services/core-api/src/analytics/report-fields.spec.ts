/**
 * The report whitelist.
 *
 * This is the file that decides whether the report builder is a reporting tool or
 * an arbitrary-read primitive over a database of patient records, so the tests
 * that matter most here are the ones that try to get a column out of it that it
 * was never told about.
 */
import { BadRequestException } from '@nestjs/common';
import {
  FILTER_OPERATORS,
  REPORT_SOURCES,
  SOURCE_DATE_FIELD,
  buildWhere,
  csvCell,
  fieldCatalogue,
  fieldsFor,
  groupRows,
  htmlEscape,
  isReportSource,
  readPath,
  resolveFields,
  selectFor,
  shapeRow,
  toCsv,
  toPrintableHtml,
  type ReportFilter,
} from './report-fields';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

describe('the whitelist itself', () => {
  it('covers every source with a date field and a model', () => {
    for (const source of REPORT_SOURCES) {
      expect(SOURCE_DATE_FIELD[source]).toBeTruthy();
      expect(fieldsFor(source).length).toBeGreaterThan(0);
    }
  });

  it('never exposes a credential, a secret or clinical narrative', () => {
    const forbidden = [
      'password',
      'password_hash',
      'mfa_secret',
      'mfa_recovery_codes',
      'refresh_token',
      'refresh_token_jti',
      'token',
      'secret',
      'subjective',
      'objective',
      'assessment',
      'plan',
      'body',
      'findings',
      'impression',
      'notes',
      'clinical_notes',
    ];

    for (const source of REPORT_SOURCES) {
      for (const field of fieldsFor(source)) {
        for (const banned of forbidden) {
          expect(field.key).not.toContain(banned);
          expect(field.path).not.toContain(banned);
        }
      }
    }
  });

  it('marks every patient identifier as PHI', () => {
    for (const source of REPORT_SOURCES) {
      for (const field of fieldsFor(source)) {
        if (field.key === 'mrn' || field.key === 'patient_name') {
          expect(field.phi).toBe(true);
        }
      }
    }
  });

  it('publishes a catalogue the builder can render', () => {
    const catalogue = fieldCatalogue();
    expect(catalogue).toHaveLength(REPORT_SOURCES.length);
    expect(catalogue[0].fields.length).toBeGreaterThan(0);
  });

  it('recognises only the sources it defines', () => {
    expect(isReportSource('invoices')).toBe(true);
    expect(isReportSource('users')).toBe(false);
    expect(isReportSource('')).toBe(false);
  });
});

describe('resolveFields', () => {
  it('resolves known keys, preserving the requested column order', () => {
    const fields = resolveFields('invoices', ['status', 'invoice_number']);
    expect(fields.map((f) => f.key)).toEqual(['status', 'invoice_number']);
    expect(fields[0].path).toBe('status');
  });

  it('rejects a field that is not on the list, with 400', () => {
    const error = thrown(() => resolveFields('invoices', ['status', 'password_hash']));

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
    const body = (error as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('UNKNOWN_REPORT_FIELD');
    expect(body.unknown_fields).toEqual(['password_hash']);
  });

  it('rejects rather than silently dropping the unknown column', () => {
    // A report that quietly returns fewer columns gets read as though the missing
    // data did not exist.
    expect(() => resolveFields('encounters', ['not_a_field'])).toThrow(BadRequestException);
  });

  it('refuses a field borrowed from a different source', () => {
    expect(() => resolveFields('invoices', ['ward'])).toThrow(BadRequestException);
  });

  it('refuses a raw column name that is not a declared key', () => {
    // `family_name` is reachable only through the `patient_name` key.
    expect(() => resolveFields('invoices', ['patient.family_name'])).toThrow(BadRequestException);
  });

  it('collapses a duplicate request to one column', () => {
    expect(resolveFields('invoices', ['status', 'status']).map((f) => f.key)).toEqual(['status']);
  });
});

describe('buildWhere', () => {
  const where = (filters: ReportFilter[]) => buildWhere('invoices', filters);

  it('maps an equality onto the whitelisted path', () => {
    expect(where([{ field: 'status', operator: 'eq', value: 'paid' }])).toEqual([{ status: 'paid' }]);
  });

  it('nests a relation path the way Prisma expects', () => {
    expect(where([{ field: 'mrn', operator: 'eq', value: 'MRN-1' }])).toEqual([
      { patient: { mrn: 'MRN-1' } },
    ]);
  });

  it('rejects a filter on a field that is not whitelisted, with 400', () => {
    const error = thrown(() => where([{ field: 'password_hash', operator: 'eq', value: 'x' }]));
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getStatus()).toBe(400);
  });

  it('rejects an operator that makes no sense for the field kind', () => {
    // `contains` on an integer column would be a type error at the database.
    expect(() => where([{ field: 'total_minor', operator: 'contains', value: '1' }])).toThrow(
      /cannot be applied/,
    );
  });

  it('rejects an unsupported operator outright', () => {
    expect(() =>
      where([{ field: 'status', operator: 'startsWith' as never, value: 'x' }]),
    ).toThrow(BadRequestException);
  });

  it('searches text case-insensitively', () => {
    expect(where([{ field: 'invoice_number', operator: 'contains', value: 'inv' }])).toEqual([
      { invoice_number: { contains: 'inv', mode: 'insensitive' } },
    ]);
  });

  it('coerces a numeric filter and refuses a non-number', () => {
    expect(where([{ field: 'total_minor', operator: 'gte', value: '5000' }])).toEqual([
      { total_minor: { gte: 5_000 } },
    ]);
    expect(() => where([{ field: 'total_minor', operator: 'gte', value: 'lots' }])).toThrow(
      /takes a number/,
    );
  });

  it('coerces a date filter and refuses a non-date', () => {
    const built = where([{ field: 'issued_at', operator: 'gte', value: '2026-08-01' }]);
    expect((built[0].issued_at as { gte: Date }).gte).toBeInstanceOf(Date);
    expect(() => where([{ field: 'issued_at', operator: 'lt', value: 'yesterday-ish' }])).toThrow(
      /takes a date/,
    );
  });

  it('caps an `in` list and refuses an empty one', () => {
    expect(where([{ field: 'status', operator: 'in', value: ['paid', 'issued'] }])).toEqual([
      { status: { in: ['paid', 'issued'] } },
    ]);
    expect(() => where([{ field: 'status', operator: 'in', value: [] }])).toThrow(/matches nothing/);
    expect(() =>
      where([{ field: 'status', operator: 'in', value: Array.from({ length: 101 }, (_, i) => `s${i}`) }]),
    ).toThrow(/at most 100/);
  });

  it('offers exactly the operators the builder advertises', () => {
    expect([...FILTER_OPERATORS]).toEqual(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in']);
  });
});

describe('selectFor and shapeRow', () => {
  it('selects only the requested columns and their relations', () => {
    const fields = resolveFields('admissions', ['admission_number', 'ward', 'mrn']);
    expect(selectFor('admissions', fields)).toEqual({
      admission_number: true,
      bed: { select: { ward: true } },
      patient: { select: { mrn: true } },
    });
  });

  it('merges two fields that come from the same relation', () => {
    const fields = resolveFields('admissions', ['ward', 'bed_number']);
    expect(selectFor('admissions', fields)).toEqual({
      bed: { select: { ward: true, bed_number: true } },
    });
  });

  it('flattens a row onto the client-facing keys', () => {
    const fields = resolveFields('admissions', ['admission_number', 'ward', 'admitted_at']);
    const shaped = shapeRow(
      {
        admission_number: 'ADM-1',
        bed: { ward: 'ICU' },
        admitted_at: new Date('2026-08-01T00:00:00Z'),
      },
      fields,
    );

    expect(shaped).toEqual({
      admission_number: 'ADM-1',
      ward: 'ICU',
      admitted_at: '2026-08-01T00:00:00.000Z',
    });
  });

  it('reads a missing relation as null rather than throwing', () => {
    expect(readPath({ bed: null }, 'bed.ward')).toBeNull();
    expect(readPath({}, 'patient.mrn')).toBeNull();
  });
});

describe('groupRows', () => {
  const fields = resolveFields('invoices', ['payer_type', 'total_minor', 'balance_minor']);
  const groupField = fields[0];

  it('counts rows and sums every summable column', () => {
    const grouped = groupRows(
      [
        { payer_type: 'cash', total_minor: 1_000, balance_minor: 0 },
        { payer_type: 'insurance', total_minor: 5_000, balance_minor: 5_000 },
        { payer_type: 'cash', total_minor: 2_000, balance_minor: 500 },
      ],
      groupField,
      fields,
    );

    expect(grouped).toEqual([
      { group: 'cash', count: 2, total_minor: 3_000, balance_minor: 500 },
      { group: 'insurance', count: 1, total_minor: 5_000, balance_minor: 5_000 },
    ]);
  });

  it('buckets a null group under an em dash rather than losing the row', () => {
    const grouped = groupRows([{ payer_type: null, total_minor: 100 }], groupField, fields);
    expect(grouped[0].group).toBe('—');
    expect(grouped[0].count).toBe(1);
  });
});

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Ward A')).toBe('Ward A');
    expect(csvCell(42)).toBe('42');
  });

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes and doubles an embedded quote', () => {
    expect(csvCell('He said "no"')).toBe('"He said ""no"""');
  });

  it('quotes a value carrying a comma or a newline', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('defuses a spreadsheet formula', () => {
    // A report of patient-supplied text is exactly where this payload waits.
    expect(csvCell('=cmd|/c calc')).toBe("'=cmd|/c calc");
    expect(csvCell('+1-555-0100')).toBe("'+1-555-0100");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-5')).toBe("'-5");
  });
});

describe('toCsv', () => {
  it('writes the header from the labels and CRLF line endings', () => {
    const csv = toCsv(
      [{ ward: 'ICU', count: 3 }],
      [
        { key: 'ward', label: 'Ward' },
        { key: 'count', label: 'Rows' },
      ],
    );
    expect(csv).toBe('Ward,Rows\r\nICU,3\r\n');
  });

  it('emits a header-only document for an empty result', () => {
    expect(toCsv([], [{ key: 'ward', label: 'Ward' }])).toBe('Ward\r\n');
  });
});

describe('toPrintableHtml', () => {
  const html = (over: Partial<Parameters<typeof toPrintableHtml>[0]> = {}) =>
    toPrintableHtml({
      title: 'Admissions report',
      rows: [{ ward: 'ICU' }],
      columns: [{ key: 'ward', label: 'Ward' }],
      generatedAt: new Date('2026-08-19T10:00:00Z'),
      truncated: false,
      ...over,
    });

  it('carries a print stylesheet that repeats the table header', () => {
    expect(html()).toContain('@page');
    expect(html()).toContain('display: table-header-group');
  });

  it('escapes a value that would otherwise inject markup', () => {
    const out = html({ rows: [{ ward: '<script>alert(1)</script>' }] });
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('says so on the page when the result was truncated', () => {
    expect(html({ truncated: true })).toContain('Truncated at the row limit');
    expect(html({ truncated: false })).not.toContain('Truncated at the row limit');
  });

  it('escapes the five characters that matter', () => {
    expect(htmlEscape(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;');
  });
});
