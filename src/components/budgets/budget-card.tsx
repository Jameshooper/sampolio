'use client';

import { Tag } from 'primereact/tag';
import { MdLuggage, MdPlace } from 'react-icons/md';
import { formatYearMonth } from '@/lib/constants';
import { computeFeasibility, isBudgetPast } from '@/lib/budget-utils';
import { getCurrentYearMonth } from '@/lib/projection';
import { getVerdict } from './budget-verdict-card';
import { useTheme } from '@/components/providers/theme-provider';
import type { Budget } from '@/types';

export function statusTag(budget: Budget): { value: string; severity: 'success' | 'warning' | 'secondary' } {
  if (isBudgetPast(budget, getCurrentYearMonth())) return { value: 'Past', severity: 'secondary' };
  if (budget.status === 'confirmed') return { value: 'In your cashflow', severity: 'success' };
  return { value: 'Draft', severity: 'warning' };
}

export function BudgetCard({ budget, onClick }: { budget: Budget; onClick: () => void }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const feasibility = computeFeasibility(budget);
  const verdict = getVerdict(budget, feasibility);
  const tag = statusTag(budget);

  return (
    <div
      className={`rounded-xl border p-4 pressable cursor-pointer hover:shadow-md ${
        isDark ? 'border-neutral-700 bg-neutral-800/50 hover:bg-neutral-800' : 'border-neutral-200 bg-white hover:bg-neutral-50'
      } ${budget.isArchived ? 'opacity-60' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MdLuggage size={20} className="opacity-50 shrink-0" />
          <h3 className="text-base font-semibold truncate">{budget.name}</h3>
        </div>
        <Tag value={budget.isArchived ? 'Archived' : tag.value} severity={budget.isArchived ? 'secondary' : tag.severity} className="shrink-0" />
      </div>
      <p className="text-sm opacity-60 mt-1 flex items-center gap-1">
        {budget.destination && (
          <>
            <MdPlace size={14} />
            {budget.destination} ·{' '}
          </>
        )}
        {formatYearMonth(budget.startMonth)} – {formatYearMonth(budget.endMonth)} · {budget.currency}
      </p>
      <p className="text-sm mt-2">{verdict.sentence}</p>
    </div>
  );
}
