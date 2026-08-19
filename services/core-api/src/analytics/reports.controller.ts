import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { ObjectStorageService } from '../common/object-storage.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import {
  FILTER_OPERATORS,
  REPORT_SOURCES,
  SOURCE_DATE_FIELD,
  SOURCE_MODEL,
  buildWhere,
  fieldCatalogue,
  groupRows,
  resolveFields,
  selectFor,
  shapeRow,
  toCsv,
  toPrintableHtml,
  type ReportField,
  type ReportSource,
} from './report-fields';

/**
 * The slice of the Fastify reply this controller uses.
 *
 * Declared structurally rather than imported from `fastify`: the adapter is a
 * transitive dependency, and taking a direct type import on it would tie the
 * controller to a package this service does not itself depend on.
 */
interface StreamingReply {
  header(name: string, value: string): StreamingReply;
  send(payload: unknown): unknown;
}

/** The hard ceiling on a report. Beyond this, narrow the range or add a filter. */
export const MAX_REPORT_ROWS = 10_000;

/** What the preview in the builder shows before anyone exports. */
export const PREVIEW_ROWS = 100;

const FilterSchema = z.object({
  field: z.string().min(1).max(64),
  operator: z.enum(FILTER_OPERATORS),
  value: z.union([
    z.string().max(500),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string().max(200), z.number()])).max(100),
  ]),
});

/**
 * `fields` and `date_range` are what the builder sends; the snake/camel spellings
 * of each are both accepted so a hand-written query string works as well as the UI.
 */
const normalise = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const range = (v.date_range ?? v.dateRange) as Record<string, unknown> | undefined;
  return {
    ...v,
    fields: v.fields ?? v.field,
    date_range: range ? { from: range.from, to: range.to } : undefined,
    group_by: v.group_by ?? v.groupBy,
  };
};

export const CustomReportDto = z.preprocess(
  normalise,
  z.object({
    source: z.enum(REPORT_SOURCES as [ReportSource, ...ReportSource[]]).default('encounters'),
    fields: z.array(z.string().min(1).max(64)).min(1).max(25),
    filters: z.array(FilterSchema).max(20).default([]),
    date_range: z
      .object({ from: z.coerce.date(), to: z.coerce.date() })
      .refine((r) => r.from <= r.to, { message: 'date_range.from must not be after date_range.to' })
      .optional(),
    group_by: z.string().min(1).max(64).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_REPORT_ROWS).default(MAX_REPORT_ROWS),
  }),
);

export const ExportReportDto = z.preprocess(
  normalise,
  z.object({
    source: z.enum(REPORT_SOURCES as [ReportSource, ...ReportSource[]]).default('encounters'),
    fields: z.array(z.string().min(1).max(64)).min(1).max(25),
    filters: z.array(FilterSchema).max(20).default([]),
    date_range: z
      .object({ from: z.coerce.date(), to: z.coerce.date() })
      .refine((r) => r.from <= r.to, { message: 'date_range.from must not be after date_range.to' })
      .optional(),
    group_by: z.string().min(1).max(64).nullable().optional(),
    limit: z.number().int().min(1).max(MAX_REPORT_ROWS).default(MAX_REPORT_ROWS),
    format: z.enum(['csv', 'pdf']).default('csv'),
    /** Set false to force the inline stream even when MinIO is available. */
    store: z.boolean().default(true),
  }),
);

export interface ReportResult {
  source: ReportSource;
  columns: Array<{ key: string; label: string }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  grouped_by: string | null;
  contains_phi: boolean;
  generated_at: string;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * Runs a report.
   *
   * Every column and every filter key is resolved through the whitelist in
   * `report-fields` before anything reaches Prisma; the strings the client sent
   * are used to look values up, never to name a column. The tenant scope and the
   * soft-delete filter are added here and cannot be overridden by a filter,
   * because a report is exactly where a missing tenant predicate would go unnoticed.
   */
  async run(dto: z.infer<typeof CustomReportDto>): Promise<ReportResult> {
    const source = dto.source;
    const fields = resolveFields(source, dto.fields);

    const groupField = dto.group_by
      ? resolveFields(source, [dto.group_by])[0]
      : null;
    if (groupField && !groupField.groupable) {
      throw new BadRequestException(
        `${groupField.key} cannot be grouped on; it is not a bucketable value`,
      );
    }

    // The group column must be selected even if the caller did not list it.
    const selected: ReportField[] =
      groupField && !fields.some((f) => f.key === groupField.key)
        ? [groupField, ...fields]
        : fields;

    const dateField = SOURCE_DATE_FIELD[source];
    const where: Record<string, unknown> = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      ...(dto.date_range
        ? { [dateField]: { gte: dto.date_range.from, lte: dto.date_range.to } }
        : {}),
      ...(dto.filters.length ? { AND: buildWhere(source, dto.filters) } : {}),
    };

    // One over the limit, so "truncated" is a fact rather than a guess.
    const take = Math.min(dto.limit, MAX_REPORT_ROWS) + 1;
    const delegate = this.delegate(source);
    const found = (await delegate.findMany({
      where,
      select: selectFor(source, selected),
      orderBy: { [dateField]: 'desc' },
      take,
    })) as Record<string, unknown>[];

    const truncated = found.length > take - 1;
    const rows = found.slice(0, take - 1).map((row) => shapeRow(row, selected));

    const shaped = groupField ? groupRows(rows, groupField, selected) : rows;
    const columns = groupField
      ? [
          { key: 'group', label: groupField.label },
          { key: 'count', label: 'Rows' },
          ...selected.filter((f) => f.summable).map((f) => ({ key: f.key, label: f.label })),
        ]
      : selected.map((f) => ({ key: f.key, label: f.label }));

    return {
      source,
      columns,
      rows: shaped as Record<string, unknown>[],
      row_count: shaped.length,
      truncated,
      grouped_by: groupField?.key ?? null,
      // Grouping collapses identifiers away, so a grouped report is not a PHI extract.
      contains_phi: !groupField && selected.some((f) => f.phi),
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Resolves the source name to its Prisma delegate.
   *
   * The name is one of the five in `SOURCE_MODEL`, which zod has already narrowed
   * to that union — this cannot be handed an arbitrary model name.
   */
  private delegate(source: ReportSource): {
    findMany: (args: unknown) => Promise<unknown[]>;
  } {
    const model = SOURCE_MODEL[source];
    const delegate = (this.prisma as unknown as Record<string, unknown>)[model];
    if (!delegate) throw new BadRequestException(`Unsupported report source: ${source}`);
    return delegate as { findMany: (args: unknown) => Promise<unknown[]> };
  }

  /** A stable, human-readable object name for a stored export. */
  exportKey(source: string, format: 'csv' | 'pdf', now: Date = new Date()): string {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    return [
      'tenants',
      currentContext().tenantId,
      'reports',
      `${source}-${stamp}-${randomUUID().slice(0, 8)}.${format === 'pdf' ? 'html' : 'csv'}`,
    ].join('/');
  }

  /**
   * Renders a report to CSV or a printable document.
   *
   * The PDF path produces a self-contained HTML page carrying a print stylesheet
   * rather than a rendered PDF. Shipping headless Chromium into a clinical
   * container to lay out a table is a large image and a large attack surface for a
   * job the browser's own print pipeline already does properly — page size,
   * repeating table headers and all.
   */
  render(
    result: ReportResult,
    format: 'csv' | 'pdf',
    meta: { title: string; subtitle?: string },
  ): { body: string; contentType: string; extension: string } {
    if (format === 'csv') {
      return {
        body: toCsv(result.rows, result.columns),
        contentType: 'text/csv; charset=utf-8',
        extension: 'csv',
      };
    }
    return {
      body: toPrintableHtml({
        title: meta.title,
        subtitle: meta.subtitle,
        rows: result.rows,
        columns: result.columns,
        generatedAt: new Date(result.generated_at),
        truncated: result.truncated,
      }),
      contentType: 'text/html; charset=utf-8',
      extension: 'html',
    };
  }

  /** Parks the rendered file in MinIO, or null when the store is unavailable. */
  async store(key: string, body: string, contentType: string) {
    return this.storage.putObject({ key, body, contentType, downloadTtlSeconds: 900 });
  }

  get storageAvailable(): boolean {
    return this.storage.isConfigured;
  }
}

@ApiTags('analytics')
@Controller('analytics/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('fields')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'The whitelist the report builder renders its field picker from' })
  fields() {
    return {
      sources: fieldCatalogue(),
      operators: FILTER_OPERATORS,
      max_rows: MAX_REPORT_ROWS,
      preview_rows: PREVIEW_ROWS,
    };
  }

  /**
   * GET, because a report is a read.
   *
   * The parameter set is too structured for a query string, so it arrives as a
   * single JSON `query` parameter. The POST alias below takes the same object as a
   * body for callers that would rather not URL-encode it.
   */
  @Get('custom')
  @RequirePermissions('patient:read')
  @Audit({ action: 'report.run', resourceType: 'Report', isPhi: true })
  @ApiOperation({ summary: 'Run a custom report over whitelisted fields; 10 000 rows maximum' })
  custom(@Query('query') raw?: string, @Query() all?: Record<string, string>) {
    return this.service.run(this.parseQuery(raw, all));
  }

  @Post('custom')
  @RequirePermissions('patient:read')
  @Audit({ action: 'report.run', resourceType: 'Report', isPhi: true })
  @ApiOperation({ summary: 'Run a custom report, parameters in the body' })
  customPost(@ZodBody(CustomReportDto) dto: z.infer<typeof CustomReportDto>) {
    return this.service.run(dto);
  }

  /**
   * Exports a report.
   *
   * Hands back a MinIO link when object storage is configured, and streams the
   * bytes inline when it is not — the same file either way, so a deployment
   * without MinIO is not a deployment without exports.
   */
  @Post('export')
  @RequirePermissions('patient:read')
  @Audit({ action: 'report.export', resourceType: 'Report', isPhi: true })
  @ApiOperation({ summary: 'Export a report as CSV or a printable document' })
  async export(
    @ZodBody(ExportReportDto) dto: z.infer<typeof ExportReportDto>,
    @Res() reply: StreamingReply,
  ): Promise<void> {
    const result = await this.service.run(dto);
    const rendered = this.service.render(result, dto.format, {
      title: `${dto.source.replace(/_/g, ' ')} report`,
      subtitle: dto.date_range
        ? `${dto.date_range.from.toISOString().slice(0, 10)} to ${dto.date_range.to.toISOString().slice(0, 10)}`
        : undefined,
    });

    const key = this.service.exportKey(dto.source, dto.format);

    if (dto.store && this.service.storageAvailable) {
      const stored = await this.service.store(key, rendered.body, rendered.contentType);
      if (stored) {
        reply.header('content-type', 'application/json; charset=utf-8').send({
          delivery: 'url',
          download_url: stored.url,
          expires_at: stored.expires_at,
          object_key: stored.key,
          format: dto.format,
          row_count: result.row_count,
          truncated: result.truncated,
          contains_phi: result.contains_phi,
        });
        return;
      }
    }

    // Inline: the same bytes, delivered directly rather than by reference.
    const filename = key.split('/').pop() ?? `report.${rendered.extension}`;
    reply
      .header('content-type', rendered.contentType)
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('x-report-rows', String(result.row_count))
      .header('x-report-truncated', String(result.truncated))
      .send(rendered.body);
  }

  /**
   * Accepts the report parameters either as one JSON `query` parameter or as
   * loose query-string fields, then hands them to the same validator the body
   * path uses — so both spellings get identical whitelist enforcement.
   */
  private parseQuery(
    raw: string | undefined,
    all: Record<string, string> | undefined,
  ): z.infer<typeof CustomReportDto> {
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BadRequestException('query must be valid JSON');
      }
      return CustomReportDto.parse(parsed) as z.infer<typeof CustomReportDto>;
    }

    const q = all ?? {};
    const csv = (value: string | undefined): string[] =>
      (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    const candidate = {
      source: q.source,
      fields: csv(q.fields),
      filters: [],
      date_range: q.from && q.to ? { from: q.from, to: q.to } : undefined,
      group_by: q.group_by ?? q.groupBy ?? undefined,
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    };

    const result = CustomReportDto.safeParse(candidate);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid report parameters',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data as z.infer<typeof CustomReportDto>;
  }
}
