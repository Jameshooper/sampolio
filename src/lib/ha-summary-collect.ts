/**
 * Gather one user's summary numbers and push them to Home Assistant.
 *
 * Split from `ha-summary.ts` so the payload shape and its privacy rules stay
 * testable without touching the database: everything here is I/O, everything
 * there is pure.
 *
 * SERVER-ONLY PLAIN MODULE — not 'use server', same reasoning as
 * split-notify.ts and ha-summary.ts.
 */
import { calculateProjection } from '@/lib/projection';
import { getActiveAccounts } from '@/lib/db/accounts';
import { getBankConnections } from '@/lib/db/bank-connections';
import {
  computeCardBillTransfersForAccount,
  gatherProjectionInputs,
} from '@/lib/projection-inputs';
import { buildHaSummary, getHaSummaryWebhook, sendHaSummary } from '@/lib/ha-summary';
import type { BankAccountLink, Currency, MonthlyProjection } from '@/types';

/** The calendar month the summary is about. */
function currentYearMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Build and send one user's summary. Returns false when the feature is off,
 * when the user has nothing to report, or when delivery failed — never throws.
 */
export async function pushHaSummaryForUser(userId: string, now = new Date()): Promise<boolean> {
  const webhookUrl = getHaSummaryWebhook();
  if (!webhookUrl) return false;

  try {
    const accounts = await getActiveAccounts(userId);
    if (accounts.length === 0) return false;

    const yearMonth = currentYearMonth(now);
    const perAccount: { account: (typeof accounts)[number]; currentMonth: MonthlyProjection | undefined }[] = [];

    for (const account of accounts) {
      const inputs = await gatherProjectionInputs(userId, account.id);
      if (!inputs) continue;

      const cardBillTransfers = await computeCardBillTransfersForAccount(
        userId,
        account.id,
        account,
        inputs.recurringItems,
        inputs.plannedItems
      );

      // The same call shape the app's own views use, so the numbers pushed to
      // Home Assistant are the numbers on screen — including card bills, which
      // is why the card-tagged items are excluded from the direct lists.
      const months = calculateProjection(
        account,
        inputs.directRecurring,
        inputs.directPlanned,
        inputs.taxedIncomes,
        undefined,
        inputs.latestSnapshot,
        inputs.mortgageTransfers,
        inputs.budgetTransfers,
        cardBillTransfers,
        inputs.currentMonthActuals,
        inputs.goalTransfers,
        inputs.tripTransfers
      );

      perAccount.push({ account, currentMonth: months.find((m) => m.yearMonth === yearMonth) });
    }

    const cards: BankAccountLink[] = (await getBankConnections(userId)).flatMap(
      (connection) => connection.linkedAccounts ?? []
    );

    const currency: Currency = accounts[0]?.currency ?? 'EUR';
    const payload = buildHaSummary({ accounts: perAccount, cards, currency, now });
    return await sendHaSummary(payload, webhookUrl);
  } catch (error) {
    // Error NAME only — the message could carry account detail.
    console.warn(
      `[ha-summary] Could not build the summary: ${error instanceof Error ? error.name : 'unknown error'}.`
    );
    return false;
  }
}
