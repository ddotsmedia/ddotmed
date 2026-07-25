import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { WsEvent } from '@medicore/shared-types';
import { TokenService } from '../auth/token.service';

/**
 * Real-time fan-out for queues, bed board, vitals and critical alerts.
 * Rooms are namespaced by tenant so a subscription cannot cross tenants.
 */
@WebSocketGateway({ path: '/ws', cors: { origin: false } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly tokens: TokenService) {}

  async handleConnection(client: Socket): Promise<void> {
    const raw =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.replace('Bearer ', '');
    if (!raw) {
      client.disconnect(true);
      return;
    }
    try {
      const payload = await this.tokens.verify(raw);
      client.data.tenantId = payload.tenant_id;
      client.data.userId = payload.sub;
      client.data.roles = payload.roles;
      await client.join(`tenant:${payload.tenant_id}`);
      for (const role of payload.roles) await client.join(`tenant:${payload.tenant_id}:role:${role}`);
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, channel: string): Promise<{ ok: boolean }> {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId) return { ok: false };
    // Channel names are always rewritten under the caller's tenant prefix.
    await client.join(`tenant:${tenantId}:${channel}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(client: Socket, channel: string): Promise<{ ok: boolean }> {
    const tenantId = client.data.tenantId as string | undefined;
    if (!tenantId) return { ok: false };
    await client.leave(`tenant:${tenantId}:${channel}`);
    return { ok: true };
  }

  emitToTenant(tenantId: string, event: WsEvent, payload: unknown): void {
    this.server?.to(`tenant:${tenantId}`).emit(event, payload);
  }

  emitToChannel(tenantId: string, channel: string, event: WsEvent, payload: unknown): void {
    this.server?.to(`tenant:${tenantId}:${channel}`).emit(event, payload);
  }

  emitToRoles(tenantId: string, roles: string[], event: WsEvent, payload: unknown): void {
    for (const role of roles) {
      this.server?.to(`tenant:${tenantId}:role:${role}`).emit(event, payload);
    }
  }
}
