'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { updateTag } from 'next/cache';
import { auth } from '@/lib/auth';
import type {
  ApiResponse,
  BankConnection,
  BankSyncRun,
  BankTransaction,
  FinancialAccount,
} from '@/types';
import {
  getBankConnectionById as dbGetConnection,
  updateBankConnection as dbUpdateConnection,
} from '@/lib/db/bank-connections';
import { getAccountById as dbGetAccount, updateAccount as dbUpdateAccount } from '@/lib/db/accounts';
import { teardownBankConnection } from '@/lib/bank/teardown';
import {
  cachedGetBankConnections,
  cachedGetBankConnectionById,
  cachedGetBankSyncRuns,
  cachedGetBankTransactions,
  cachedGetAccountProjectionData,
} from '@/lib/db/cached';
import { detectRecurringCandidates, type RecurringSuggestion, type ExistingItemLike } from '@/lib/recurring-detection';
import { getMortgageTransfersForAccount, getLinkedCashBankTransactions } from '@/lib/projection-inputs';
import { matchCardPaymentsWithFingerprints } from '@/lib/bank/card-payment-match';
import { beginConnection, beginReconnect } from '@/lib/bank/connect';
import { runSync } from '@/lib/bank/sync';
import { redactBankError } from '@/lib/bank/client';
import { getAspspDetailsCached } from '@/lib/bank/aspsp-info';
import { computeCardBilling, transactionsForCycle, toCardTxn, isCardPayment } from '@/lib/bank/card-billing';
import { isBankFeatureConfigured, MIN_MANUAL_REFRESH_INTERVAL_MS } from '@/lib/bank/constants';
import { getConsentExpiryInfo, isSyncFailing, effectiveCardNumbers } from '@/lib/bank-utils';
import {
  startBankConnectionSchema,
  updateBankAccountLinkSchema,
} from '@/lib/schemas/bank.schema';

/** Whether the Enable Banking feature has its secrets configured (else hidden). */
export async function getBankFeatureStatus(): Promise<ApiResponse<{ configured: boolean }>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
  return { success: true, data: { configured: isBankFeatureConfigured() } };
}

export async function getBankConnections(): Promise<ApiResponse<BankConnection[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const connections = await cachedGetBankConnections(session.user.id);
    return { success: true, data: connections };
  } catch (error) {
    console.error('Get bank connections error:', error);
    return { success: false, error: 'Failed to fetch bank connections' };
  }
}

/** List the banks (ASPSPs) Enable Banking offers for a country, for the picker. */
export async function listBankAspsps(
  country = 'FI'
): Promise<ApiResponse<{ name: string; country: string }[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    if (!isBankFeatureConfigured()) {
      return { success: false, error: 'Bank sync is not configured on this server' };
    }
    // Reads through the same TTL cache `beginConnection`/`beginReconnect` use for
    // `maximum_consent_validity` lookups, so the connect that follows the picker
    // reuses this fetch instead of hitting `GET /aspsps` again.
    const details = await getAspspDetailsCached(country);
    if (!details) return { success: false, error: 'Could not load the list of banks' };
    return { success: true, data: details.map((a) => ({ name: a.name, country: a.country })) };
  } catch (error) {
    console.error('List ASPSPs error:', redactBankError(error));
    return { success: false, error: 'Could not load the list of banks' };
  }
}

/** Start a connection: returns the bank's SCA URL for the browser to redirect to. */
export async function startBankConnection(
  input: z.infer<typeof startBankConnectionSchema>
): Promise<ApiResponse<{ authUrl: string }>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    if (!isBankFeatureConfigured()) {
      return { success: false, error: 'Bank sync is not configured on this server' };
    }
    const parsed = startBankConnectionSchema.parse(input);
    const { authUrl } = await beginConnection(session.user.id, parsed.aspspName, parsed.aspspCountry);
    return { success: true, data: { authUrl } };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Start bank connection error:', redactBankError(error));
    return { success: false, error: 'Could not start the bank connection' };
  }
}

/** Renew an expiring/expired consent: re-run SCA on the SAME connection, keeping
 * all account mappings + config. Returns the bank's auth URL for redirect. */
export async function reconnectBankConnection(
  connectionId: string
): Promise<ApiResponse<{ authUrl: string }>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    if (!isBankFeatureConfigured()) {
      return { success: false, error: 'Bank sync is not configured on this server' };
    }
    const connection = await dbGetConnection(session.user.id, connectionId);
    if (!connection) return { success: false, error: 'Connection not found' };
    const { authUrl } = await beginReconnect(session.user.id, connectionId);
    return { success: true, data: { authUrl } };
  } catch (error) {
    console.error('Reconnect bank connection error:', redactBankError(error));
    return { success: false, error: 'Could not start reconnection' };
  }
}

/** The attended PSU context for a request-scoped call: IP (higher rate
 * allowance) + user agent (paired with the IP — never sent alone, see client.ts). */
async function getPsuContext(): Promise<{ psuIp?: string; psuUserAgent?: string }> {
  try {
    const h = await headers();
    const fwd = h.get('x-forwarded-for');
    const psuIp = fwd ? fwd.split(',')[0].trim() : h.get('x-real-ip') ?? undefined;
    const psuUserAgent = h.get('user-agent') ?? undefined;
    return { psuIp, psuUserAgent };
  } catch {
    return {};
  }
}

/** On-demand "Refresh now". PSU is present, so we pass their IP + user agent
 * (higher allowance). */
export async function refreshBankConnection(
  connectionId: string
): Promise<ApiResponse<BankSyncRun>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };

    const connection = await dbGetConnection(session.user.id, connectionId);
    if (!connection) return { success: false, error: 'Connection not found' };

    if (connection.lastSyncAt) {
      const sinceMs = Date.now() - new Date(connection.lastSyncAt).getTime();
      if (sinceMs < MIN_MANUAL_REFRESH_INTERVAL_MS) {
        return { success: false, error: 'Just refreshed — please wait a few minutes before retrying' };
      }
    }

    const { psuIp, psuUserAgent } = await getPsuContext();
    const run = await runSync(session.user.id, connectionId, 'manual', { psuIp, psuUserAgent });
    return { success: true, data: run };
  } catch (error) {
    console.error('Refresh bank connection error:', redactBankError(error));
    return { success: false, error: 'Refresh failed' };
  }
}

/** Disconnect: best-effort revoke at the bank, then delete all local bank data. */
export async function disconnectBankConnection(
  connectionId: string
): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };

    const connection = await dbGetConnection(session.user.id, connectionId);
    if (!connection) return { success: false, error: 'Connection not found' };

    await teardownBankConnection(session.user.id, connection);

    updateTag(`user:${session.user.id}:bank-connections`);
    updateTag(`user:${session.user.id}:bank-connection:${connectionId}`);
    return { success: true };
  } catch (error) {
    console.error('Disconnect bank connection error:', redactBankError(error));
    return { success: false, error: 'Disconnect failed' };
  }
}

/** Edit how a real bank account is used (role, linked account, card cycle, exclude). */
export async function updateBankAccountLink(
  connectionId: string,
  linkId: string,
  data: z.infer<typeof updateBankAccountLinkSchema>
): Promise<ApiResponse<BankConnection>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const parsed = updateBankAccountLinkSchema.parse(data);

    const connection = await dbGetConnection(session.user.id, connectionId);
    if (!connection) return { success: false, error: 'Connection not found' };
    const idx = connection.linkedAccounts.findIndex((l) => l.id === linkId);
    if (idx < 0) return { success: false, error: 'Account link not found' };

    const link = connection.linkedAccounts[idx];
    const next = { ...link };
    if (parsed.accountRole !== undefined) next.accountRole = parsed.accountRole;
    if (parsed.customName !== undefined) {
      const trimmed = parsed.customName?.trim();
      next.customName = trimmed ? trimmed : undefined;
    }
    if (parsed.linkedFinancialAccountId !== undefined)
      next.linkedFinancialAccountId = parsed.linkedFinancialAccountId ?? undefined;
    if (parsed.isExcluded !== undefined) next.isExcluded = parsed.isExcluded;
    if (parsed.statementDay !== undefined) next.statementDay = parsed.statementDay ?? undefined;
    if (parsed.paymentDueDay !== undefined) next.paymentDueDay = parsed.paymentDueDay ?? undefined;
    if (parsed.creditLimit !== undefined) next.creditLimit = parsed.creditLimit ?? undefined;
    if (parsed.manualCreditLimit !== undefined)
      next.manualCreditLimit = parsed.manualCreditLimit ?? undefined;
    if (parsed.expectedMonthlySpend !== undefined)
      next.expectedMonthlySpend = parsed.expectedMonthlySpend ?? undefined;

    connection.linkedAccounts[idx] = next;
    const updated = await dbUpdateConnection(session.user.id, connectionId, {
      linkedAccounts: connection.linkedAccounts,
    });

    // Mark the linked cash/savings account as bank-synced so its UI reflects it.
    if (
      next.linkedFinancialAccountId &&
      (next.accountRole === 'cash' || next.accountRole === 'savings')
    ) {
      const acct = await dbGetAccount(session.user.id, next.linkedFinancialAccountId);
      if (acct && !acct.bankSyncEnabled) {
        await dbUpdateAccount(session.user.id, next.linkedFinancialAccountId, {
          bankSyncEnabled: true,
        } as Partial<FinancialAccount>);
        updateTag(`user:${session.user.id}:accounts`);
      }
    }

    updateTag(`user:${session.user.id}:bank-connections`);
    updateTag(`user:${session.user.id}:bank-connection:${connectionId}`);
    return updated
      ? { success: true, data: updated }
      : { success: false, error: 'Update failed' };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update bank account link error:', error);
    return { success: false, error: 'Failed to update account link' };
  }
}

export interface ConnectionAttention {
  connectionId: string;
  aspspName: string;
  expired: boolean;
  expiringSoon: boolean;
  daysUntilExpiry: number | null;
  /** Repeatedly failing to sync for a non-expiry reason (e.g. a persistent 400). */
  syncFailing: boolean;
  /** Last error CODE (never PII) — shown to hint at the cause when syncFailing. */
  lastError: string | null;
}

/** Connections that need the user's attention (for the Overview reconnect banner). */
export async function getBankConnectionsNeedingAttention(): Promise<
  ApiResponse<ConnectionAttention[]>
> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const connections = await cachedGetBankConnections(session.user.id);
    const attention = connections
      .map((c) => {
        const info = getConsentExpiryInfo(c);
        return {
          connectionId: c.id,
          aspspName: c.aspspName,
          expired: info.expired,
          expiringSoon: info.expiringSoon,
          daysUntilExpiry: info.daysUntilExpiry,
          // Surface a connection stuck failing for a non-expiry reason — these
          // never flip status to 'expired', so without this they'd silently fail.
          syncFailing: isSyncFailing(c),
          lastError: c.lastError ?? null,
        };
      })
      .filter((c) => c.expired || c.expiringSoon || c.syncFailing);
    return { success: true, data: attention };
  } catch (error) {
    console.error('Get bank attention error:', error);
    return { success: false, error: 'Failed to check bank connections' };
  }
}

export interface CardLiability {
  linkId: string;
  name: string;
  outstanding: number;
  billYearMonth?: string;
  availableCredit?: number; // live available-to-spend (EB ITAV), when the bank exposes it
  creditLimit?: number; // total limit, when known
}

/** Current credit-card outstandings for the net-worth liability band. */
export async function getCardLiabilities(): Promise<ApiResponse<CardLiability[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const connections = await cachedGetBankConnections(userId);
    const out: CardLiability[] = [];
    for (const conn of connections) {
      for (const link of conn.linkedAccounts) {
        if (link.accountRole !== 'credit-card' || link.isExcluded) continue;
        const txs = await cachedGetBankTransactions(userId, link.id);
        // Fill gaps the bank leaves (OP reports only a negative balance and no
        // limit): a card with just a negative lastBalance still contributes its
        // outstanding to net worth, and a manual limit yields available credit.
        const eff = effectiveCardNumbers(link);
        const result = computeCardBilling({
          statementDay: link.statementDay,
          paymentDueDay: link.paymentDueDay,
          outstanding: eff.outstanding,
          lastStatementBalance: link.lastStatementBalance,
          transactions: txs.map(toCardTxn),
        });
        if (result.outstanding > 0.005) {
          out.push({
            linkId: link.id,
            name: link.customName || link.name || `${conn.aspspName} card`,
            outstanding: result.outstanding,
            billYearMonth: result.currentBillYearMonth,
            availableCredit: eff.availableCredit,
            creditLimit: eff.creditLimit,
          });
        }
      }
    }
    return { success: true, data: out };
  } catch (error) {
    console.error('Get card liabilities error:', error);
    return { success: false, error: 'Failed to compute card liabilities' };
  }
}

/**
 * Recurring-looking bank transactions with no matching tracked item, for the
 * account linked to `accountId`'s cash/savings bank links. Computed on demand
 * from cached reads (no background job — updateTag constraints). Dismissals
 * are a client-side concern (localStorage), not stored server-side.
 */
function monthIndexOf(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

export async function getRecurringSuggestions(accountId: string): Promise<ApiResponse<RecurringSuggestion[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const connections = await cachedGetBankConnections(userId);
    const txs = [];
    for (const conn of connections) {
      for (const link of conn.linkedAccounts) {
        if (link.isExcluded || link.linkedFinancialAccountId !== accountId) continue;
        if (link.accountRole !== 'cash' && link.accountRole !== 'savings') continue;
        txs.push(...(await cachedGetBankTransactions(userId, link.id)));
      }
    }
    if (txs.length === 0) return { success: true, data: [] };
    const { recurringItems } = await cachedGetAccountProjectionData(userId, accountId);
    const existing: ExistingItemLike[] = recurringItems.map((r) => ({ name: r.name, amount: r.amount, type: r.type }));
    const currentYearMonth = new Date().toISOString().slice(0, 7);
    // The plan isn't only stored items: a shared mortgage paid from this account
    // injects a monthly `mortgage-payment` line, so the bank transfer that pays
    // it is already covered — feed those amounts in so the detector's
    // existing-item matcher (name OR ±5% amount) suppresses the suggestion.
    // Amounts vary over time (Euribor resets), so include each recent month's.
    const mortgageTransfers = await getMortgageTransfersForAccount(userId, accountId);
    const recentAmounts = new Set<number>();
    for (const t of mortgageTransfers) {
      if (Math.abs(monthIndexOf(t.yearMonth) - monthIndexOf(currentYearMonth)) <= 12) {
        recentAmounts.add(Math.round(t.amount * 100) / 100);
      }
    }
    for (const amount of recentAmounts) {
      existing.push({ name: 'Mortgage payment', amount, type: 'expense' });
    }
    return { success: true, data: detectRecurringCandidates(txs, existing, currentYearMonth) };
  } catch (error) {
    console.error('Get recurring suggestions error:', error);
    return { success: false, error: 'Failed to detect recurring transactions' };
  }
}

export interface CreditCardOption {
  linkId: string;
  label: string;
}

/** Credit-card links the user can tag an expense as "paid by", for item forms. */
export async function getCreditCardOptions(): Promise<ApiResponse<CreditCardOption[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const connections = await cachedGetBankConnections(session.user.id);
    const options: CreditCardOption[] = [];
    for (const conn of connections) {
      for (const link of conn.linkedAccounts) {
        if (link.accountRole !== 'credit-card' || link.isExcluded) continue;
        options.push({ linkId: link.id, label: link.customName || link.name || `${conn.aspspName} card` });
      }
    }
    return { success: true, data: options };
  } catch (error) {
    console.error('Get credit card options error:', error);
    return { success: false, error: 'Failed to load cards' };
  }
}

export interface CardStatementBreakdown {
  linkId: string;
  cardName: string;
  isEstimate: boolean;
  total: number;
  transactions: { name: string; amount: number; date: string }[];
}

/** 'YYYY-MM-DD' for a local Date (matches card-billing's own `ymd`). */
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The statement close date on-or-before `asOfYmd`, given a day-of-month
 * `statementDay` — the same day-clamping recentCloses() uses in card-billing.
 * Used to reconstruct which cycle a past card-bill payment settled.
 */
function statementCloseOnOrBefore(asOfYmd: string, statementDay: number): string {
  const asOf = new Date(`${asOfYmd.slice(0, 10)}T12:00:00`);
  const clampDay = (year: number, month1to12: number, day: number): number => {
    const daysInMonth = new Date(year, month1to12, 0).getDate();
    return Math.min(Math.max(day, 1), daysInMonth);
  };
  const y = asOf.getFullYear();
  const m = asOf.getMonth() + 1; // 1-12
  const thisMonthClose = new Date(y, m - 1, clampDay(y, m, statementDay));
  const close = asOf >= thisMonthClose ? thisMonthClose : new Date(y, m - 2, clampDay(y, m - 1, statementDay));
  return localYmd(close);
}

/**
 * For each credit card billing `accountId` with a statement due in `yearMonth`,
 * return the individual purchases that make up that bill — so the cashflow Sankey
 * can drill a card bill down into its transactions. Empty when no card bills that
 * month, so non-card months are unaffected.
 */
export async function getCardStatementBreakdownForAccount(
  accountId: string,
  yearMonth: string
): Promise<ApiResponse<CardStatementBreakdown[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const userId = session.user.id;
    const connections = await cachedGetBankConnections(userId);
    const out: CardStatementBreakdown[] = [];
    // The paying account's cash ledger, loaded lazily once — only the
    // retrospective fallback below needs it.
    let cashTxsPromise: Promise<BankTransaction[]> | null = null;
    const getCashTxs = () => (cashTxsPromise ??= getLinkedCashBankTransactions(userId, accountId));
    for (const conn of connections) {
      for (const link of conn.linkedAccounts) {
        if (link.accountRole !== 'credit-card' || link.isExcluded) continue;
        if (link.linkedFinancialAccountId !== accountId) continue;
        const txs = await cachedGetBankTransactions(userId, link.id);
        const cardName = link.customName || link.name || `${conn.aspspName} card`;
        const cycleTransactions = (closeYmd: string) =>
          transactionsForCycle(txs, closeYmd)
            .filter((t) => t.amount < 0)
            .map((t) => ({
              name: t.counterpartyName || t.remittanceInfo?.split('\n')[0] || 'Transaction',
              amount: Math.abs(t.amount),
              date: t.bookingDate,
            }))
            .sort((a, b) => b.amount - a.amount);

        const result = computeCardBilling({
          statementDay: link.statementDay,
          paymentDueDay: link.paymentDueDay,
          outstanding: link.outstanding,
          lastStatementBalance: link.lastStatementBalance,
          transactions: txs.map(toCardTxn),
        });
        let emitted = false;
        for (const bill of result.bills) {
          if (bill.billYearMonth !== yearMonth) continue;
          emitted = true;
          out.push({
            linkId: link.id,
            cardName,
            isEstimate: bill.isEstimate,
            // For the open cycle the drill-down lists actual purchases only, so
            // its total is the actual spend so far (not the blended forecast).
            total: bill.basis === 'open-cycle' ? (bill.actualToDate ?? bill.amount) : bill.amount,
            transactions: cycleTransactions(bill.statementCloseDate),
          });
        }

        // Retrospective (past-month) fallback: computeCardBilling only emits
        // bills anchored to statement due dates near "now", so an arbitrary past
        // `yearMonth` gets nothing above. Reconstruct the month's card payments
        // exactly the way the retrospective line does — by matching this card's
        // settlement credits against the CASH ledger's debits (±4 days, plus
        // fingerprint learning). Because the card-side credit often books a day
        // or two after the cash debit — possibly in the NEXT month for a
        // month-end payment — bucketing by credit month would miss it. Matching
        // runs over ALL booked debits (not just the requested month's) so the
        // fingerprint learned from a recent settlement propagates to an older
        // month whose card ledger no longer serves the settlement credit; the
        // matched debits are then filtered down to `yearMonth`.
        if (!emitted) {
          const credits = txs
            .filter((t) => t.status === 'booked' && isCardPayment(toCardTxn(t)))
            .map((t) => ({ date: t.bookingDate.slice(0, 10), amount: Math.abs(t.amount) }));
          if (credits.length > 0) {
            const cashTxs = await getCashTxs();
            const allDebits = cashTxs
              .filter((t) => t.status === 'booked' && t.amount < 0)
              .map((t) => ({
                id: t.id,
                bookingDate: t.bookingDate,
                amount: t.amount,
                counterpartyName: t.counterpartyName,
                remittanceInfo: t.remittanceInfo,
              }));
            const matches = matchCardPaymentsWithFingerprints(allDebits, [{ linkId: link.id, cardName, credits }]);
            const matchedDebits = allDebits.filter(
              (d) => matches.has(d.id) && d.bookingDate.slice(0, 7) === yearMonth
            );
            if (matchedDebits.length > 0) {
              // Total = the matched cash debits, so it always equals the
              // retrospective "Card: X" line this breakdown expands.
              const total = matchedDebits.reduce((s, d) => s + Math.abs(d.amount), 0);
              // The latest payment settles the most recently closed statement;
              // the cycle is (close − 1 month, close], close being the statement
              // close on-or-before that payment (or the payment date, no config).
              const latest = matchedDebits.reduce((a, b) => (a.bookingDate >= b.bookingDate ? a : b));
              const closeYmd = link.statementDay
                ? statementCloseOnOrBefore(latest.bookingDate, link.statementDay)
                : latest.bookingDate.slice(0, 10);
              const cycleTxns = cycleTransactions(closeYmd);
              // Only emit a breakdown when the card ledger actually has purchase
              // rows for the cycle. A fingerprint-matched month whose card
              // ledger lacks purchases must NOT emit an empty breakdown — the
              // retro "Card: X" line still renders, just without drill-down.
              if (cycleTxns.length > 0) {
                out.push({
                  linkId: link.id,
                  cardName,
                  isEstimate: false,
                  total,
                  transactions: cycleTxns,
                });
              }
            }
          }
        }
      }
    }
    return { success: true, data: out };
  } catch (error) {
    console.error('Get card statement breakdown error:', error);
    return { success: false, error: 'Failed to load card statement breakdown' };
  }
}

export async function getBankSyncRuns(
  connectionId: string
): Promise<ApiResponse<BankSyncRun[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const runs = await cachedGetBankSyncRuns(session.user.id, connectionId);
    return { success: true, data: runs };
  } catch (error) {
    console.error('Get bank sync runs error:', error);
    return { success: false, error: 'Failed to fetch sync runs' };
  }
}

/** Read-only transaction ledger for one linked account (verifies ownership). */
export async function getBankTransactionsForLink(
  linkId: string
): Promise<ApiResponse<BankTransaction[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const connections = await cachedGetBankConnections(session.user.id);
    const owns = connections.some((c) => c.linkedAccounts.some((l) => l.id === linkId));
    if (!owns) return { success: false, error: 'Account not found' };
    const txs = await cachedGetBankTransactions(session.user.id, linkId);
    return { success: true, data: txs };
  } catch (error) {
    console.error('Get bank transactions error:', error);
    return { success: false, error: 'Failed to fetch transactions' };
  }
}

// Keep this reference so cachedGetBankConnectionById is exercised by a typed
// accessor for detail views without widening the public surface unnecessarily.
export async function getBankConnection(
  connectionId: string
): Promise<ApiResponse<BankConnection>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Unauthorized' };
    const connection = await cachedGetBankConnectionById(session.user.id, connectionId);
    return connection
      ? { success: true, data: connection }
      : { success: false, error: 'Connection not found' };
  } catch (error) {
    console.error('Get bank connection error:', error);
    return { success: false, error: 'Failed to fetch connection' };
  }
}
