'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { MdAutoAwesome, MdAdd, MdClose } from 'react-icons/md';
import { useToast } from '@/components/providers/toast-provider';
import { getRecurringSuggestions } from '@/lib/actions/bank';
import { createRecurringItem } from '@/lib/actions/recurring';
import { getAccounts } from '@/lib/actions/accounts';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import type { RecurringSuggestion } from '@/lib/recurring-detection';
import type { Currency, FinancialAccount } from '@/types';

const DISMISSED_KEY = 'sampolio-dismissed-suggestions';

export function getDismissedSuggestionKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function dismissSuggestionKey(key: string) {
  const set = getDismissedSuggestionKeys();
  set.add(key);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
}

/**
 * "Track this?" cards for recurring-looking bank transactions that have no
 * matching tracked item (detected by src/lib/recurring-detection.ts). One tap
 * creates the real recurring item; Dismiss hides a suggestion on this device
 * (localStorage — a convenience, not synced state).
 */
export function RecurringSuggestions() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [suggestions, setSuggestions] = useState<(RecurringSuggestion & { accountId: string })[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const accRes = await getAccounts();
    const active = accRes.success && accRes.data ? accRes.data.filter((a) => !a.isArchived) : [];
    setAccounts(active);
    const dismissed = getDismissedSuggestionKeys();
    const all: (RecurringSuggestion & { accountId: string })[] = [];
    for (const account of active) {
      const res = await getRecurringSuggestions(account.id);
      if (res.success && res.data) {
        all.push(...res.data.filter((s) => !dismissed.has(s.key)).map((s) => ({ ...s, accountId: account.id })));
      }
    }
    setSuggestions(all);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (suggestions.length === 0) return null;

  const handleTrack = async (s: RecurringSuggestion & { accountId: string }) => {
    setBusyKey(s.key);
    try {
      const now = new Date();
      const res = await createRecurringItem(s.accountId, {
        type: s.type,
        name: s.name,
        amount: s.amount,
        category: s.category ?? undefined,
        frequency: 'monthly',
        startDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      });
      if (res.success) {
        dismissSuggestionKey(s.key);
        setSuggestions((all) => all.filter((x) => x.key !== s.key));
        toast.success('Now tracked', `"${s.name}" was added as a recurring ${s.type} — see it on Cashflow.`);
      } else {
        toast.error('Could not add item', res.error);
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleDismiss = (key: string) => {
    dismissSuggestionKey(key);
    setSuggestions((all) => all.filter((x) => x.key !== key));
  };

  const currencyOf = (accountId: string): Currency =>
    (accounts.find((a) => a.id === accountId)?.currency ?? 'EUR') as Currency;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <MdAutoAwesome className="text-blue-500" />
        <span className="font-semibold">Looks recurring — track it?</span>
      </div>
      <p className="text-sm opacity-60 mb-3">
        These appear monthly in your imported transactions but aren&apos;t in your plan yet.
        Tracking them makes your forecast match reality.
      </p>
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div key={s.key} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border surface-border p-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate">{s.name}</span>
                <Tag value={s.type} severity={s.type === 'income' ? 'success' : 'danger'} className="text-xs !py-0 !px-1" />
                {s.category && <Tag value={s.category} className="text-xs !py-0 !px-1" severity="info" />}
              </div>
              <div className="text-xs opacity-60">
                ~{formatCurrency(s.amount, currencyOf(s.accountId))}/month · around the {s.dayOfMonth}. ·
                seen {s.monthsSeen.length} months ({formatYearMonth(s.monthsSeen[0])} – {formatYearMonth(s.monthsSeen[s.monthsSeen.length - 1])})
              </div>
            </div>
            <div className="flex gap-1 shrink-0 self-end sm:self-auto">
              <Button
                label="Track this"
                icon={<MdAdd />}
                size="small"
                outlined
                loading={busyKey === s.key}
                onClick={() => handleTrack(s)}
              />
              <Button
                icon={<MdClose />}
                text
                rounded
                size="small"
                severity="secondary"
                aria-label="Dismiss"
                onClick={() => handleDismiss(s.key)}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
