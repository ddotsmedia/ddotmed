import { AppShell } from '@/components/AppShell';

/**
 * Administrative route group: the executive dashboard, the analytics tabs and the
 * report builder. Shares the authenticated shell with (app); the separate group
 * exists so these screens can later take a wider layout than the clinical ones
 * without disturbing them.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
