'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  SESSION_IDLE_TIMEOUT_MS,
  ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@medicore/shared-types';
import { setAccessToken, setUnauthorizedHandler } from './api';

export interface SessionUser {
  id: string;
  email: string;
  roles: Role[];
  locale: string;
  tenant: string;
}

interface SessionValue {
  user: SessionUser | null;
  permissions: Permission[];
  signIn: (user: SessionUser, accessToken: string, refreshToken: string) => void;
  signOut: (reason?: string) => void;
  /** Milliseconds until the idle timer fires; drives the expiry warning banner. */
  idleRemainingMs: number;
}

const SessionContext = createContext<SessionValue | null>(null);

const STORAGE_KEY = 'medicore.session';
const WARN_AT_MS = 2 * 60 * 1000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [idleRemainingMs, setIdleRemainingMs] = useState(SESSION_IDLE_TIMEOUT_MS);
  const lastActivity = useRef(Date.now());

  const signOut = useCallback(
    (reason?: string) => {
      setUser(null);
      setAccessToken(null);
      sessionStorage.removeItem(STORAGE_KEY);
      router.replace(`/login${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
    },
    [router],
  );

  const signIn = useCallback((nextUser: SessionUser, accessToken: string, refreshToken: string) => {
    setAccessToken(accessToken);
    // sessionStorage, not localStorage: closing the tab must end the session on a
    // shared clinical workstation.
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ user: nextUser, accessToken, refreshToken }),
    );
    lastActivity.current = Date.now();
    setUser(nextUser);
  }, []);

  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as { user: SessionUser; accessToken: string };
      setAccessToken(parsed.accessToken);
      setUser(parsed.user);
    } catch {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => signOut('expired'));
  }, [signOut]);

  // 15-minute idle auto-logout. The server enforces it too; this is the client half
  // so an unattended workstation clears PHI from the screen without waiting for a call.
  useEffect(() => {
    if (!user) return;

    const bump = () => {
      lastActivity.current = Date.now();
    };
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    for (const event of events) window.addEventListener(event, bump, { passive: true });

    const timer = window.setInterval(() => {
      const remaining = SESSION_IDLE_TIMEOUT_MS - (Date.now() - lastActivity.current);
      setIdleRemainingMs(Math.max(0, remaining));
      if (remaining <= 0) signOut('idle');
    }, 1000);

    return () => {
      for (const event of events) window.removeEventListener(event, bump);
      window.clearInterval(timer);
    };
  }, [user, signOut]);

  const permissions = useMemo<Permission[]>(
    () => (user ? [...new Set(user.roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))] : []),
    [user],
  );

  const value = useMemo<SessionValue>(
    () => ({ user, permissions, signIn, signOut, idleRemainingMs }),
    [user, permissions, signIn, signOut, idleRemainingMs],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

export interface PermissionsApi {
  can: (permission: Permission) => boolean;
  canAny: (...permissions: Permission[]) => boolean;
  canAll: (...permissions: Permission[]) => boolean;
  hasRole: (...roles: Role[]) => boolean;
  roles: Role[];
}

export function usePermissions(): PermissionsApi {
  const { permissions, user } = useSession();
  return useMemo(
    () => ({
      can: (permission) => permissions.includes(permission),
      canAny: (...list) => list.some((p) => permissions.includes(p)),
      canAll: (...list) => list.every((p) => permissions.includes(p)),
      hasRole: (...list) => list.some((r) => user?.roles.includes(r) ?? false),
      roles: user?.roles ?? [],
    }),
    [permissions, user],
  );
}

export const SESSION_WARN_AT_MS = WARN_AT_MS;
