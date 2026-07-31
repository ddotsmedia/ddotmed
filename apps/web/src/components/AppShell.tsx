'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CriticalAlert, SyncStatus } from '@medicore/ui-components';
import type { Permission } from '@medicore/shared-types';
import { LOCALE_META, useI18n } from '@/lib/i18n';
import { SESSION_WARN_AT_MS, usePermissions, useSession } from '@/lib/session';
import { useRealtime } from '@/lib/realtime';
import { api } from '@/lib/api-client';

interface NavItem {
  href: string;
  labelKey: string;
  permission?: Permission;
}

const NAV: NavItem[] = [
  { href: '/dashboard', labelKey: 'common.dashboard' },
  { href: '/patients', labelKey: 'clinical.patients', permission: 'patient:read' },
  { href: '/appointments', labelKey: 'clinical.appointment', permission: 'patient:read' },
  { href: '/beds', labelKey: 'clinical.bed', permission: 'bed:manage' },
  { href: '/lab', labelKey: 'clinical.labResults', permission: 'lab:order' },
  { href: '/radiology', labelKey: 'clinical.radiology', permission: 'imaging:order' },
  { href: '/nursing', labelKey: 'clinical.administer', permission: 'medication:administer' },
  { href: '/pharmacy', labelKey: 'clinical.dispense', permission: 'medication:dispense' },
  { href: '/queue', labelKey: 'clinical.dispenseQueue', permission: 'medication:dispense' },
  { href: '/inventory', labelKey: 'clinical.stockList', permission: 'inventory:manage' },
  { href: '/invoices', labelKey: 'billing.invoices', permission: 'invoice:read' },
  { href: '/claims', labelKey: 'billing.claims', permission: 'claim:read' },
  { href: '/payments', labelKey: 'billing.payments', permission: 'payment:write' },
  { href: '/analytics', labelKey: 'common.dashboard', permission: 'config:manage' },
  { href: '/config', labelKey: 'common.settings', permission: 'config:manage' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, setLocale, locales } = useI18n();
  const { user, signOut, idleRemainingMs } = useSession();
  const { can } = usePermissions();
  const { connected, alerts, dismissAlert } = useRealtime();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!user) router.replace('/login');
  }, [user, router]);

  if (!user) return null;

  const visible = NAV.filter((item) => !item.permission || can(item.permission));
  const lifeThreatening = alerts.find((a) => a.severity === 'life-threatening');
  const showIdleWarning = idleRemainingMs > 0 && idleRemainingMs <= SESSION_WARN_AT_MS;

  return (
    <div className="min-h-dvh">
      {/* A life-threatening alert takes the whole screen; it must not be missed. */}
      {lifeThreatening && (
        <CriticalAlert
          severity="life-threatening"
          title={lifeThreatening.title}
          detail={lifeThreatening.detail}
          value={lifeThreatening.value}
          referenceRange={lifeThreatening.reference_range}
          fullScreen
          acknowledgeLabel={t('common.confirm')}
          onAcknowledge={() => dismissAlert(lifeThreatening.dedupe_key)}
        />
      )}

      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900">
        <button
          type="button"
          className="btn-secondary md:hidden"
          onClick={() => setNavOpen((v) => !v)}
          aria-label={t('common.actions')}
          aria-expanded={navOpen}
        >
          ☰
        </button>

        <Link href="/dashboard" className="text-lg font-bold text-sky-700 dark:text-sky-400">
          {t('common.appName')}
        </Link>

        <div className="ms-auto flex items-center gap-2">
          <SyncStatus state={connected ? 'online' : 'offline'} t={t} />

          <select
            className="input w-auto py-1 text-xs"
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            aria-label={t('common.language')}
          >
            {locales.map((code) => (
              <option key={code} value={code}>
                {LOCALE_META[code].label}
              </option>
            ))}
          </select>

          <span className="hidden text-xs text-slate-600 sm:inline dark:text-slate-300">
            {user.email}
          </span>

          <button
            type="button"
            className="btn-secondary py-1 text-xs"
            onClick={async () => {
              await api.post('/auth/logout').catch(() => undefined);
              signOut();
            }}
          >
            {t('auth.logout')}
          </button>
        </div>
      </header>

      {showIdleWarning && (
        <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900" role="status">
          {t('auth.sessionExpiring')} — {Math.ceil(idleRemainingMs / 1000)}s
        </div>
      )}

      <div className="flex">
        <nav
          className={clsx(
            'w-56 shrink-0 border-e border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900',
            navOpen ? 'block' : 'hidden md:block',
          )}
          aria-label={t('common.actions')}
        >
          <ul className="space-y-1">
            {visible.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setNavOpen(false)}
                  className={clsx(
                    'block rounded-md px-3 py-2 text-sm',
                    pathname.startsWith(item.href)
                      ? 'bg-sky-100 font-semibold text-sky-900 dark:bg-sky-900/40 dark:text-sky-200'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                  )}
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 p-4">
          {alerts
            .filter((a) => a.severity !== 'life-threatening')
            .slice(0, 3)
            .map((alert) => (
              <CriticalAlert
                key={alert.dedupe_key}
                severity={alert.severity}
                title={alert.title}
                detail={alert.detail}
                value={alert.value}
                referenceRange={alert.reference_range}
                acknowledgeLabel={t('common.confirm')}
                onAcknowledge={() => dismissAlert(alert.dedupe_key)}
                className="mb-3"
              />
            ))}
          {children}
        </main>
      </div>
    </div>
  );
}
