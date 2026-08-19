/**
 * A short-lived cache in front of the dashboard queries.
 *
 * Every executive dashboard in the building refreshes on the same minute, and each
 * refresh is a dozen aggregate scans over the clinical tables. Sixty seconds of
 * cache turns a hundred dashboards into one query pass, and sixty seconds is well
 * inside what anybody means by "live" for a bed-occupancy tile.
 *
 * Redis when it is configured, an in-process map when it is not. The fallback is
 * not a degradation to apologise for: on a single node it is the same cache with
 * one less network hop, and it means a developer without Redis gets the same
 * behaviour rather than a different one.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';

/** How long a dashboard payload stays warm. */
export const ANALYTICS_TTL_SECONDS = 60;

interface MemoryEntry {
  value: string;
  expiresAtMs: number;
}

@Injectable()
export class AnalyticsCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AnalyticsCacheService.name);
  private redis?: Redis;
  private readonly memory = new Map<string, MemoryEntry>();
  /** Counts every producer run, so a test can prove the second call did not hit the DB. */
  private misses = 0;

  constructor(private readonly config: ConfigService) {}

  private get redisUrl(): string | undefined {
    const url = this.config.get<string>('REDIS_URL');
    if (url?.trim()) return url.trim();
    const host = this.config.get<string>('REDIS_HOST');
    if (!host?.trim()) return undefined;
    const port = this.config.get<string>('REDIS_PORT') ?? '6379';
    const password = this.config.get<string>('REDIS_PASSWORD');
    return password
      ? `redis://:${encodeURIComponent(password)}@${host}:${port}`
      : `redis://${host}:${port}`;
  }

  onModuleInit(): void {
    const url = this.redisUrl;
    if (!url) {
      this.log.log('REDIS_URL not configured — analytics cache is in-process');
      return;
    }
    try {
      this.redis = new Redis(url, {
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        // A cache that blocks is worse than no cache; fail fast to the producer.
        connectTimeout: 2_000,
        enableOfflineQueue: false,
      });
      // Logged, never thrown: an unreachable cache must not take the API down.
      this.redis.on('error', (error) => this.log.warn(`Redis cache error: ${error.message}`));
      this.log.log('Analytics cache backed by Redis');
    } catch (error) {
      this.log.warn(`Redis unavailable, falling back to in-process cache: ${String(error)}`);
      this.redis = undefined;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.memory.clear();
    if (this.redis) {
      this.redis.disconnect();
      this.redis = undefined;
    }
  }

  /** Tenant-scoped key. Params are hashed so a long filter set cannot bloat it. */
  key(tenantId: string, name: string, params?: unknown): string {
    const suffix =
      params === undefined
        ? ''
        : `:${createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16)}`;
    return `analytics:${tenantId}:${name}${suffix}`;
  }

  private async read(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch (error) {
        this.log.warn(`Redis read failed for ${key}: ${(error as Error).message}`);
        return null;
      }
    }
    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value;
  }

  private async write(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, value, 'EX', ttlSeconds);
        return;
      } catch (error) {
        this.log.warn(`Redis write failed for ${key}: ${(error as Error).message}`);
        return;
      }
    }
    this.memory.set(key, { value, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }

  /**
   * Returns the cached payload, or runs `produce` and caches what it returns.
   *
   * A producer that throws is not cached — a transient database error must not be
   * served back for the next minute as though it were an answer.
   */
  async wrap<T>(
    key: string,
    produce: () => Promise<T>,
    ttlSeconds: number = ANALYTICS_TTL_SECONDS,
  ): Promise<T> {
    const cached = await this.read(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // A corrupt entry is treated as a miss rather than surfaced to the caller.
        this.log.warn(`Discarding unparseable cache entry ${key}`);
      }
    }

    this.misses += 1;
    const value = await produce();
    await this.write(key, JSON.stringify(value), ttlSeconds);
    return value;
  }

  /** How many times a producer has actually run. Diagnostics and tests only. */
  get producerRuns(): number {
    return this.misses;
  }

  /** Drops every entry for one tenant. Used when a report changes the underlying data. */
  async invalidate(tenantId: string): Promise<void> {
    const prefix = `analytics:${tenantId}:`;
    if (this.redis) {
      try {
        const keys = await this.redis.keys(`${prefix}*`);
        if (keys.length) await this.redis.del(...keys);
      } catch (error) {
        this.log.warn(`Redis invalidate failed: ${(error as Error).message}`);
      }
      return;
    }
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key);
    }
  }
}
