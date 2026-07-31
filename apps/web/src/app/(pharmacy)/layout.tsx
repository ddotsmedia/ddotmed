import { AppShell } from '@/components/AppShell';

/**
 * Pharmacy route group. Shares the authenticated shell; the separate group keeps
 * dispensing and stock screens together so they can later take a counter-specific
 * layout (scanner focus, till session) without touching clinical screens.
 */
export default function PharmacyLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
