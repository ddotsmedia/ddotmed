import { AppShell } from '@/components/AppShell';

/**
 * Clinical route group. Shares the authenticated shell with (app); the separate
 * group exists so clinical screens can later take their own layout concerns
 * (patient context bar, quick-order rail) without touching admin screens.
 */
export default function ClinicalLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
