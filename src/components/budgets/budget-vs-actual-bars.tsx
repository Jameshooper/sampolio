'use client';

import { formatCurrency } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';
import type { Currency } from '@/types';
import type { BudgetActualsRollup } from '@/lib/budget-utils';

function barColor(planned: number, actual: number): string {
  if (planned <= 0) return 'bg-yellow-500'; // spent with nothing planned — surfaced, not an error
  const ratio = actual / planned;
  if (ratio > 1) return 'bg-red-500';
  if (ratio >= 0.8) return 'bg-yellow-500';
  return 'bg-green-500';
}

/** "Food — 380 € of 500 € used": per-category spent-vs-planned bars. */
export function BudgetVsActualBars({
  rollup,
  currency,
}: {
  rollup: BudgetActualsRollup;
  currency: Currency;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const trackColor = isDark ? 'bg-neutral-700' : 'bg-neutral-200';

  const categories = rollup.perCategory.filter(c => c.actual > 0 || c.planned > 0);
  if (categories.length === 0 || rollup.totalActual === 0) return null;

  return (
    <div className="space-y-3">
      {categories.map(cat => {
        const over = cat.planned > 0 && cat.actual > cat.planned;
        const pct = cat.planned > 0 ? Math.min(100, (cat.actual / cat.planned) * 100) : (cat.actual > 0 ? 100 : 0);
        return (
          <div key={cat.category}>
            <div className="flex justify-between items-baseline text-sm mb-1">
              <span className="font-medium">{cat.category}</span>
              <span className="opacity-70">
                {cat.planned > 0 ? (
                  <>
                    {formatCurrency(cat.actual, currency)} of {formatCurrency(cat.planned, currency)} used
                    {over && (
                      <span className="text-red-500 font-medium"> · {formatCurrency(cat.actual - cat.planned, currency)} over</span>
                    )}
                  </>
                ) : (
                  <>{formatCurrency(cat.actual, currency)} spent (nothing planned)</>
                )}
              </span>
            </div>
            <div className={`h-3 w-full overflow-hidden rounded-full ${trackColor}`}>
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColor(cat.planned, cat.actual)}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
