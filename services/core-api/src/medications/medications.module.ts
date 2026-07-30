import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { AllergiesModule } from '../allergies/allergies.module';
import {
  DispenseRecordDto,
  MedicationsService,
  ModifyMedicationDto,
  PrescribeDto,
} from './medications.service';
import { InteractionsService } from './interactions.service';
import { DrugInteractionsModule } from './drug-interactions.module';

@ApiTags('medications')
@Controller('medications')
export class MedicationsController {
  constructor(private readonly service: MedicationsService) {}

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Prescriptions for a patient; status=active includes drugs on hold' })
  query(
    @Query('patientId') patientId?: string,
    @Query('status') status?: string,
    @Query('encounterId') encounterId?: string,
  ) {
    if (!patientId) throw new BadRequestException('patientId is required');
    return this.service.list({ patientId, status, encounterId });
  }

  @Get('formulary/search')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Drug autocomplete by name, brand, RxNorm or ATC code' })
  searchDrugs(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.service.searchDrugs(q ?? '', limit ? Number(limit) : 10);
  }

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

  @Patch(':id')
  @RequirePermissions('medication:prescribe')
  @Audit({ action: 'medication.modify', resourceType: 'MedicationRequest', isPhi: true })
  @ApiOperation({ summary: 'Discontinue or adjust a live prescription' })
  modify(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(ModifyMedicationDto) dto: z.infer<typeof ModifyMedicationDto>,
  ) {
    return this.service.modify(id, dto);
  }

  @Post(':id/dispense')
  @RequirePermissions('medication:dispense')
  @Audit({ action: 'medication.dispense', resourceType: 'MedicationDispense', isPhi: true })
  @ApiOperation({ summary: 'Record a dispense against this prescription' })
  dispense(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(DispenseRecordDto) dto: z.infer<typeof DispenseRecordDto>,
  ) {
    return this.service.dispense(id, dto);
  }

  @Post(':id/stop')
  @RequirePermissions('medication:prescribe')
  @Audit({ action: 'medication.stop', resourceType: 'MedicationRequest', isPhi: true })
  stop(@Param('id', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.stop(id, reason);
  }
}

@Module({
  imports: [AllergiesModule, DrugInteractionsModule],
  controllers: [MedicationsController],
  providers: [MedicationsService, InteractionsService],
  exports: [MedicationsService, InteractionsService, DrugInteractionsModule],
})
export class MedicationsModule {}
