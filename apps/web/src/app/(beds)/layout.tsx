import { AppShell } from '@/components/AppShell';

/**
 * Bed management route group. Shares the authenticated shell; the separate group
 * keeps the board and the admissions list together so they can later take a
 * ward-wide layout (occupancy strip, transfer rail) of their own.
 */
export default function BedsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
