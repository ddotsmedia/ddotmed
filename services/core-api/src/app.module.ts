import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { PatientsModule } from './patients/patients.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { PractitionersModule } from './practitioners/practitioners.module';
import { EncountersModule } from './encounters/encounters.module';
import { NotesModule } from './notes/notes.module';
import { ConditionsModule } from './conditions/conditions.module';
import { AllergiesModule } from './allergies/allergies.module';
import { MedicationsModule } from './medications/medications.module';
import { VitalsModule } from './vitals/vitals.module';
import { LabModule } from './lab/lab.module';
import { RadiologyModule } from './radiology/radiology.module';
import { PharmacyModule } from './pharmacy/pharmacy.module';
import { BedsModule } from './beds/beds.module';
import { BillingModule } from './billing/billing.module';
import { InsuranceModule } from './insurance/insurance.module';
import { InventoryModule } from './inventory/inventory.module';
import { HrModule } from './hr/hr.module';
import { FhirModule } from './fhir/fhir.module';
import { PortalModule } from './portal/portal.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['/etc/medicore/.env', '.env'] }),
    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    AuditModule,
    PatientsModule,
    AppointmentsModule,
    PractitionersModule,
    EncountersModule,
    NotesModule,
    ConditionsModule,
    AllergiesModule,
    MedicationsModule,
    VitalsModule,
    LabModule,
    RadiologyModule,
    PharmacyModule,
    BedsModule,
    BillingModule,
    InsuranceModule,
    InventoryModule,
    HrModule,
    FhirModule,
    PortalModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
