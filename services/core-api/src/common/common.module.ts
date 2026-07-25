import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';

@Global()
@Module({
  providers: [PrismaService, KafkaService, AuditService, RealtimeGateway],
  exports: [PrismaService, KafkaService, AuditService, RealtimeGateway],
})
export class CommonModule {}
