// Builders for the two grant-reporting CSV files a budget can export:
// the itemized spending log and the per-category budget summary.
// Pure string output — the component downloads via downloadCsv.

import type { Budget } from '@/types';
import { toCsv, type CsvCell } from '@/lib/csv-utils';
import {
  computeFeasibility,
  computeActualsRollup,
  type BudgetFeasibility,
  type BudgetActualsRollup,
} from '@/lib/budget-utils';

/** Every logged expense: date, description, category, amount, who paid. */
export function buildExpenseLogCsv(budget: Budget): string {
  const sourceNames = new Map(budget.fundingSources.map(s => [s.id, s.name]));
  const entries = [...budget.expenseEntries].sort((a, b) => a.date.localeCompare(b.date));

  const rows: CsvCell[][] = [
    ['Date', 'Description', 'Category', 'Amount', 'Currency', 'Paid by', 'Note'],
    ...entries.map(e => [
      e.date,
      e.description,
      e.category,
      e.amount,
      budget.currency,
      e.fundingSourceId ? (sourceNames.get(e.fundingSourceId) ?? '') : '',
      e.note ?? '',
    ] as CsvCell[]),
    ['Total', '', '', entries.reduce((sum, e) => sum + e.amount, 0), budget.currency, '', ''],
  ];
  return toCsv(rows);
}

/** Planned vs actual per category, plus a funding-source section. */
export function buildBudgetSummaryCsv(
  budget: Budget,
  feasibility: BudgetFeasibility = computeFeasibility(budget),
  rollup: BudgetActualsRollup = computeActualsRollup(budget)
): string {
  const coveredByCategory = new Map(
    feasibility.allocation.perCategoryCoverage.map(c => [c.category, c.covered])
  );

  const rows: CsvCell[][] = [
    [budget.name, '', '', '', ''],
    [`Period: ${budget.startMonth} – ${budget.endMonth}`, '', '', '', ''],
    ['', '', '', '', ''],
    ['Category', 'Planned', 'Spent', 'Difference', `Covered by funding (${budget.currency})`],
    ...rollup.perCategory.map(c => [
      c.category,
      c.planned,
      c.actual,
      c.delta,
      coveredByCategory.get(c.category) ?? 0,
    ] as CsvCell[]),
    ['Total', rollup.totalPlanned, rollup.totalActual, rollup.totalActual - rollup.totalPlanned, ''],
    ['', '', '', '', ''],
    ['Funding source', 'Total', 'Usable', 'Claimed', 'Unusable surplus'],
    ...feasibility.allocation.perSource.map(s => {
      const claimed = rollup.perSource.find(r => r.sourceId === s.sourceId)?.claimed ?? 0;
      return [s.name, s.total, s.usable, claimed, s.unusableSurplus] as CsvCell[];
    }),
  ];
  return toCsv(rows);
}
