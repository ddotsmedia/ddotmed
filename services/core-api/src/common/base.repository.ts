import { NotFoundException } from '@nestjs/common';
import { currentContext } from './tenant-context';
import type { Paginated } from '@medicore/shared-types';

export interface DelegateLike {
  findMany(args: unknown): Promise<unknown[]>;
  findFirst(args: unknown): Promise<unknown>;
  count(args: unknown): Promise<number>;
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
}

/**
 * Every read and write goes through here so tenant scope and the soft-delete
 * filter are applied structurally rather than being remembered at each call site.
 */
export abstract class BaseRepository<T> {
  protected abstract readonly delegate: DelegateLike;
  protected abstract readonly resourceName: string;

  protected get tenantId(): string {
    return currentContext().tenantId;
  }

  protected scope(where: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...where, tenant_id: this.tenantId, deleted_at: null };
  }

  async findById(id: string, include?: Record<string, unknown>): Promise<T> {
    const found = await this.delegate.findFirst({
      where: this.scope({ id }),
      ...(include ? { include } : {}),
    });
    if (!found) throw new NotFoundException(`${this.resourceName} ${id} not found`);
    return found as T;
  }

  async findOptional(where: Record<string, unknown>): Promise<T | null> {
    return (await this.delegate.findFirst({ where: this.scope(where) })) as T | null;
  }

  async paginate(params: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown> | Record<string, unknown>[];
    include?: Record<string, unknown>;
    page?: number;
    limit?: number;
  }): Promise<Paginated<T>> {
    const page = params.page ?? 1;
    const limit = Math.min(params.limit ?? 25, 200);
    const where = this.scope(params.where);
    const [data, total] = await Promise.all([
      this.delegate.findMany({
        where,
        orderBy: params.orderBy ?? { created_at: 'desc' },
        ...(params.include ? { include: params.include } : {}),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.delegate.count({ where }),
    ]);
    return { data: data as T[], total, page, limit, pages: Math.ceil(total / limit) };
  }

  async create(data: Record<string, unknown>, include?: Record<string, unknown>): Promise<T> {
    return (await this.delegate.create({
      data: { ...data, tenant_id: this.tenantId },
      ...(include ? { include } : {}),
    })) as T;
  }

  async update(id: string, data: Record<string, unknown>): Promise<T> {
    await this.findById(id);
    return (await this.delegate.update({ where: { id }, data })) as T;
  }

  /** PHI is never hard-deleted; the reason is mandatory for the audit trail. */
  async softDelete(id: string, reason: string): Promise<T> {
    await this.findById(id);
    return (await this.delegate.update({
      where: { id },
      data: { deleted_at: new Date(), deleted_reason: reason },
    })) as T;
  }
}
