'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { Message } from 'primereact/message';
import { getSplitGroupView, getSplitExpenses } from '@/lib/actions/split-groups';
import { buildSplitBudgetEntries, getBudgetMonths } from '@/lib/budget-utils';
import { formatCurrency } from '@/lib/constants';
import { DelayedSkeleton } from '@/components/ui/delayed-loading';
import type { Budget, SplitExpense, SplitGroup } from '@/types';

/**
 * Read-only "From split group" section for a budget with a linked split group:
 * the viewer's share of each group expense dated inside the budget period.
 * Everything here is computed at read time from the split group — nothing is
 * copied into the budget doc, and the total never feeds the feasibility math,
 * the spending-log rollup, or the cashflow injection.
 */
export function BudgetSplitExpenses({ budget }: { budget: Budget }) {
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [rows, setRows] = useState<SplitExpense[] | null>(null);
  const [error, setError] = useState('');

  const groupId = budget.linkedSplitGroupId;
  const startMonth = budget.startMonth;
  const endMonth = budget.endMonth;

  useEffect(() => {
    if (!groupId) return;
    let active = true;
    (async () => {
      const months = getBudgetMonths({ startMonth, endMonth } as Budget);
      const [viewRes, rowsRes] = await Promise.all([
        getSplitGroupView(groupId),
        getSplitExpenses(groupId, months),
      ]);
      if (!active) return;
      if (!viewRes.success || !viewRes.data || !rowsRes.success || !rowsRes.data) {
        setError(viewRes.error ?? rowsRes.error ?? 'Could not load the linked split group');
        setRows([]);
        return;
      }
      setGroup(viewRes.data.group);
      setRows(rowsRes.data);
    })();
    return () => {
      active = false;
    };
  }, [groupId, startMonth, endMonth]);

  const view = useMemo(
    () => (rows && myId ? buildSplitBudgetEntries(rows, myId, budget) : null),
    [rows, myId, budget]
  );

  if (!groupId) return null;

  return (
    <Card>
      <h3 className="text-base font-semibold mb-1">
        From split group{group ? ` — ${group.emoji ? group.emoji + ' ' : ''}${group.name}` : ''}
      </h3>
      <p className="text-sm opacity-60 mb-3">
        Your share of the group&apos;s expenses during the budget period. Read-only — it doesn&apos;t change the
        budget math or the spending-log totals.
      </p>

      {error && <Message severity="warn" text={error} className="w-full" />}

      {!error && view === null && (
        <DelayedSkeleton>
          <div className="h-24 w-full rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
        </DelayedSkeleton>
      )}

      {!error && view !== null && view.entries.length === 0 && (
        <p className="text-sm opacity-50">No split expenses with your share fall inside this budget&apos;s period.</p>
      )}

      {!error && view !== null && view.entries.length > 0 && (
        <>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {view.entries.map((e) => (
              <li key={e.id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{e.description || '—'}</div>
                  <div className="text-xs opacity-60 flex items-center gap-2 flex-wrap">
                    <span>{e.date}</span>
                    <Tag value={e.category} severity="secondary" />
                    {e.splitCategory !== e.category && <span className="opacity-70">({e.splitCategory})</span>}
                  </div>
                </div>
                <span className="text-sm font-medium shrink-0">{formatCurrency(e.amount, budget.currency)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-sm font-semibold border-t border-gray-200 dark:border-gray-700 pt-2 mt-1">
            <span>Your share in this period</span>
            <span>{formatCurrency(view.total, budget.currency)}</span>
          </div>
        </>
      )}
    </Card>
  );
}
