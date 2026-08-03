// Pure engine for the /split "Across all groups" summary + insights charts.
//
// MONEY IS INTEGER CENTS EVERYWHERE (same convention as split-utils.ts). No I/O,
// no server imports — deterministic and unit-tested in split-insights.test.ts.
//
// Cross-currency note: like the rest of the app, cents in different currencies
// are summed as-is (no conversion). Aggregate figures therefore carry a
// "(mixed currencies)" caveat in the UI when more than one currency is present.

import { format, startOfMonth, subMonths } from 'date-fns';
import { suggestSettleUp } from './split-utils';
import type { Currency, SplitExpense, SplitGroup, SplitMemberBalance } from '@/types';

/** The viewer's aggregated pairwise position with one other person.
 * `netCents > 0` ⇒ they owe the viewer, `< 0` ⇒ the viewer owes them. */
export interface PersonNet {
  userId: string;
  name: string;
  currency: Currency;
  netCents: number;
}

/**
 * Aggregate the viewer's pairwise position across groups. Per group we run the
 * same `suggestSettleUp` used by each group's settle-up screen, keep only the
 * suggestions that involve the viewer, and sum them per (counterparty, currency)
 * — so the summary always agrees with what each group would tell you to pay.
 */
export function aggregatePairwiseNets(
  viewerId: string,
  groups: { group: Pick<SplitGroup, 'members' | 'currency'>; balances: SplitMemberBalance[] }[],
): { people: PersonNet[]; totalByCurrency: Record<string, number> } {
  const map = new Map<string, PersonNet>(); // key = `${userId}|${currency}`
  for (const { group, balances } of groups) {
    const nameOf = (id: string) => group.members.find((m) => m.userId === id)?.name ?? 'Member';
    for (const s of suggestSettleUp(balances)) {
      let counterparty: string | null = null;
      let delta = 0;
      if (s.toUserId === viewerId) {
        counterparty = s.fromUserId; // they pay the viewer ⇒ they owe the viewer
        delta = s.amountCents;
      } else if (s.fromUserId === viewerId) {
        counterparty = s.toUserId; // the viewer pays them ⇒ the viewer owes them
        delta = -s.amountCents;
      } else {
        continue;
      }
      const key = `${counterparty}|${group.currency}`;
      const existing = map.get(key);
      if (existing) existing.netCents += delta;
      else map.set(key, { userId: counterparty, name: nameOf(counterparty), currency: group.currency, netCents: delta });
    }
  }
  const people = [...map.values()]
    .filter((p) => p.netCents !== 0)
    .sort((a, b) => b.netCents - a.netCents);
  const totalByCurrency: Record<string, number> = {};
  for (const p of people) totalByCurrency[p.currency] = (totalByCurrency[p.currency] ?? 0) + p.netCents;
  return { people, totalByCurrency };
}

/** The last `monthsBack` YYYY-MM strings, oldest → newest, ending this month. */
export function monthsWindow(monthsBack: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  const base = startOfMonth(now);
  for (let i = monthsBack - 1; i >= 0; i--) out.push(format(subMonths(base, i), 'yyyy-MM'));
  return out;
}

export interface SplitInsightsGroupInput {
  group: Pick<SplitGroup, 'id' | 'name' | 'emoji' | 'currency' | 'members'>;
  /** The group's rows that fall inside the window only. */
  rows: SplitExpense[];
  /** summary.netByUserId — the group's cumulative-to-date per-member net. */
  totalNetByUserId: Record<string, number>;
}

export interface SplitInsights {
  months: string[];
  groups: { id: string; name: string; emoji?: string; currency: Currency }[];
  /** Union of every group's members, the viewer first. */
  members: { userId: string; name: string }[];
  currencies: Currency[];
  /** month → groupId → cents (expenses only; payments excluded). */
  spendByGroup: Record<string, Record<string, number>>;
  /** month → userId → cents actually fronted for expenses that month. */
  paidByMember: Record<string, Record<string, number>>;
  /** month → category → cents (expenses only; blank category ⇒ 'Other'). */
  spendByCategory: Record<string, Record<string, number>>;
  /** Every category seen in the window, ranked desc by window total. */
  categories: string[];
  /** month-END running net for the viewer, summed across groups. */
  viewerNetByMonth: Record<string, number>;
  /** The viewer's net just BEFORE the window began, summed across groups.
   * Charts need it as the baseline for the first month's delta (without it the
   * first bar would wrongly show the whole cumulative position as one month's
   * change). */
  viewerNetBaseline: number;
}

/**
 * Build the insights datasets for one viewer over `months`.
 *
 * - **spend**: only `kind === 'expense'` rows, bucketed by `date.slice(0, 7)`,
 *   totalled per group AND per category (a blank/whitespace category ⇒ 'Other').
 * - **paid attribution**: native rows carry `paidBy` shares (exact); imported
 *   rows only know per-member net, so each member is credited `max(0, net)` —
 *   a documented LOWER BOUND (a payer who also consumed shows only their net,
 *   never more), mirroring the imported-row fallback in
 *   `buildSplitBudgetEntries`.
 * - **running net**: each group's baseline just before the window is
 *   `totalNetByUserId[viewer] − Σ(window rows' viewer net)`; the viewer's net is
 *   then accumulated month by month (empty months carry the prior value forward)
 *   and summed across groups. Cross-currency cents are summed as-is.
 */
export function computeSplitInsights(
  viewerId: string,
  inputs: SplitInsightsGroupInput[],
  months: string[],
): SplitInsights {
  const monthIndex = new Map<string, number>();
  months.forEach((m, i) => monthIndex.set(m, i));

  const spendByGroup: Record<string, Record<string, number>> = {};
  const paidByMember: Record<string, Record<string, number>> = {};
  const spendByCategory: Record<string, Record<string, number>> = {};
  for (const m of months) {
    spendByGroup[m] = {};
    paidByMember[m] = {};
    spendByCategory[m] = {};
  }
  /** Window totals per category, used to rank `categories`. */
  const categoryTotals = new Map<string, number>();

  // Per-month viewer-net delta summed across groups (index-aligned to months).
  const viewerDelta = new Array<number>(months.length).fill(0);
  // Sum of each group's baseline (its net just before the window began).
  let baselineSum = 0;

  const groupsOut: SplitInsights['groups'] = [];
  const currencies: Currency[] = [];
  const memberOrder: { userId: string; name: string }[] = [];
  const seenMembers = new Set<string>();

  for (const { group, rows, totalNetByUserId } of inputs) {
    groupsOut.push({ id: group.id, name: group.name, emoji: group.emoji, currency: group.currency });
    if (!currencies.includes(group.currency)) currencies.push(group.currency);
    for (const m of group.members) {
      if (!seenMembers.has(m.userId)) {
        seenMembers.add(m.userId);
        memberOrder.push({ userId: m.userId, name: m.name });
      }
    }

    let windowViewerNet = 0;
    for (const row of rows) {
      const month = row.date.slice(0, 7);
      const idx = monthIndex.get(month);
      const viewerNet = row.netByUserId[viewerId] ?? 0;
      windowViewerNet += viewerNet;
      if (idx !== undefined) viewerDelta[idx] += viewerNet;

      if (row.kind !== 'expense') continue;
      if (idx === undefined) continue;

      spendByGroup[month][group.id] = (spendByGroup[month][group.id] ?? 0) + row.amountCents;

      const category = normalizeCategory(row.category);
      spendByCategory[month][category] = (spendByCategory[month][category] ?? 0) + row.amountCents;
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + row.amountCents);

      if (row.paidBy && row.paidBy.length > 0) {
        for (const share of row.paidBy) {
          paidByMember[month][share.userId] = (paidByMember[month][share.userId] ?? 0) + share.amountCents;
        }
      } else {
        for (const [uid, net] of Object.entries(row.netByUserId)) {
          const credited = Math.max(0, net); // lower bound for imported rows
          if (credited > 0) paidByMember[month][uid] = (paidByMember[month][uid] ?? 0) + credited;
        }
      }
    }

    baselineSum += (totalNetByUserId[viewerId] ?? 0) - windowViewerNet;
  }

  const viewerNetByMonth: Record<string, number> = {};
  let running = baselineSum;
  months.forEach((m, i) => {
    running += viewerDelta[i];
    viewerNetByMonth[m] = running;
  });

  // Viewer first in the member union.
  const members = memberOrder.filter((m) => m.userId === viewerId).concat(memberOrder.filter((m) => m.userId !== viewerId));

  return {
    months: [...months],
    groups: groupsOut,
    members,
    currencies,
    spendByGroup,
    paidByMember,
    spendByCategory,
    categories: rankKeys(categoryTotals),
    viewerNetByMonth,
    viewerNetBaseline: baselineSum,
  };
}

/** The bucket label used for blank categories and the bucketed long tail. */
const OTHER_CATEGORY = 'Other';

/** Blank/whitespace-only categories collapse into a single 'Other' bucket. */
function normalizeCategory(category: string | undefined): string {
  const trimmed = (category ?? '').trim();
  return trimmed.length > 0 ? trimmed : OTHER_CATEGORY;
}

/** Keys of a totals map, ranked desc by total (name-ascending on ties). */
function rankKeys(totals: Map<string, number>): string[] {
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

/**
 * Collapse a category spend map to at most `limit` real categories plus one
 * aggregated 'Other' bucket, so a stacked chart stays legible.
 *
 * Ranking is by window total (desc). When the window has at most `limit + 1`
 * distinct categories nothing needs bucketing and the data passes through
 * unchanged (an existing 'Other' category simply stays a category of its own).
 * Otherwise the top `limit` categories are kept and EVERYTHING else — including
 * any pre-existing 'Other' — is summed into a trailing 'Other' series.
 */
export function bucketSpendByCategory(
  insights: Pick<SplitInsights, 'months' | 'spendByCategory'>,
  limit = 8,
): { months: string[]; categories: string[]; spend: Record<string, Record<string, number>> } {
  const months = [...insights.months];

  const totals = new Map<string, number>();
  for (const m of months) {
    for (const [category, cents] of Object.entries(insights.spendByCategory[m] ?? {})) {
      totals.set(category, (totals.get(category) ?? 0) + cents);
    }
  }
  const ranked = rankKeys(totals);

  // Nothing to bucket: at most limit + 1 series is already legible.
  if (ranked.length <= limit + 1) {
    const spend: Record<string, Record<string, number>> = {};
    for (const m of months) spend[m] = { ...(insights.spendByCategory[m] ?? {}) };
    return { months, categories: ranked, spend };
  }

  const kept = ranked.filter((c) => c !== OTHER_CATEGORY).slice(0, limit);
  const keptSet = new Set(kept);
  const spend: Record<string, Record<string, number>> = {};
  for (const m of months) {
    const row: Record<string, number> = {};
    for (const [category, cents] of Object.entries(insights.spendByCategory[m] ?? {})) {
      const key = keptSet.has(category) ? category : OTHER_CATEGORY;
      row[key] = (row[key] ?? 0) + cents;
    }
    spend[m] = row;
  }
  return { months, categories: [...kept, OTHER_CATEGORY], spend };
}

// ---------------------------------------------------------------------------
// One group, one recent period (the /split/[id] "Last 30 days" card)
// ---------------------------------------------------------------------------

export interface GroupPeriodInsights {
  /** Total expense value in the window (payments excluded). */
  totalSpendCents: number;
  expenseCount: number;
  /** Payments recorded in the window (never counted as spend). */
  settledCents: number;
  /** Who fronted money, desc by cents; zero-cent members are omitted.
   * `pct` is a FRACTION (0..1) of the window's total fronted amount. */
  paidByMember: { userId: string; name: string; cents: number; pct: number }[];
  /** Every in-window category, desc by cents (the UI shows the leading few). */
  topCategories: { category: string; cents: number; count: number }[];
  /** The three largest single expenses in the window, desc by cents. */
  topExpenses: { id: string; title: string; category: string; cents: number; date: string }[];
  /** True when an in-window expense came from an import (no `paidBy`), so the
   * paid attribution is a documented LOWER BOUND. */
  hasImportedRows: boolean;
}

/**
 * Summarize ONE group's rows over an inclusive `[fromDate, toDate]` day window
 * ('YYYY-MM-DD', compared lexicographically — the format sorts correctly).
 *
 * Paid attribution follows the same rule as `computeSplitInsights`: native rows
 * use their exact `paidBy` shares, while imported rows only know per-member net
 * and credit each member `max(0, net)` — a LOWER BOUND (a payer who also
 * consumed shows only their net, never the full amount they fronted).
 * `hasImportedRows` lets the UI say so.
 *
 * Payments contribute to `settledCents` only. A blank category ⇒ 'Other'.
 */
export function computeGroupPeriodInsights(
  members: { userId: string; name: string }[],
  rows: SplitExpense[],
  fromDate: string,
  toDate: string,
): GroupPeriodInsights {
  const nameOf = (userId: string) => members.find((m) => m.userId === userId)?.name ?? 'Member';

  let totalSpendCents = 0;
  let expenseCount = 0;
  let settledCents = 0;
  let hasImportedRows = false;
  const paidCents = new Map<string, number>();
  const categoryCents = new Map<string, number>();
  const categoryCount = new Map<string, number>();
  const expenseRows: { id: string; title: string; category: string; cents: number; date: string }[] = [];

  for (const row of rows) {
    if (row.date < fromDate || row.date > toDate) continue;

    if (row.kind !== 'expense') {
      settledCents += row.amountCents;
      continue;
    }

    totalSpendCents += row.amountCents;
    expenseCount++;

    const category = normalizeCategory(row.category);
    categoryCents.set(category, (categoryCents.get(category) ?? 0) + row.amountCents);
    categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
    expenseRows.push({ id: row.id, title: row.title, category, cents: row.amountCents, date: row.date });

    if (row.paidBy && row.paidBy.length > 0) {
      for (const share of row.paidBy) {
        paidCents.set(share.userId, (paidCents.get(share.userId) ?? 0) + share.amountCents);
      }
    } else {
      hasImportedRows = true;
      for (const [userId, net] of Object.entries(row.netByUserId)) {
        const credited = Math.max(0, net); // lower bound for imported rows
        if (credited > 0) paidCents.set(userId, (paidCents.get(userId) ?? 0) + credited);
      }
    }
  }

  const totalPaid = [...paidCents.values()].reduce((s, v) => s + v, 0);
  const paidByMember = [...paidCents.entries()]
    .filter(([, cents]) => cents !== 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([userId, cents]) => ({ userId, name: nameOf(userId), cents, pct: totalPaid > 0 ? cents / totalPaid : 0 }));

  const topCategories = [...categoryCents.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, cents]) => ({ category, cents, count: categoryCount.get(category) ?? 0 }));

  const topExpenses = expenseRows
    .sort((a, b) => b.cents - a.cents || (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id)))
    .slice(0, 3);

  return { totalSpendCents, expenseCount, settledCents, paidByMember, topCategories, topExpenses, hasImportedRows };
}
