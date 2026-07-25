import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody, ZodQuery } from '../common/zod.pipe';
import { PatientsService } from './patients.service';
import {
  CheckDuplicatesDto,
  MergePatientDto,
  RegisterPatientDto,
  SearchPatientDto,
  UnmergePatientDto,
  UpdatePatientDto,
} from './patients.dto';

@ApiTags('patients')
@Controller('patients')
export class PatientsController {
  constructor(private readonly service: PatientsService) {}

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Search patients by name, MRN, national identifier or phone' })
  search(@ZodQuery(SearchPatientDto) q: z.infer<typeof SearchPatientDto>) {
    return this.service.search(q);
  }

  @Post()
  @RequirePermissions('patient:write')
  @Audit({ action: 'patient.register', resourceType: 'Patient', isPhi: true })
  @ApiOperation({ summary: 'Register a patient; 409 lists duplicate candidates unless force_create' })
  register(@ZodBody(RegisterPatientDto) dto: z.infer<typeof RegisterPatientDto>) {
    return this.service.register(dto);
  }

  @Post('check-duplicates')
  @RequirePermissions('patient:read')
  checkDuplicates(
    @ZodBody(CheckDuplicatesDto) dto: z.infer<typeof CheckDuplicatesDto>,
  ) {
    return this.service.findDuplicates(dto);
  }

  @Get(':id')
  @RequirePermissions('patient:read')
  @Audit({ action: 'patient.read', resourceType: 'Patient', isPhi: true })
  getProfile(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getFullProfile(id);
  }

  @Patch(':id')
  @RequirePermissions('patient:write')
  @Audit({ action: 'patient.update', resourceType: 'Patient', isPhi: true })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(UpdatePatientDto) dto: z.infer<typeof UpdatePatientDto>,
  ) {
    return this.service.update(id, dto);
  }

  @Get(':id/timeline')
  @RequirePermissions('patient:read')
  @Audit({ action: 'patient.timeline.read', resourceType: 'Patient', isPhi: true })
  timeline(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.service.timeline(id, limit ? Number(limit) : 100);
  }

  @Get(':id/ips')
  @RequirePermissions('patient:read')
  @Audit({ action: 'patient.ips.generate', resourceType: 'Patient', isPhi: true })
  @ApiOperation({ summary: 'International Patient Summary as a FHIR document bundle' })
  ips(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.ipsSummary(id);
  }

  @Post('merge')
  @RequirePermissions('patient:merge')
  @Audit({ action: 'patient.merge', resourceType: 'Patient', isPhi: true })
  merge(@ZodBody(MergePatientDto) dto: z.infer<typeof MergePatientDto>) {
    return this.service.merge(dto);
  }

  @Post('unmerge')
  @RequirePermissions('patient:merge')
  @Audit({ action: 'patient.unmerge', resourceType: 'Patient', isPhi: true })
  unmerge(@ZodBody(UnmergePatientDto) dto: z.infer<typeof UnmergePatientDto>) {
    return this.service.unmerge(dto.patient_id, dto.reason);
  }
}
