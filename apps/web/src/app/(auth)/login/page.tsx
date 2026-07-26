'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import type { Role } from '@medicore/shared-types';
import { api, ApiError } from '@/lib/api-client';
import { useI18n, LOCALE_META } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { Field } from '@/components/ui';

interface LoginResponse {
  access_token?: string;
  mfa_required?: boolean;
  mfa_token?: string;
  user?: { id: string; email: string; roles: Role[]; locale: string };
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary for the page to prerender.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { t, locale, setLocale, locales } = useI18n();
  const { signIn } = useSession();

  const [tenant, setTenant] = useState(process.env.NEXT_PUBLIC_DEFAULT_TENANT ?? 'demo');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const reason = params.get('reason');
  const reasonMessage =
    reason === 'idle' ? t('errors.sessionTimeout') : reason === 'expired' ? t('auth.sessionExpired') : null;

  const complete = (result: LoginResponse) => {
    if (!result.access_token || !result.user) return;
    signIn({ ...result.user, tenant }, result.access_token);
    router.replace('/dashboard');
  };

  const login = useMutation<LoginResponse, Error>({
    mutationFn: () => api.post<LoginResponse>('/auth/login', { tenant, email, password }, { skipAuthRefresh: true }),
    onSuccess: (result) => {
      if (result.mfa_required && result.mfa_token) {
        setMfaToken(result.mfa_token);
        return;
      }
      complete(result);
    },
  });

  const verify = useMutation<LoginResponse, Error>({
    mutationFn: () => api.post<LoginResponse>('/auth/mfa/verify', { mfa_token: mfaToken, code }, { skipAuthRefresh: true }),
    onSuccess: complete,
  });

  const active = mfaToken ? verify : login;
  const message =
    active.error instanceof ApiError ? active.error.message : active.error ? t('errors.generic') : null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold text-sky-700 dark:text-sky-400">{t('common.appName')}</h1>
        </div>

        {reasonMessage && (
          <div className="card mb-3 border-amber-300 bg-amber-50 text-sm text-amber-900" role="status">
            {reasonMessage}
          </div>
        )}

        <form
          className="card space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            active.mutate();
          }}
        >
          {!mfaToken ? (
            <>
              <Field label={t('common.appName')} required>
                <input
                  className="input"
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  autoComplete="organization"
                  required
                />
              </Field>

              <Field label={t('auth.email')} required>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  required
                />
              </Field>

              <Field label={t('auth.password')} required>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  minLength={8}
                  required
                />
              </Field>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{t('auth.mfaTitle')}</p>
              <Field label={t('auth.mfaCode')} required>
                <input
                  className="input text-center font-mono text-lg tracking-widest"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </Field>
            </>
          )}

          {message && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {message}
            </p>
          )}

          <button type="submit" className="btn-primary w-full" disabled={active.isPending}>
            {active.isPending ? t('common.loading') : mfaToken ? t('auth.verify') : t('auth.signIn')}
          </button>

          {!mfaToken && (
            <a
              href={`/api/auth/oauth/authorize?tenant=${encodeURIComponent(tenant)}`}
              className="btn-secondary w-full"
            >
              {t('auth.sso')}
            </a>
          )}
        </form>

        <div className="mt-4 text-center">
          <select
            className="input w-auto py-1 text-xs"
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            aria-label={t('common.language')}
          >
            {locales.map((c) => (
              <option key={c} value={c}>
                {LOCALE_META[c].label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </main>
  );
}
