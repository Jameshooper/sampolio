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
  /** month-END running net for the viewer, summed across groups. */
  viewerNetByMonth: Record<string, number>;
}

/**
 * Build the insights datasets for one viewer over `months`.
 *
 * - **spend**: only `kind === 'expense'` rows, bucketed by `date.slice(0, 7)`.
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
  for (const m of months) {
    spendByGroup[m] = {};
    paidByMember[m] = {};
  }

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
    viewerNetByMonth,
  };
}
