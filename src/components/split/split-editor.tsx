'use client';

import { useMemo } from 'react';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { SelectButton } from 'primereact/selectbutton';
import { resolveSplit, toCents } from '@/lib/split-utils';
import { formatCents } from '@/lib/constants';
import { resolveDraftSpec, splitEqually, type SplitDraft, type SplitPreset } from '@/lib/split-draft';
import type { Currency, SplitGroupMember } from '@/types';

// A single source of truth for the "how to split" UI, shared by the quick-add,
// group add/edit, and recurring-expense dialogs so they stay consistent.
//
// The common cases are one-tap PRESETS (you/other × equally/full); everything
// else lives behind "Custom split…", where you pick the payer and split by
// exact amounts or percentages. For amounts/percentages, members you haven't
// touched auto-absorb the remainder equally — so with two people, typing one
// person's amount fills the other automatically to reach the total.
//
// The pure draft→spec logic lives in @/lib/split-draft (unit-tested); it is
// re-exported here so the dialogs can import everything from one place.
export {
  emptyDraft,
  draftFromExpense,
  draftFromSpec,
  resolveDraftSpec,
  type SplitDraft,
  type SplitPreset,
  type CustomSplitMode,
} from '@/lib/split-draft';

/** Live "who owes whom" line for the current draft, from the pure engine. */
export function useSplitPreview(
  draft: SplitDraft,
  members: SplitGroupMember[],
  amountCents: number | null,
  myId: string,
  currency: Currency,
): { text: string; positive: boolean } | null {
  return useMemo(() => {
    if (!amountCents || amountCents <= 0) return null;
    const { spec } = resolveDraftSpec(draft, members, amountCents, myId);
    if (!spec) return null;
    try {
      const { netByUserId } = resolveSplit(members.map((m) => m.userId), amountCents, spec);
      const myNet = netByUserId[myId] ?? 0;
      const twoMember = members.length === 2;
      const otherName = members.find((m) => m.userId !== myId)?.name ?? 'they';
      if (myNet > 0)
        return { text: twoMember ? `${otherName} owes you ${formatCents(myNet, currency)}` : `You are owed ${formatCents(myNet, currency)}`, positive: true };
      if (myNet < 0)
        return { text: twoMember ? `You owe ${otherName} ${formatCents(-myNet, currency)}` : `You owe ${formatCents(-myNet, currency)}`, positive: false };
      return { text: "You're settled on this one", positive: true };
    } catch {
      return null;
    }
  }, [draft, members, amountCents, myId, currency]);
}

export function SplitEditor({
  members,
  myId,
  currency,
  amountCents,
  value,
  onChange,
}: {
  members: SplitGroupMember[];
  myId: string;
  currency: Currency;
  amountCents: number | null;
  value: SplitDraft;
  onChange: (d: SplitDraft) => void;
}) {
  const twoMember = members.length === 2;
  const otherName = members.find((m) => m.userId !== myId)?.name ?? 'They';
  const set = (patch: Partial<SplitDraft>) => onChange({ ...value, ...patch });
  const memberOpts = members.map((m) => ({ label: m.userId === myId ? 'You' : m.name, value: m.userId }));

  const presets: { key: SplitPreset; label: string }[] = [
    { key: 'me-equal', label: 'You paid, split equally' },
    { key: 'me-full', label: "You paid, you're owed in full" },
    ...(twoMember
      ? ([
          { key: 'other-equal', label: `${otherName} paid, split equally` },
          { key: 'other-full', label: `${otherName} is owed in full` },
        ] as { key: SplitPreset; label: string }[])
      : []),
    { key: 'custom', label: 'Custom split…' },
  ];

  // Auto-fill: members left blank share the remainder equally (shown as a
  // placeholder so typing is the only thing that "sets" a value).
  const exactAuto = useMemo(() => {
    const auto = members.filter((m) => value.amounts[m.userId] == null).map((m) => m.userId);
    const touchedSum = members.reduce((a, m) => a + (value.amounts[m.userId] != null ? toCents(value.amounts[m.userId] as number) : 0), 0);
    const remaining = (amountCents ?? 0) - touchedSum;
    return { alloc: splitEqually(Math.max(0, remaining), auto), remainingCents: remaining, autoCount: auto.length };
  }, [members, value.amounts, amountCents]);

  const percentAuto = useMemo(() => {
    const auto = members.filter((m) => value.percents[m.userId] == null).map((m) => m.userId);
    const touchedSum = members.reduce((a, m) => a + (value.percents[m.userId] != null ? (value.percents[m.userId] as number) : 0), 0);
    const remaining = 100 - touchedSum;
    return { perAuto: auto.length ? remaining / auto.length : 0, remaining, autoCount: auto.length };
  }, [members, value.percents]);

  const preview = useSplitPreview(value, members, amountCents, myId, currency);

  const modeOptions = [
    { label: 'Equally', value: 'equal' },
    { label: 'Amounts', value: 'exact' },
    { label: 'Percent', value: 'percent' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Presets — the common one-tap cases */}
      <div className="flex flex-col gap-1.5">
        {presets.map((p) => {
          const active = p.key === value.preset;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => set({ preset: p.key })}
              className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                active
                  ? 'border-green-500 bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Custom panel */}
      {value.preset === 'custom' && (
        <div className="flex flex-col gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 w-16 shrink-0">Paid by</span>
            <Dropdown
              value={value.payerId}
              onChange={(e) => set({ payerId: e.value })}
              options={memberOpts}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-500 w-16 shrink-0">Split by</span>
            <SelectButton
              value={value.customMode}
              onChange={(e) => e.value && set({ customMode: e.value })}
              options={modeOptions}
              allowEmpty={false}
            />
          </div>

          {value.customMode === 'equal' && (
            <p className="text-xs text-gray-400">Split equally between all {members.length} members.</p>
          )}

          {value.customMode !== 'equal' && (
            <p className="text-xs text-gray-400 -mt-1">Leave a field blank to split the rest automatically.</p>
          )}

          {value.customMode === 'exact' && (
            <div className="flex flex-col gap-2">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{m.userId === myId ? 'You' : m.name} owe{m.userId === myId ? '' : 's'}</span>
                  <InputNumber
                    value={value.amounts[m.userId] != null ? (value.amounts[m.userId] as number) : null}
                    onValueChange={(e) => set({ amounts: { ...value.amounts, [m.userId]: e.value ?? null } })}
                    mode="currency"
                    currency={currency}
                    locale="fi-FI"
                    placeholder={formatCents(exactAuto.alloc[m.userId] ?? 0, currency)}
                    inputClassName="w-28 text-right"
                  />
                </div>
              ))}
              {(() => {
                const over = exactAuto.remainingCents < 0;
                const short = exactAuto.autoCount === 0 && exactAuto.remainingCents > 0;
                const ok = !over && !short;
                return (
                  <div className={`text-xs text-right ${ok ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
                    {over
                      ? `${formatCents(-exactAuto.remainingCents, currency)} over the total`
                      : short
                        ? `${formatCents(exactAuto.remainingCents, currency)} left to assign`
                        : 'Balanced'}
                  </div>
                );
              })()}
            </div>
          )}

          {value.customMode === 'percent' && (
            <div className="flex flex-col gap-2">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{m.userId === myId ? 'You' : m.name}</span>
                  <InputNumber
                    value={value.percents[m.userId] != null ? (value.percents[m.userId] as number) : null}
                    onValueChange={(e) => set({ percents: { ...value.percents, [m.userId]: e.value ?? null } })}
                    suffix=" %"
                    min={0}
                    max={100}
                    maxFractionDigits={1}
                    locale="fi-FI"
                    placeholder={`${percentAuto.perAuto.toFixed(0)} %`}
                    inputClassName="w-28 text-right"
                  />
                </div>
              ))}
              {(() => {
                const over = percentAuto.remaining < -0.05;
                const short = percentAuto.autoCount === 0 && percentAuto.remaining > 0.05;
                const ok = !over && !short;
                return (
                  <div className={`text-xs text-right ${ok ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
                    {over
                      ? `${(-percentAuto.remaining).toFixed(1)}% over 100%`
                      : short
                        ? `${percentAuto.remaining.toFixed(1)}% left`
                        : '100% assigned'}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Live preview */}
      {preview && (
        <div className={`text-center text-sm font-medium ${preview.positive ? 'text-green-600 dark:text-green-400' : 'text-orange-600 dark:text-orange-400'}`}>
          {preview.text}
        </div>
      )}
    </div>
  );
}
