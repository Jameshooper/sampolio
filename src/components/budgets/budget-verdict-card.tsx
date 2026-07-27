'use client';

import { Button } from 'primereact/button';
import { MdCheckCircle, MdPayments, MdSavings, MdWallet } from 'react-icons/md';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';
import type { Budget } from '@/types';
import type { BudgetFeasibility } from '@/lib/budget-utils';

function Stat({ icon, label, value, valueClass }: { icon: React.ReactNode; label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-60">
        {icon}
        <span>{label}</span>
      </div>
      <span className={`text-xl font-bold mt-0.5 ${valueClass ?? ''}`}>{value}</span>
    </div>
  );
}

/** The plain-language verdict for the budget, with the headline figures. */
export function getVerdict(budget: Budget, f: BudgetFeasibility): { sentence: string; subline?: string; mood: 'good' | 'warn' | 'neutral' } {
  const cur = budget.currency;
  if (f.totalCosts === 0 && f.totalFunding === 0) {
    return { sentence: 'Add what it costs and who pays to see if it adds up.', mood: 'neutral' };
  }
  if (f.totalCosts === 0) {
    return { sentence: `You have ${formatCurrency(f.usableFunding, cur)} coming in and no costs yet.`, mood: 'neutral' };
  }
  if (f.totalFunding === 0) {
    return {
      sentence: `This plan costs ${formatCurrency(f.totalCosts, cur)} so far.`,
      subline: 'Add a grant or allowance to see what gets covered.',
      mood: 'neutral',
    };
  }
  if (f.outOfPocket <= 0.005) {
    if (f.freeSurplus > 0.005) {
      return { sentence: `You're fully covered — and ${formatCurrency(f.freeSurplus, cur)} left over.`, mood: 'good' };
    }
    return { sentence: 'It adds up exactly — every cost is covered.', mood: 'good' };
  }
  const uncovered = f.allocation.perCategoryCoverage.filter(c => c.ownMoney > 0.005).map(c => c.category);
  const subline =
    f.unusableSurplus > 0.005
      ? `Not covered: ${uncovered.join(', ')}. ${formatCurrency(f.unusableSurplus, cur)} of the grant money can't help — it's only allowed for other categories.`
      : `Not covered: ${uncovered.join(', ')}.`;
  return {
    sentence: `You'd pay ${formatCurrency(f.outOfPocket, cur)} from your own pocket.`,
    subline,
    mood: 'warn',
  };
}

export function BudgetVerdictCard({
  budget,
  feasibility,
  onConfirmClick,
  onUnconfirmClick,
}: {
  budget: Budget;
  feasibility: BudgetFeasibility;
  onConfirmClick: () => void;
  onUnconfirmClick: () => void;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const f = feasibility;
  const verdict = getVerdict(budget, f);

  const moodClass =
    verdict.mood === 'good'
      ? isDark ? 'border-green-800 bg-green-900/20' : 'border-green-200 bg-green-50'
      : verdict.mood === 'warn'
        ? isDark ? 'border-yellow-800 bg-yellow-900/20' : 'border-yellow-200 bg-yellow-50'
        : isDark ? 'border-neutral-700 bg-neutral-800/50' : 'border-neutral-200 bg-white';

  const isConfirmed = budget.status === 'confirmed';

  return (
    <div className={`rounded-xl border p-4 ${moodClass}`}>
      <p className="text-lg font-semibold">{verdict.sentence}</p>
      {verdict.subline && <p className="text-sm opacity-70 mt-1">{verdict.subline}</p>}
      {isConfirmed && (
        <p className="text-sm mt-2 flex items-center gap-1.5 text-green-600 dark:text-green-400">
          <MdCheckCircle />
          Showing in your cashflow from {formatYearMonth(budget.startMonth)} to {formatYearMonth(budget.endMonth)}.
        </p>
      )}
      {/* Per-month coverage strip — answers "which month hurts?" at a glance.
          Bar height ∝ that month's planned costs; color = the running position
          (green: funding received so far covers costs so far; yellow: you're
          fronting money that month). */}
      {f.perMonth.length > 1 && f.totalCosts > 0.005 && (
        <div className="mt-4">
          <div className="flex items-end gap-1 h-12">
            {f.perMonth.map((m) => {
              const maxCosts = Math.max(...f.perMonth.map((x) => x.plannedCosts), 1);
              const h = m.plannedCosts > 0.005 ? Math.max(12, (m.plannedCosts / maxCosts) * 100) : 6;
              const covered = m.cumulativeNet >= -0.005;
              return (
                <div
                  key={m.yearMonth}
                  className="flex-1 h-full flex flex-col items-center justify-end gap-1 min-w-0"
                  title={`${formatYearMonth(m.yearMonth)}: costs ${formatCurrency(m.plannedCosts, budget.currency)}, funding ${formatCurrency(m.fundingReceived, budget.currency)} — ${covered ? 'covered so far' : `${formatCurrency(-m.cumulativeNet, budget.currency)} fronted from your own pocket`}`}
                >
                  <div
                    className={`w-full rounded-t ${covered ? 'bg-green-500/70' : 'bg-yellow-500/80'}`}
                    style={{ height: `${Math.round(h * 0.8)}%` }}
                  />
                  <span className="text-[10px] opacity-60 truncate max-w-full">
                    {formatYearMonth(m.yearMonth).slice(0, 3)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4 mt-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Stat icon={<MdPayments />} label="Costs" value={formatCurrency(f.totalCosts, budget.currency)} valueClass="text-red-500" />
          <Stat icon={<MdSavings />} label="Money coming in" value={formatCurrency(f.usableFunding, budget.currency)} valueClass="text-green-600" />
          {f.outOfPocket > 0.005 ? (
            <Stat icon={<MdWallet />} label="From your own pocket" value={formatCurrency(f.outOfPocket, budget.currency)} valueClass="text-yellow-600" />
          ) : (
            <Stat icon={<MdWallet />} label="Left over" value={formatCurrency(f.freeSurplus, budget.currency)} />
          )}
        </div>
        {isConfirmed ? (
          <Button label="Remove from my cashflow" outlined severity="secondary" size="small" onClick={onUnconfirmClick} />
        ) : (
          <Button label="Add to my cashflow" size="small" onClick={onConfirmClick} disabled={budget.isArchived} />
        )}
      </div>
    </div>
  );
}
