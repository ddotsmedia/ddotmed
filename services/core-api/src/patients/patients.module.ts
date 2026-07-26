import { Module } from '@nestjs/common';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { PatientsRepository } from './patients.repository';
import { RelationshipsService } from './relationships.service';

@Module({
  controllers: [PatientsController],
  providers: [PatientsService, PatientsRepository, RelationshipsService],
  exports: [PatientsService, PatientsRepository, RelationshipsService],
})
export class PatientsModule {}
