'use client';

import { useEffect } from 'react';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { getLatestCompletedSession } from '@/lib/actions/reconciliation';
import { getCurrentYearMonth } from '@/lib/projection';
import { isCheckInDue } from '@/lib/checkin-utils';

/**
 * Local (device-only) monthly check-in notification. Mounted once in
 * AppLayout; renders nothing. On app open it no-ops entirely unless ALL of:
 *  - the user opted in (checkInNotificationsEnabled, and reminders on),
 *  - the browser's Notification permission is granted,
 *  - the check-in is due (same logic as the Overview banner —
 *    `isCheckInDue` in src/lib/checkin-utils.ts),
 *  - this device hasn't already notified for the current month
 *    (localStorage `sampolio-checkin-notified-YYYY-MM`).
 *
 * The notification is shown via the service worker registration (no push
 * service, no server infra) with a per-month tag so re-shows collapse.
 * Clicking it opens /overview (notificationclick handler in public/sw.js).
 */
export function CheckinNotifier() {
  useEffect(() => {
    let cancelled = false;

    async function maybeNotify() {
      try {
        if (typeof window === 'undefined') return;
        if (!('Notification' in window)) return;
        if (Notification.permission !== 'granted') return;

        const currentMonth = getCurrentYearMonth();
        const storageKey = `sampolio-checkin-notified-${currentMonth}`;
        if (localStorage.getItem(storageKey)) return;

        const prefsRes = await getUserPreferences();
        if (cancelled || !prefsRes.success || !prefsRes.data) return;
        const prefs = prefsRes.data;
        if (prefs.checkInNotificationsEnabled !== true) return;
        const remindersEnabled = prefs.checkInRemindersEnabled !== false;
        if (!remindersEnabled) return;

        // Same data source as Overview: the latest completed check-in session.
        const sessionRes = await getLatestCompletedSession();
        if (cancelled || !sessionRes.success) return;
        const lastReconciled = sessionRes.data?.yearMonth ?? null;
        if (!isCheckInDue(remindersEnabled, lastReconciled, currentMonth)) return;

        const title = 'Time for your monthly check-in';
        const options: NotificationOptions = {
          body: lastReconciled
            ? `Your last check-in was ${lastReconciled}. Verify your balances for ${currentMonth} to keep projections accurate.`
            : `Verify your balances for ${currentMonth} to keep projections accurate.`,
          tag: `checkin-${currentMonth}`,
          icon: '/icons/icon-192.png',
        };

        // Prefer the service worker registration (required on installed PWAs,
        // esp. Android); fall back to a plain Notification where no SW is
        // registered (e.g. dev, where the SW deliberately doesn't install).
        const registration =
          'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
        if (cancelled) return;
        if (registration) {
          await registration.showNotification(title, options);
        } else {
          new Notification(title, options);
        }
        localStorage.setItem(storageKey, new Date().toISOString());
      } catch {
        // Best-effort convenience — never let it surface an error.
      }
    }

    maybeNotify();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
