import { Body, Controller, Get, Module, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { AllergiesModule } from '../allergies/allergies.module';
import { MedicationsService, PrescribeDto } from './medications.service';
import { InteractionsService } from './interactions.service';

@ApiTags('medications')
@Controller('medications')
export class MedicationsController {
  constructor(private readonly service: MedicationsService) {}

  @Get('patient/:patientId')
  @RequirePermissions('patient:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string, @Query('all') all?: string) {
    return this.service.listForPatient(patientId, all !== 'true');
  }

  @Post('preflight')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Dry-run the allergy and interaction gates before prescribing' })
  preflight(@Body() body: { patient_id: string; code: string; display: string }) {
    return this.service.preflight(body.patient_id, body.code, body.display);
  }

  @Post()
  @RequirePermissions('medication:prescribe')
  @Audit({ action: 'medication.prescribe', resourceType: 'MedicationRequest', isPhi: true })
  @ApiOperation({ summary: 'Prescribe; allergy and interaction checks run on every save' })
  prescribe(@ZodBody(PrescribeDto) dto: z.infer<typeof PrescribeDto>) {
    return this.service.prescribe(dto);
  }

  @Post(':id/stop')
  @RequirePermissions('medication:prescribe')
  @Audit({ action: 'medication.stop', resourceType: 'MedicationRequest', isPhi: true })
  stop(@Param('id', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.stop(id, reason);
  }
}

@Module({
  imports: [AllergiesModule],
  controllers: [MedicationsController],
  providers: [MedicationsService, InteractionsService],
  exports: [MedicationsService, InteractionsService],
})
export class MedicationsModule {}
