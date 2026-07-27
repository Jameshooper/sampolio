// Pure logic behind the shared <SplitEditor> UI: turning the editable "draft"
// (preset choice, or custom amounts/percentages) into a validated SplitSpec the
// engine understands, and rebuilding a draft from a stored expense / spec.
//
// Kept free of React and PrimeReact so it is unit-testable in isolation
// (split-draft.test.ts) and reusable. Money is euros in the draft (what the
// user types) and integer cents in the resolved spec.

import { toCents, fromCents } from '@/lib/split-utils';
import type { SplitExpenseItem, SplitGroupMember, SplitSpec } from '@/types';

export type SplitPreset = 'me-equal' | 'me-full' | 'other-equal' | 'other-full' | 'custom';
export type CustomSplitMode = 'equal' | 'exact' | 'percent';

export interface SplitDraft {
  preset: SplitPreset;
  payerId: string; // used when preset === 'custom'
  customMode: CustomSplitMode;
  amounts: Record<string, number | null>; // euros per member (exact); null = auto
  percents: Record<string, number | null>; // percent per member; null = auto
}

export function emptyDraft(myId: string): SplitDraft {
  return { preset: 'me-equal', payerId: myId, customMode: 'equal', amounts: {}, percents: {} };
}

/** Rebuild an editable draft from a stored expense (edit flow). */
export function draftFromExpense(e: SplitExpenseItem, myId: string, members: SplitGroupMember[]): SplitDraft {
  const twoMember = members.length === 2;
  const payerId = e.paidBy?.[0]?.userId ?? myId;
  const base = emptyDraft(myId);
  base.payerId = payerId;
  const mode = e.splitMode;
  if ((mode === 'equal' || mode === 'full') && twoMember) {
    const mePayer = payerId === myId;
    base.preset = mode === 'equal' ? (mePayer ? 'me-equal' : 'other-equal') : mePayer ? 'me-full' : 'other-full';
    return base;
  }
  base.preset = 'custom';
  if (mode === 'percent') {
    base.customMode = 'percent';
    const total = e.amountCents || 1;
    base.percents = Object.fromEntries(
      (e.owed ?? []).map((o) => [o.userId, Math.round((o.amountCents / total) * 1000) / 10]),
    );
  } else if (mode === 'exact' || mode === 'full') {
    base.customMode = 'exact';
    base.amounts = Object.fromEntries((e.owed ?? []).map((o) => [o.userId, fromCents(o.amountCents)]));
  } else {
    base.customMode = 'equal'; // n-member equal, or imported rows with no stored split
  }
  return base;
}

/** Rebuild an editable draft from a stored {@link SplitSpec} (recurring-rule edit). */
export function draftFromSpec(spec: SplitSpec, myId: string, members: SplitGroupMember[]): SplitDraft {
  const twoMember = members.length === 2;
  const base = emptyDraft(myId);
  base.payerId = spec.paidByUserId;
  const mode = spec.splitMode;
  if ((mode === 'equal' || mode === 'full') && twoMember) {
    const mePayer = spec.paidByUserId === myId;
    base.preset = mode === 'equal' ? (mePayer ? 'me-equal' : 'other-equal') : mePayer ? 'me-full' : 'other-full';
    return base;
  }
  base.preset = 'custom';
  const cfg = spec.splitConfig ?? {};
  if (mode === 'percent') {
    base.customMode = 'percent';
    base.percents = Object.fromEntries(Object.entries(cfg).map(([id, v]) => [id, v]));
  } else if (mode === 'exact') {
    base.customMode = 'exact';
    base.amounts = Object.fromEntries(Object.entries(cfg).map(([id, c]) => [id, fromCents(c)]));
  } else {
    base.customMode = 'equal';
  }
  return base;
}

/** Equal cents split with the remainder handed to the first ids (deterministic). */
export function splitEqually(cents: number, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const n = ids.length;
  if (n === 0) return out;
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  ids.forEach((id, i) => (out[id] = base + (i < rem ? 1 : 0)));
  return out;
}

export interface DraftResolution {
  spec: SplitSpec | null;
  error?: string;
}

/**
 * Turn a draft into a validated {@link SplitSpec} (or an error to show).
 * For custom amount/percent splits, members with no explicit value absorb the
 * remainder equally — so with two people, one entered value fills the other.
 */
export function resolveDraftSpec(
  draft: SplitDraft,
  members: SplitGroupMember[],
  amountCents: number | null,
  myId: string,
): DraftResolution {
  const memberIds = members.map((m) => m.userId);
  const otherId = members.find((m) => m.userId !== myId)?.userId ?? myId;
  switch (draft.preset) {
    case 'me-equal':
      return { spec: { paidByUserId: myId, splitMode: 'equal' } };
    case 'me-full':
      return { spec: { paidByUserId: myId, splitMode: 'full' } };
    case 'other-equal':
      return { spec: { paidByUserId: otherId, splitMode: 'equal' } };
    case 'other-full':
      return { spec: { paidByUserId: otherId, splitMode: 'full' } };
    case 'custom': {
      const payer = draft.payerId || myId;
      if (draft.customMode === 'equal') return { spec: { paidByUserId: payer, splitMode: 'equal' } };
      if (!amountCents || amountCents <= 0) return { spec: null, error: 'Enter an amount first' };

      if (draft.customMode === 'exact') {
        const touched = memberIds.filter((id) => draft.amounts[id] != null);
        const auto = memberIds.filter((id) => draft.amounts[id] == null);
        const cfg: Record<string, number> = {};
        let touchedSum = 0;
        for (const id of touched) {
          const c = toCents(draft.amounts[id] as number);
          cfg[id] = c;
          touchedSum += c;
        }
        const remaining = amountCents - touchedSum;
        if (remaining < 0) return { spec: null, error: 'Assigned amounts exceed the total' };
        if (auto.length === 0 && remaining !== 0) return { spec: null, error: 'Amounts must add up to the total' };
        Object.assign(cfg, splitEqually(remaining, auto));
        for (const id of memberIds) if (!(id in cfg)) cfg[id] = 0;
        return { spec: { paidByUserId: payer, splitMode: 'exact', splitConfig: cfg } };
      }

      // percent
      const touched = memberIds.filter((id) => draft.percents[id] != null);
      const auto = memberIds.filter((id) => draft.percents[id] == null);
      const touchedSum = touched.reduce((a, id) => a + (draft.percents[id] as number), 0);
      const remaining = 100 - touchedSum;
      if (remaining < -0.01) return { spec: null, error: 'Percentages exceed 100%' };
      if (auto.length === 0 && Math.abs(remaining) > 0.01) return { spec: null, error: 'Percentages must add up to 100%' };
      const perAuto = auto.length ? remaining / auto.length : 0;
      const cfg: Record<string, number> = {};
      for (const id of memberIds) cfg[id] = draft.percents[id] != null ? (draft.percents[id] as number) : perAuto;
      return { spec: { paidByUserId: payer, splitMode: 'percent', splitConfig: cfg } };
    }
  }
}
