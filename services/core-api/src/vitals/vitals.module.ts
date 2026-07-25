import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { DeviceVitalsDto, RecordVitalsDto, VitalsService } from './vitals.service';

@ApiTags('vitals')
@Controller('vitals')
export class VitalsController {
  constructor(private readonly service: VitalsService) {}

  @Get('patient/:patientId')
  @RequirePermissions('patient:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string, @Query('limit') limit?: string) {
    return this.service.listForPatient(patientId, limit ? Number(limit) : 50);
  }

  @Get('patient/:patientId/trend')
  @RequirePermissions('patient:read')
  trend(@Param('patientId', ParseUUIDPipe) patientId: string, @Query('hours') hours?: string) {
    return this.service.trend(patientId, hours ? Number(hours) : 48);
  }

  @Post()
  @RequirePermissions('vitals:write')
  @Audit({ action: 'vitals.record', resourceType: 'Observation', isPhi: true })
  record(@ZodBody(RecordVitalsDto) dto: z.infer<typeof RecordVitalsDto>) {
    return this.service.record(dto);
  }

  @Post('device')
  @RequirePermissions('vitals:write')
  @Audit({ action: 'vitals.device-ingest', resourceType: 'Observation', isPhi: true })
  ingest(@ZodBody(DeviceVitalsDto) dto: z.infer<typeof DeviceVitalsDto>) {
    return this.service.ingestFromDevice(dto);
  }
}

@Module({
  controllers: [VitalsController],
  providers: [VitalsService],
  exports: [VitalsService],
})
export class VitalsModule {}
