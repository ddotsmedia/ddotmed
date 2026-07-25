import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['/etc/medicore/.env', '.env'] }),
    ScheduleModule.forRoot(),
    CommonModule,
    AuthModule,
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
