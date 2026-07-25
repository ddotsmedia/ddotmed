'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { WS_EVENTS, type CriticalAlertEvent, type WsEvent } from '@medicore/shared-types';
import { useSession } from './session';

interface RealtimeValue {
  connected: boolean;
  alerts: CriticalAlertEvent[];
  dismissAlert: (dedupeKey: string) => void;
  subscribe: (channel: string) => void;
  unsubscribe: (channel: string) => void;
  on: <T>(event: WsEvent, handler: (payload: T) => void) => () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [alerts, setAlerts] = useState<CriticalAlertEvent[]>([]);

  useEffect(() => {
    if (!user) return;

    const stored = sessionStorage.getItem('medicore.session');
    const token = stored ? (JSON.parse(stored) as { accessToken?: string }).accessToken : undefined;
    if (!token) return;

    const socket = io(WS_URL || window.location.origin, {
      path: '/ws',
      auth: { token },
      transports: ['websocket'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on(WS_EVENTS.CRITICAL_ALERT, (payload: CriticalAlertEvent) => {
      // Deduplicate: the same clinical event can arrive from more than one producer.
      setAlerts((current) =>
        current.some((a) => a.dedupe_key === payload.dedupe_key) ? current : [payload, ...current].slice(0, 20),
      );
    });

    return () => {
      socket.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [user]);

  const value = useMemo<RealtimeValue>(
    () => ({
      connected,
      alerts,
      dismissAlert: (dedupeKey) => setAlerts((c) => c.filter((a) => a.dedupe_key !== dedupeKey)),
      subscribe: (channel) => socketRef.current?.emit('subscribe', channel),
      unsubscribe: (channel) => socketRef.current?.emit('unsubscribe', channel),
      on: <T,>(event: WsEvent, handler: (payload: T) => void) => {
        socketRef.current?.on(event, handler as (p: unknown) => void);
        return () => {
          socketRef.current?.off(event, handler as (p: unknown) => void);
        };
      },
    }),
    [connected, alerts],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside RealtimeProvider');
  return context;
}

/** Subscribes to a tenant channel for the lifetime of the component. */
export function useChannel(channel: string | null): void {
  const { subscribe, unsubscribe, connected } = useRealtime();
  useEffect(() => {
    if (!channel || !connected) return;
    subscribe(channel);
    return () => unsubscribe(channel);
  }, [channel, connected, subscribe, unsubscribe]);
}
