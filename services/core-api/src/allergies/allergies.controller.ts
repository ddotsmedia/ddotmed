import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { AllergiesService, RecordAllergyDto } from './allergies.service';

@ApiTags('allergies')
@Controller('allergies')
export class AllergiesController {
  constructor(private readonly service: AllergiesService) {}

  @Get('patient/:patientId')
  @RequirePermissions('patient:read')
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query('include_inactive') includeInactive?: string,
  ) {
    return this.service.listForPatient(patientId, includeInactive === 'true');
  }

  @Post()
  @RequirePermissions('allergy:write')
  @Audit({ action: 'allergy.record', resourceType: 'AllergyIntolerance', isPhi: true })
  record(@ZodBody(RecordAllergyDto) dto: z.infer<typeof RecordAllergyDto>) {
    return this.service.record(dto);
  }

  @Patch(':id/resolve')
  @RequirePermissions('allergy:write')
  @Audit({ action: 'allergy.resolve', resourceType: 'AllergyIntolerance', isPhi: true })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.markResolved(id, reason);
  }

  @Post('check')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Real-time allergy check for a drug before prescribing or dispensing' })
  check(
    @Body() body: { patient_id: string; rxnorm?: string; name: string; ingredients?: string[] },
  ) {
    return this.service.checkAgainstDrug(body.patient_id, {
      rxnorm: body.rxnorm,
      name: body.name,
      ingredients: body.ingredients,
    });
  }
}
