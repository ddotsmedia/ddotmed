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
import { API_BASE, setAccessToken, setSessionLostHandler } from './api-client';

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
  /** True until the initial cookie-based restore has settled. */
  isRestoring: boolean;
  signIn: (user: SessionUser, accessToken: string) => void;
  signOut: (reason?: string) => void;
  idleRemainingMs: number;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Only the non-sensitive profile is persisted; no tokens ever touch storage. */
const PROFILE_KEY = 'medicore.profile';
const WARN_AT_MS = 2 * 60 * 1000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [idleRemainingMs, setIdleRemainingMs] = useState(SESSION_IDLE_TIMEOUT_MS);
  const lastActivity = useRef(Date.now());

  const signOut = useCallback(
    (reason?: string) => {
      setUser(null);
      setAccessToken(null);
      sessionStorage.removeItem(PROFILE_KEY);
      router.replace(`/login${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`);
    },
    [router],
  );

  const signIn = useCallback((nextUser: SessionUser, accessToken: string) => {
    setAccessToken(accessToken);
    sessionStorage.setItem(PROFILE_KEY, JSON.stringify(nextUser));
    lastActivity.current = Date.now();
    setUser(nextUser);
  }, []);

  // On mount the in-memory access token is gone (page load), but the httpOnly
  // refresh cookie survives. Exchange it for a fresh access token so a reload does
  // not force the user to sign in again.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({}),
        });
        if (!response.ok) return;

        const payload = (await response.json()) as {
          access_token?: string;
          user?: { id: string; email: string; roles: Role[]; locale: string };
        };
        if (cancelled || !payload.access_token) return;

        setAccessToken(payload.access_token);

        const stored = sessionStorage.getItem(PROFILE_KEY);
        const cached = stored ? (JSON.parse(stored) as SessionUser) : null;
        if (payload.user) {
          setUser({ ...payload.user, tenant: cached?.tenant ?? '' });
        } else if (cached) {
          setUser(cached);
        }
        lastActivity.current = Date.now();
      } catch {
        // No usable cookie — the user simply needs to sign in.
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // The client only reacts once the api-client has already tried and failed to
  // refresh, so this fires on a genuinely dead session rather than any 401.
  useEffect(() => {
    setSessionLostHandler(() => signOut('expired'));
    return () => setSessionLostHandler(null);
  }, [signOut]);

  // 15-minute idle auto-logout. The server enforces this too; the client half
  // clears PHI from an unattended screen without waiting for the next request.
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
    () => ({ user, permissions, isRestoring, signIn, signOut, idleRemainingMs }),
    [user, permissions, isRestoring, signIn, signOut, idleRemainingMs],
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
