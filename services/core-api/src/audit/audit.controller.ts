import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequirePermissions } from '../common/decorators';
import type { RequestContext } from '../common/tenant-context';
import { ZodQuery } from '../common/zod.pipe';
import { AuditService } from './audit.service';

const QuerySchema = z.object({
  patient_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  action: z.string().max(120).optional(),
  break_glass_only: z.coerce.boolean().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit:read')
  async search(@ZodQuery(QuerySchema) q: z.infer<typeof QuerySchema>, @Ctx() ctx: RequestContext) {
    return this.audit.search({
      tenantId: ctx.tenantId,
      patientId: q.patient_id,
      userId: q.user_id,
      action: q.action,
      breakGlassOnly: q.break_glass_only,
      from: q.from,
      to: q.to,
      page: q.page,
      limit: q.limit,
    });
  }
}
