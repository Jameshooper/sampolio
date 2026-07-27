// Pure logic for the Split feature (shared expense-splitting groups).
//
// MONEY IS INTEGER CENTS EVERYWHERE in this module. The canonical balance
// contribution of a row is `netByUserId` (cents, sums to 0 across members):
// net > 0 ⇒ the member is OWED, net < 0 ⇒ the member OWES. This matches the
// Splitwise CSV export sign convention, so an import is a direct copy.
//
// No I/O here — everything is deterministic and unit-tested in split-utils.test.ts.

import { addDays, addMonths, addWeeks, addYears, format, parseISO } from 'date-fns';
import type {
  SplitExpense,
  SplitGroupMember,
  SplitInterval,
  SplitMemberBalance,
  SplitRecurrenceRule,
  SplitShare,
  SplitSpec,
} from '@/types';

// ---------- cents helpers ----------

/** Euros (a possibly-fractional number) → integer cents, drift-free. */
export function toCents(euros: number): number {
  return Math.round(euros * 100);
}

/** Integer cents → euros (number). */
export function fromCents(cents: number): number {
  return cents / 100;
}

// ---------- split resolution ----------

export interface ResolvedSplit {
  /** canonical per-member net, cents, sums to 0 (only nonzero members included) */
  netByUserId: Record<string, number>;
  paidBy: SplitShare[];
  owed: SplitShare[];
}

/**
 * Allocate `amountCents` across `ids` proportionally to `weights`, using the
 * largest-remainder method so the parts sum EXACTLY to amountCents.
 */
function allocateByWeights(amountCents: number, ids: string[], weights: number[]): Record<string, number> {
  const total = weights.reduce((a, b) => a + b, 0);
  if (ids.length === 0) return {};
  if (total <= 0) return allocateEqually(amountCents, ids);
  const parts = ids.map((id, i) => {
    const exact = (amountCents * weights[i]) / total;
    const floor = Math.floor(exact);
    return { id, val: floor, frac: exact - floor };
  });
  const leftover = amountCents - parts.reduce((a, p) => a + p.val, 0);
  // hand out the remaining cents to the largest fractional parts (stable on ties by index)
  const order = parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.frac - a.p.frac || a.i - b.i);
  for (let k = 0; k < leftover; k++) order[k % order.length].p.val += 1;
  const out: Record<string, number> = {};
  for (const p of parts) out[p.id] = p.val;
  return out;
}

/** Equal split with the remainder cents handed to the first ids in order (deterministic). */
function allocateEqually(amountCents: number, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const n = ids.length;
  if (n === 0) return out;
  const base = Math.floor(amountCents / n);
  const rem = amountCents - base * n; // 0..n-1
  ids.forEach((id, i) => {
    out[id] = base + (i < rem ? 1 : 0);
  });
  return out;
}

/**
 * Reduce a {@link SplitSpec} + total to canonical paid/owed shares and net.
 * Single-payer model (the common case); throws on an inconsistent exact split.
 */
export function resolveSplit(
  memberIds: string[],
  amountCents: number,
  spec: SplitSpec,
): ResolvedSplit {
  const payer = spec.paidByUserId;
  if (!memberIds.includes(payer)) {
    throw new Error('Payer is not a member of the group');
  }
  const participants = (spec.participantUserIds ?? memberIds).filter((id) => memberIds.includes(id));

  let owedMap: Record<string, number>;
  switch (spec.splitMode) {
    case 'equal':
      owedMap = allocateEqually(amountCents, participants.length ? participants : memberIds);
      break;
    case 'full': {
      // Payer owes nothing; the other participants owe the whole amount.
      const others = (participants.length ? participants : memberIds).filter((id) => id !== payer);
      owedMap = allocateEqually(amountCents, others.length ? others : [payer]);
      break;
    }
    case 'exact': {
      const cfg = spec.splitConfig ?? {};
      owedMap = {};
      let sum = 0;
      for (const [id, c] of Object.entries(cfg)) {
        if (!memberIds.includes(id)) continue;
        owedMap[id] = Math.round(c);
        sum += Math.round(c);
      }
      if (sum !== amountCents) {
        throw new Error(`Exact split must sum to the total (${sum} ≠ ${amountCents})`);
      }
      break;
    }
    case 'percent': {
      const cfg = spec.splitConfig ?? {};
      const ids = Object.keys(cfg).filter((id) => memberIds.includes(id));
      owedMap = allocateByWeights(amountCents, ids, ids.map((id) => cfg[id]));
      break;
    }
    case 'shares': {
      const cfg = spec.splitConfig ?? {};
      const ids = Object.keys(cfg).filter((id) => memberIds.includes(id));
      owedMap = allocateByWeights(amountCents, ids, ids.map((id) => cfg[id]));
      break;
    }
    default:
      owedMap = allocateEqually(amountCents, memberIds);
  }

  const paidMap: Record<string, number> = { [payer]: amountCents };

  const netByUserId: Record<string, number> = {};
  const everyone = new Set<string>([...Object.keys(owedMap), ...Object.keys(paidMap)]);
  for (const id of everyone) {
    const net = (paidMap[id] ?? 0) - (owedMap[id] ?? 0);
    if (net !== 0) netByUserId[id] = net;
  }

  const paidBy: SplitShare[] = Object.entries(paidMap)
    .filter(([, c]) => c !== 0)
    .map(([userId, amountCents]) => ({ userId, amountCents }));
  const owed: SplitShare[] = Object.entries(owedMap)
    .filter(([, c]) => c !== 0)
    .map(([userId, amountCents]) => ({ userId, amountCents }));

  return { netByUserId, paidBy, owed };
}

/** net contribution of a settle-up payment: from gains +amount, to loses it. */
export function paymentNet(fromUserId: string, toUserId: string, amountCents: number): Record<string, number> {
  if (fromUserId === toUserId) return {};
  return { [fromUserId]: amountCents, [toUserId]: -amountCents };
}

// ---------- balances ----------

/** Aggregate net per member across rows (sum of each row's netByUserId). */
export function computeMemberBalances(
  members: SplitGroupMember[],
  rows: SplitExpense[],
): SplitMemberBalance[] {
  const net = new Map<string, number>();
  for (const m of members) net.set(m.userId, 0);
  for (const row of rows) {
    for (const [userId, c] of Object.entries(row.netByUserId)) {
      net.set(userId, (net.get(userId) ?? 0) + c);
    }
  }
  return members.map((m) => ({ userId: m.userId, name: m.name, netCents: net.get(m.userId) ?? 0 }));
}

export interface SettleUpSuggestion {
  fromUserId: string;
  toUserId: string;
  amountCents: number;
}

/**
 * Greedy debt simplification: who should pay whom to zero out balances with the
 * fewest transfers. (Trivial for 2 members; general for n.)
 */
export function suggestSettleUp(balances: SplitMemberBalance[]): SettleUpSuggestion[] {
  const debtors = balances.filter((b) => b.netCents < 0).map((b) => ({ id: b.userId, amt: -b.netCents }));
  const creditors = balances.filter((b) => b.netCents > 0).map((b) => ({ id: b.userId, amt: b.netCents }));
  debtors.sort((a, b) => b.amt - a.amt);
  creditors.sort((a, b) => b.amt - a.amt);
  const out: SettleUpSuggestion[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) out.push({ fromUserId: debtors[i].id, toUserId: creditors[j].id, amountCents: pay });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return out;
}

// ---------- recurrence (date-grained) ----------

function stepDate(date: Date, interval: SplitInterval): Date {
  switch (interval) {
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addWeeks(date, 1);
    case 'biweekly':
      return addWeeks(date, 2);
    case 'monthly':
      return addMonths(date, 1);
    case 'yearly':
      return addYears(date, 1);
  }
}

/**
 * The YYYY-MM-DD occurrence dates to materialize for a rule, from the first
 * not-yet-generated occurrence up to (and including) `upToInclusive`, bounded
 * by the rule's `endDate`. Returns [] when nothing is due. Idempotent: pass the
 * rule's `lastGeneratedThrough` to resume exactly after it.
 */
export function generateOccurrenceDates(
  rule: { interval: SplitInterval; anchorDate: string; endDate?: string; lastGeneratedThrough?: string },
  upToInclusive: string,
): string[] {
  const upTo = parseISO(upToInclusive);
  const end = rule.endDate ? parseISO(rule.endDate) : null;
  const hardStop = end && end < upTo ? end : upTo;

  let cursor = parseISO(rule.anchorDate);
  // Fast-forward past already-generated occurrences.
  if (rule.lastGeneratedThrough) {
    const last = parseISO(rule.lastGeneratedThrough);
    while (cursor <= last) cursor = stepDate(cursor, rule.interval);
  }

  const dates: string[] = [];
  let guard = 0;
  while (cursor <= hardStop && guard < 10000) {
    dates.push(format(cursor, 'yyyy-MM-dd'));
    cursor = stepDate(cursor, rule.interval);
    guard++;
  }
  return dates;
}

/** Is any active rule due to generate at least one occurrence by `today`? */
export function isAnyRecurrenceDue(
  rules: { interval: SplitInterval; anchorDate: string; endDate?: string; lastGeneratedThrough?: string; isActive: boolean }[],
  today: string,
): boolean {
  return rules.some((r) => r.isActive && generateOccurrenceDates(r, today).length > 0);
}

/**
 * Plan a recurrence-rule update: split the patch into the DB `updates` to apply
 * and a `pruneAfter` date (or null) telling the caller which generated tail to
 * delete because the end date moved back before already-materialized months.
 *
 * `endDate` is treated as a tri-state via key presence:
 *   - key absent  → leave the stored end date untouched (e.g. a pause toggle).
 *   - `null`      → clear the end date (recurrence becomes open-ended again).
 *   - a date      → set the end date.
 */
export function planRecurrenceRuleUpdate(
  prev: Pick<SplitRecurrenceRule, 'endDate' | 'lastGeneratedThrough'>,
  patch: Omit<Partial<SplitRecurrenceRule>, 'endDate'> & { endDate?: string | null },
): { updates: Partial<SplitRecurrenceRule>; pruneAfter: string | null } {
  const endDateProvided = 'endDate' in patch;

  // updates = patch minus the endDate key (handled explicitly below).
  const updates: Partial<SplitRecurrenceRule> = {};
  for (const [k, val] of Object.entries(patch)) {
    if (k === 'endDate') continue;
    (updates as Record<string, unknown>)[k] = val;
  }

  if (endDateProvided) {
    // An explicit `endDate: undefined` key clears the stored value: the DB layer
    // spreads it over the rule and JSON serialization drops the undefined key.
    updates.endDate = patch.endDate ?? undefined;
  }

  const effectiveEnd = endDateProvided ? patch.endDate ?? null : prev.endDate ?? null;
  const pruneAfter =
    effectiveEnd !== null && prev.lastGeneratedThrough !== undefined && prev.lastGeneratedThrough > effectiveEnd
      ? effectiveEnd
      : null;
  if (pruneAfter !== null) {
    // Rewind the cursor to the new end so a later re-extension regenerates the
    // pruned tail via catch-up (idempotent occurrence keys prevent duplicates).
    // pruneAfter === effectiveEnd here and is narrowed to a non-null string.
    updates.lastGeneratedThrough = pruneAfter;
  }
  return { updates, pruneAfter };
}

/** Drop generated occurrences of `ruleId` dated strictly after `endDateInclusive`. */
export function pruneOccurrencesAfter(
  rows: SplitExpense[],
  ruleId: string,
  endDateInclusive: string,
): SplitExpense[] {
  return rows.filter((r) => !(r.generatedFromRuleId === ruleId && r.date > endDateInclusive));
}

/**
 * The furthest-forward `createdAt` that can safely be marked "seen" for the
 * viewer, without ever marking a row that never appeared on screen. Candidates
 * are rows created after `snapshotISO` (the last-seen watermark), oldest first;
 * we walk the contiguous frontier and stop at the first row that is neither the
 * viewer's own nor confirmed viewed (via `viewedIds`). Returns the last passed
 * row's createdAt, or null if the frontier never advances.
 */
export function computeSeenWatermark(
  rows: SplitExpense[],
  snapshotISO: string | null,
  myUserId: string,
  viewedIds: Set<string>,
): string | null {
  const floor = snapshotISO ?? '';
  const candidates = rows
    .filter((r) => r.createdAt > floor)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let watermark: string | null = null;
  for (const row of candidates) {
    if (row.createdByUserId === myUserId || viewedIds.has(row.id)) {
      watermark = row.createdAt;
    } else {
      break; // gap — never mark a row the user hasn't actually seen
    }
  }
  return watermark;
}

// ---------- category auto-guess (quick-add convenience) ----------

const CATEGORY_KEYWORDS: { category: string; words: string[] }[] = [
  { category: 'Groceries', words: ['market', 'grocer', 'aldi', 'lidl', 'prisma', 'alepa', 's-market', 'k-market', 'kauppa', 'food'] },
  { category: 'Dining out', words: ['lunch', 'dinner', 'restaurant', 'cafe', 'café', 'coffee', 'ravintola', 'pizza', 'burger', 'sushi'] },
  { category: 'Liquor', words: ['alko', 'wine', 'beer', 'liquor', 'olut', 'viini'] },
  { category: 'TV/Phone/Internet', words: ['internet', 'netflix', 'spotify', 'phone', 'mobile', 'icloud', 'subscription', 'broadband', 'dna', 'elisa', 'telia'] },
  { category: 'Electricity', words: ['electric', 'sähkö', 'helen', 'fortum'] },
  { category: 'Rent', words: ['rent', 'vuokra'] },
  { category: 'Transport', words: ['bus', 'train', 'hsl', 'vr', 'metro', 'tram'] },
  { category: 'Taxi', words: ['taxi', 'uber', 'bolt'] },
  { category: 'Fuel', words: ['fuel', 'gas', 'petrol', 'neste', 'abc'] },
  { category: 'Hotel', words: ['hotel', 'airbnb', 'hostel'] },
  { category: 'Furniture', words: ['ikea', 'furniture', 'sofa', 'table', 'chair', 'lamp'] },
  { category: 'Clothing', words: ['clothes', 'clothing', 'zara', 'h&m', 'shoes'] },
  { category: 'Medical', words: ['pharmacy', 'apteekki', 'doctor', 'dentist', 'medical', 'clinic'] },
  { category: 'Gifts', words: ['gift', 'present', 'lahja'] },
  { category: 'Movies', words: ['cinema', 'movie', 'kino', 'finnkino'] },
];

/** Best-effort category from an expense title; falls back to "General". */
export function guessCategory(title: string): string {
  const t = title.toLowerCase();
  for (const { category, words } of CATEGORY_KEYWORDS) {
    if (words.some((w) => t.includes(w))) return category;
  }
  return 'General';
}
