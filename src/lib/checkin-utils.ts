import { getMonthsBetween } from '@/lib/projection';
import type { YearMonth } from '@/types';

/**
 * Whether the monthly check-in is due: reminders enabled AND the latest
 * completed reconciliation session is missing or older than the current month.
 *
 * Single source of truth shared by the Overview reminder banner
 * (`isCheckInBannerVisible` in banner-stack.tsx) and the local PWA
 * check-in notification (checkin-notifier.tsx).
 */
export function isCheckInDue(
  checkInRemindersEnabled: boolean,
  lastReconciled: YearMonth | null,
  currentYearMonth: YearMonth
): boolean {
  if (!checkInRemindersEnabled) return false;
  if (!lastReconciled) return true;
  return getMonthsBetween(lastReconciled, currentYearMonth) >= 1;
}
