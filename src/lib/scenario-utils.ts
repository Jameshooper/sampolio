/**
 * Pure "What If?" scenario logic — applies a list of scenario modifications to
 * cloned item lists. No server dependencies, fully deterministic given its
 * inputs (the caller passes the timestamp), so it's unit-testable.
 *
 * Synthetic items created by add-income/add-expense get `scenario-` prefixed
 * ids; nothing here is ever persisted.
 */

import type { PlannedItem, RecurringItem } from '@/types';

export interface ScenarioModification {
  type: 'add-income' | 'add-expense' | 'remove-item' | 'modify-amount';
  name?: string;
  amount?: number;
  frequency?: 'monthly' | 'quarterly' | 'yearly';
  itemId?: string; // for remove/modify
  newAmount?: number; // for modify
  // One-off scenario event: an add-income/add-expense that lands ONCE in a
  // single month (a synthetic planned item) instead of a recurring item.
  isOneOff?: boolean;
  scheduledDate?: string; // YYYY-MM — the one-off month (defaults to nowIso's month)
}

/**
 * Apply scenario modifications to (copies of) the item lists.
 *
 * - `add-income` / `add-expense`: append a synthetic monthly/quarterly/yearly
 *   recurring item starting the month of `nowIso`. When `isOneOff` is set,
 *   append a synthetic one-off PlannedItem at `scheduledDate` (or `nowIso`'s
 *   month) instead.
 * - `remove-item`: drop the id from BOTH lists.
 * - `modify-amount`: update the amount on whichever list holds the id
 *   (recurring AND planned — planned items are matched too).
 * - Unknown ids are a no-op.
 *
 * @param nowIso ISO timestamp used for the synthetic items' createdAt/updatedAt
 *   and (its `YYYY-MM` prefix) their startDate — passed in so the function
 *   stays deterministic.
 */
export function applyScenarioModifications(
  recurringItems: RecurringItem[],
  plannedItems: PlannedItem[],
  modifications: ScenarioModification[],
  accountId: string,
  nowIso: string
): { recurring: RecurringItem[]; planned: PlannedItem[] } {
  let recurring = [...recurringItems];
  let planned = [...plannedItems];

  const startDate = nowIso.slice(0, 7);

  for (const mod of modifications) {
    switch (mod.type) {
      case 'add-income':
      case 'add-expense': {
        const isIncome = mod.type === 'add-income';
        const name = mod.name || (isIncome ? 'New Income' : 'New Expense');
        if (mod.isOneOff) {
          const newPlanned: PlannedItem = {
            id: `scenario-${Date.now()}-${Math.random()}`,
            accountId,
            type: isIncome ? 'income' : 'expense',
            kind: 'one-off',
            name,
            amount: mod.amount || 0,
            scheduledDate: mod.scheduledDate || startDate,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          planned = [...planned, newPlanned];
        } else {
          const newItem: RecurringItem = {
            id: `scenario-${Date.now()}-${Math.random()}`,
            accountId,
            type: isIncome ? 'income' : 'expense',
            name,
            amount: mod.amount || 0,
            frequency: mod.frequency || 'monthly',
            startDate,
            isActive: true,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          recurring = [...recurring, newItem];
        }
        break;
      }
      case 'remove-item': {
        if (mod.itemId) {
          recurring = recurring.filter(r => r.id !== mod.itemId);
          planned = planned.filter(p => p.id !== mod.itemId);
        }
        break;
      }
      case 'modify-amount': {
        if (mod.itemId && mod.newAmount !== undefined) {
          recurring = recurring.map(r =>
            r.id === mod.itemId ? { ...r, amount: mod.newAmount! } : r
          );
          planned = planned.map(p =>
            p.id === mod.itemId ? { ...p, amount: mod.newAmount! } : p
          );
        }
        break;
      }
    }
  }

  return { recurring, planned };
}
