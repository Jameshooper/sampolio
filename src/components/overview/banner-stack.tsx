'use client';

import { AlertBanner } from '@/components/ui/alert-banner';
import { BankAttentionBanner } from '@/components/bank/bank-attention-banner';
import { formatYearMonth } from '@/lib/constants';
import { getMonthsBetween } from '@/lib/projection';
import { isCheckInDue } from '@/lib/checkin-utils';
import type { ConnectionAttention } from '@/lib/actions/bank';
import type { Budget, YearMonth } from '@/types';
import { MdSync, MdPercent, MdLuggage } from 'react-icons/md';

export interface BannerStackProps {
    checkInRemindersEnabled: boolean;
    lastReconciled: YearMonth | null;
    currentYearMonth: YearMonth;
    onStartCheckIn: () => void;
    euriborDue: { name: string; lastResetDate: Date } | null;
    onUpdateEuribor: () => void;
    bankAttention: ConnectionAttention[];
    onReconnectBank: () => void;
    budgetBanner: { type: 'upcoming' | 'over-budget'; budget: Budget; category?: string } | null;
    onOpenBudget: (budgetId: string) => void;
}

/** Whether the monthly check-in reminder banner is due (also used by the page
 * header to hide its redundant check-in button while the banner shows).
 * Pure logic lives in `src/lib/checkin-utils.ts` (shared with the local
 * check-in notification). */
export function isCheckInBannerVisible(
    checkInRemindersEnabled: boolean,
    lastReconciled: YearMonth | null,
    currentYearMonth: YearMonth
): boolean {
    return isCheckInDue(checkInRemindersEnabled, lastReconciled, currentYearMonth);
}

/** The Overview page's reminder banners (check-in, Euribor, bank attention,
 * budget), all rendered through the shared AlertBanner primitive. */
export function BannerStack({
    checkInRemindersEnabled,
    lastReconciled,
    currentYearMonth,
    onStartCheckIn,
    euriborDue,
    onUpdateEuribor,
    bankAttention,
    onReconnectBank,
    budgetBanner,
    onOpenBudget,
}: BannerStackProps) {
    const monthsBehind = lastReconciled ? getMonthsBetween(lastReconciled, currentYearMonth) : null;
    const showCheckIn = isCheckInBannerVisible(checkInRemindersEnabled, lastReconciled, currentYearMonth);

    return (
        <>
            {/* Check-in reminder — detects the exact month that still needs a check-in.
                Optional: bank-synced users can turn it off in Settings → General. */}
            {showCheckIn && (
                <AlertBanner
                    severity="warn"
                    icon={<MdSync size={20} />}
                    action={{ label: lastReconciled ? 'Check in now' : 'Start check-in', onClick: onStartCheckIn }}
                >
                    {!lastReconciled
                        ? <>You haven&apos;t done a check-in yet. Verify your balances for {formatYearMonth(currentYearMonth)} to keep projections accurate.</>
                        : monthsBehind === 1
                            ? <>Your last check-in was {formatYearMonth(lastReconciled)}. Time to check in for {formatYearMonth(currentYearMonth)}.</>
                            : <>It&apos;s been {monthsBehind} months since your last check-in ({formatYearMonth(lastReconciled)}). Check in for {formatYearMonth(currentYearMonth)} to keep your forecasts accurate.</>}
                </AlertBanner>
            )}

            {/* Euribor rate reminder — surfaced here so the yearly reset isn't missed. */}
            {euriborDue && (
                <AlertBanner
                    severity="warn"
                    icon={<MdPercent size={20} />}
                    action={{ label: 'Update rate', onClick: onUpdateEuribor }}
                >
                    The mortgage interest rate for <b>{euriborDue.name}</b> is due for its yearly update — the bank resets it (the 12-month Euribor reference rate) around{' '}
                    {euriborDue.lastResetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Enter the new rate from your bank so your payments stay accurate.
                </AlertBanner>
            )}

            {/* Bank attention — consent expiry (PSD2 needs a fresh SCA every ~180 days)
                or a connection that keeps failing to sync for a non-expiry reason.
                Shared with Home — see src/components/bank/bank-attention-banner.tsx. */}
            <BankAttentionBanner attention={bankAttention} onAction={onReconnectBank} />

            {/* Budget reminder — over-budget warning while a trip is running, or a
                heads-up that one is about to start. */}
            {budgetBanner?.type === 'over-budget' && (
                <AlertBanner
                    severity="warn"
                    icon={<MdLuggage size={20} />}
                    action={{ label: 'Open the log', onClick: () => onOpenBudget(budgetBanner.budget.id) }}
                >
                    You&apos;ve spent more than planned on <b>{budgetBanner.category}</b> for &ldquo;{budgetBanner.budget.name}&rdquo;.
                </AlertBanner>
            )}
            {budgetBanner?.type === 'upcoming' && (
                <AlertBanner
                    severity="info"
                    icon={<MdLuggage size={20} />}
                    action={{ label: 'View budget', onClick: () => onOpenBudget(budgetBanner.budget.id), severity: 'info' }}
                >
                    Your budget &ldquo;{budgetBanner.budget.name}&rdquo; starts in {formatYearMonth(budgetBanner.budget.startMonth)}. Give it a look before the trip.
                </AlertBanner>
            )}
        </>
    );
}
