import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';

type Handler = (payload: unknown, key: string | null) => Promise<void>;

/**
 * Thin Kafka wrapper. Emission is fire-and-forget by design: a broker outage must
 * degrade downstream sync and alert fan-out, never block a clinical write.
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaService.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private readonly consumers: Consumer[] = [];
  private connected = false;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    const brokers = (config.get<string>('KAFKA_BROKERS') ?? '').split(',').filter(Boolean);
    this.enabled = brokers.length > 0 && config.get('KAFKA_ENABLED') !== 'false';
    this.kafka = new Kafka({
      clientId: 'medicore-core-api',
      brokers: brokers.length ? brokers : ['localhost:9092'],
      logLevel: logLevel.ERROR,
      retry: { retries: 3, initialRetryTime: 300 },
    });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('KAFKA_BROKERS not configured — event publishing is disabled');
      return;
    }
    try {
      this.producer = this.kafka.producer({ allowAutoTopicCreation: true });
      await this.producer.connect();
      this.connected = true;
      this.logger.log('Kafka producer connected');
    } catch (e) {
      this.logger.error(`Kafka producer failed to connect: ${String(e)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.producer?.disconnect(),
      ...this.consumers.map((c) => c.disconnect()),
    ]);
  }

  async emit(topic: string, key: string, value: unknown): Promise<void> {
    if (!this.connected || !this.producer) return;
    try {
      await this.producer.send({
        topic,
        messages: [{ key, value: JSON.stringify(value) }],
      });
    } catch (e) {
      this.logger.error(`Failed to publish to ${topic}: ${String(e)}`);
    }
  }

  async subscribe(topic: string, groupId: string, handler: Handler): Promise<void> {
    if (!this.enabled) return;
    try {
      const consumer = this.kafka.consumer({ groupId });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          const raw = message.value?.toString();
          if (!raw) return;
          try {
            await handler(JSON.parse(raw), message.key?.toString() ?? null);
          } catch (e) {
            this.logger.error(`Handler failed for ${topic}: ${String(e)}`);
          }
        },
      });
      this.consumers.push(consumer);
      this.logger.log(`Subscribed to ${topic} as ${groupId}`);
    } catch (e) {
      this.logger.error(`Failed to subscribe to ${topic}: ${String(e)}`);
    }
  }
}
