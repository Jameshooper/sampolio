'use client';

import { formatCurrency } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';
import type { Currency } from '@/types';
import type { FundingAllocation } from '@/lib/budget-utils';

// Same palette as the mortgage charts; own money is always amber.
const SOURCE_COLORS = ['rgb(59, 130, 246)', 'rgb(168, 85, 247)', 'rgb(34, 197, 94)', 'rgb(20, 184, 166)', 'rgb(99, 102, 241)'];
const OWN_MONEY_COLOR = 'rgb(245, 158, 11)';

/**
 * "Who pays for what": one stacked bar per category, one color per funding
 * source plus amber for her own money. A restricted grant simply never shows
 * up in a category it can't pay — the restriction made visible without jargon.
 */
export function BudgetCoverageBars({
  allocation,
  currency,
}: {
  allocation: FundingAllocation;
  currency: Currency;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const trackColor = isDark ? 'bg-neutral-700' : 'bg-neutral-200';

  const colorBySource = new Map(allocation.perSource.map((s, i) => [s.sourceId, SOURCE_COLORS[i % SOURCE_COLORS.length]]));
  const categories = allocation.perCategoryCoverage.filter(c => c.plannedCost > 0);
  if (categories.length === 0) return null;

  const usedSources = allocation.perSource.filter(s => Object.keys(s.allocatedByCategory).length > 0);
  const anyOwnMoney = categories.some(c => c.ownMoney > 0.005);

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs">
        {usedSources.map(s => (
          <span key={s.sourceId} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: colorBySource.get(s.sourceId) }} />
            {s.name}
          </span>
        ))}
        {anyOwnMoney && (
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: OWN_MONEY_COLOR }} />
            Your own money
          </span>
        )}
      </div>

      <div className="space-y-3">
        {categories.map(cat => {
          const segments = allocation.perSource
            .map(s => ({ sourceId: s.sourceId, name: s.name, amount: s.allocatedByCategory[cat.category] || 0 }))
            .filter(seg => seg.amount > 0.005);
          return (
            <div key={cat.category}>
              <div className="flex justify-between items-baseline text-sm mb-1">
                <span className="font-medium">{cat.category}</span>
                <span className="opacity-70">
                  {formatCurrency(cat.plannedCost, currency)}
                  {cat.ownMoney > 0.005 && (
                    <span className="text-yellow-600 dark:text-yellow-400 font-medium"> · {formatCurrency(cat.ownMoney, currency)} yours</span>
                  )}
                </span>
              </div>
              <div className={`h-3 w-full overflow-hidden rounded-full flex ${trackColor}`}>
                {segments.map(seg => (
                  <div
                    key={seg.sourceId}
                    className="h-full transition-all duration-500"
                    title={`${seg.name}: ${formatCurrency(seg.amount, currency)}`}
                    style={{ width: `${(seg.amount / cat.plannedCost) * 100}%`, backgroundColor: colorBySource.get(seg.sourceId) }}
                  />
                ))}
                {cat.ownMoney > 0.005 && (
                  <div
                    className="h-full transition-all duration-500"
                    title={`Your own money: ${formatCurrency(cat.ownMoney, currency)}`}
                    style={{ width: `${(cat.ownMoney / cat.plannedCost) * 100}%`, backgroundColor: OWN_MONEY_COLOR }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
