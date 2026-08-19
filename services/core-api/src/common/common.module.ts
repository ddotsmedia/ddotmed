import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { ObjectStorageService } from './object-storage.service';

@Global()
@Module({
  providers: [PrismaService, KafkaService, AuditService, RealtimeGateway, ObjectStorageService],
  exports: [PrismaService, KafkaService, AuditService, RealtimeGateway, ObjectStorageService],
})
export class CommonModule {}
