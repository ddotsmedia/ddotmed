import { AppShell } from '@/components/AppShell';

/**
 * Billing route group. Shares the authenticated shell; the separate group keeps
 * invoicing, payments and the revenue-cycle dashboard together.
 */
export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
