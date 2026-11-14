/**
 * Account summary → Home Assistant webhook.
 *
 * Pushes a small set of NUMBERS to the same `HA_WEBHOOK_URL` the Split
 * notifier uses, so a Home Assistant automation can hold them in sensors and
 * other tools can read them from there. Tagged `event: 'summary.updated'` so
 * an automation can tell it apart from Split activity, whose payloads carry
 * quite different (and far more personal) content.
 *
 * PRIVACY IS THE POINT, so the boundary is explicit rather than incidental:
 * this payload carries balances, card totals and the month's headroom, and
 * NOTHING about individual transactions. No merchant names, no descriptions,
 * no categories, no dates of individual spends, and no IBANs — `BankAccountLink`
 * holds an `iban` that is masked in the UI and never logged, and it must never
 * leave through here either. Every object below is constructed field by field
 * from an allowlist; none is spread from a source record, so a new field added
 * upstream cannot silently start being transmitted. `summaryContainsOnlyAllowedKeys`
 * exists so a test can assert exactly that.
 *
 * Account and card NAMES are included deliberately: they are user-chosen
 * labels, the automation needs them to tell one balance from another, and
 * without them the feed is unusable. They are the only free text present.
 *
 * SERVER-ONLY PLAIN MODULE — deliberately NOT 'use server', for the same
 * reason as split-notify.ts: the transport must never become a client-callable
 * endpoint.
 *
 * HARD-DISABLE: no `HA_WEBHOOK_URL` ⇒ no network call is ever made.
 * FIRE-AND-FORGET: `sendHaSummary` never throws and never retries; a down
 * Home Assistant must not affect the app.
 * REDACTION: never log the webhook URL (it embeds the secret webhook id) and
 * never log payload contents — failures log a status or an error name only.
 */
import type { BankAccountLink, Currency, FinancialAccount, MonthlyProjection } from '@/types';

/** How long we wait for Home Assistant before giving up on one POST. */
const SUMMARY_TIMEOUT_MS = 5_000;

export interface HaSummaryAccount {
  id: string;
  name: string;
  /** Projected balance at the end of the current month. */
  endOfMonthBalance: number;
  /**
   * What the month ends with if no further income arrives — i.e. the
   * end-of-month balance less the income still expected this month. This is
   * the "money left until payday" figure: what there is to last on before the
   * next money comes in. Derived from the projection's own current-month
   * totals, which already account for what has actually been paid.
   */
  leftThisMonth: number;
}

export interface HaSummaryCard {
  id: string;
  name: string;
  /** Amount owed, as a positive magnitude. */
  outstanding: number;
  availableCredit?: number;
}

export interface HaSummaryPayload {
  event: 'summary.updated';
  ts: string;
  currency: Currency;
  totals: {
    cashBalance: number;
    cardOutstanding: number;
    leftThisMonth: number;
  };
  accounts: HaSummaryAccount[];
  cards: HaSummaryCard[];
}

/** Every key this payload is allowed to contain, at any depth. */
export const SUMMARY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'event', 'ts', 'currency', 'totals', 'accounts', 'cards',
  'cashBalance', 'cardOutstanding', 'leftThisMonth',
  'id', 'name', 'endOfMonthBalance', 'outstanding', 'availableCredit',
]);

/**
 * True when every key in the payload is on the allowlist. A test uses this to
 * prove no transaction detail, IBAN or other field can ride along.
 */
export function summaryContainsOnlyAllowedKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(summaryContainsOnlyAllowedKeys);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, nested]) => SUMMARY_ALLOWED_KEYS.has(key) && summaryContainsOnlyAllowedKeys(nested)
    );
  }
  return true;
}

export interface HaSummaryInput {
  /** One entry per cash account, with that account's CURRENT month only. */
  accounts: { account: FinancialAccount; currentMonth: MonthlyProjection | undefined }[];
  /** Linked bank accounts; only `credit-card` ones, not excluded, are counted. */
  cards: BankAccountLink[];
  currency: Currency;
  now?: Date;
}

/** Build the payload. Pure: no I/O, no environment reads, so it is fully testable. */
export function buildHaSummary(input: HaSummaryInput): HaSummaryPayload {
  const accounts: HaSummaryAccount[] = input.accounts
    .filter((entry) => entry.currentMonth !== undefined && !entry.account.isArchived)
    .map(({ account, currentMonth }) => {
      const month = currentMonth!;
      return {
        id: account.id,
        name: account.name,
        endOfMonthBalance: month.endingBalance,
        // totalIncome is the REMAINING income once the projection has
        // actualized the month against booked transactions, so this stays
        // correct mid-month rather than double-counting a salary already in.
        leftThisMonth: month.endingBalance - month.totalIncome,
      };
    });

  const cards: HaSummaryCard[] = input.cards
    .filter((link) => link.accountRole === 'credit-card' && !link.isExcluded)
    .map((link) => {
      const card: HaSummaryCard = {
        id: link.id,
        name: link.customName?.trim() || link.name?.trim() || 'Card',
        outstanding: link.outstanding ?? 0,
      };
      if (typeof link.availableCredit === 'number') card.availableCredit = link.availableCredit;
      return card;
    });

  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

  return {
    event: 'summary.updated',
    ts: (input.now ?? new Date()).toISOString(),
    currency: input.currency,
    totals: {
      cashBalance: sum(accounts.map((a) => a.endOfMonthBalance)),
      cardOutstanding: sum(cards.map((c) => c.outstanding)),
      leftThisMonth: sum(accounts.map((a) => a.leftThisMonth)),
    },
    accounts,
    cards,
  };
}

/** Resolve the webhook from the environment. Null ⇒ feature off, no call ever made. */
export function getHaSummaryWebhook(): string | null {
  const url = process.env.HA_WEBHOOK_URL?.trim();
  return url ? url : null;
}

/**
 * POST one summary. Never throws: a webhook that is down, slow or misconfigured
 * must not surface anywhere in the app.
 */
export async function sendHaSummary(
  payload: HaSummaryPayload,
  webhookUrl: string | null = getHaSummaryWebhook()
): Promise<boolean> {
  if (!webhookUrl) return false;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — never the URL (it embeds the secret webhook id) and
      // never the body.
      console.warn(`[ha-summary] Home Assistant rejected the summary (HTTP ${res.status}).`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `[ha-summary] Could not deliver the summary: ${error instanceof Error ? error.name : 'unknown error'}.`
    );
    return false;
  }
}
