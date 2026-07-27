'use client';

import { useEffect, useState } from 'react';
import { Card } from 'primereact/card';
import { getProjection } from '@/lib/actions/projection';
import { compareForecastToActual, type CategoryDeviation } from '@/lib/forecast-vs-actual';
import { guessItemCategory } from '@/lib/category-utils';
import { formatCurrency, formatYearMonth, getCategoryColor } from '@/lib/constants';
import { useTheme } from '@/components/providers/theme-provider';
import type { Currency } from '@/types';

/**
 * "Last month: plan vs reality" — the top per-category deviations between the
 * plan's expense breakdown and the bank-actual retrospective for the last
 * closed month. Past forecasts aren't stored (projections are ephemeral), so
 * the comparison uses the CURRENT month's forecast breakdown — dominated by
 * the same recurring items — as the plan baseline; the caption says so.
 * Hidden entirely when there's no retrospective (no synced bank account).
 */
export function ForecastVsActualCard({ accountId, currency }: { accountId: string; currency: Currency }) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const [data, setData] = useState<{ month: string; deviations: CategoryDeviation[] } | null>(null);

    useEffect(() => {
        if (!accountId) return;
        getProjection(accountId).then((res) => {
            if (!res.success || !res.data) return;
            const retro = res.data.retrospective ?? [];
            const forecast = res.data.monthly?.[0];
            const lastActual = retro[retro.length - 1];
            if (!forecast || !lastActual) return;
            // Retrospective line "categories" are raw bank transaction codes —
            // recategorize by merchant name so they can join the plan's
            // ITEM_CATEGORIES vocabulary (best effort; unmatched → Uncategorized).
            const actuals = lastActual.expenseBreakdown.map((item) => ({
                ...item,
                category: guessItemCategory(item.name) ?? undefined,
            }));
            // Injected lines (card bill, mortgage, budget) are fixed flows whose
            // actual counterparts book under unguessable merchant names — they'd
            // only produce mirror-image noise here, so both they and the
            // Uncategorized remainder are excluded from the comparison.
            const plannable = forecast.expenseBreakdown.filter(
                (i) => i.source !== 'credit-card' && i.source !== 'mortgage-payment' && i.source !== 'budget'
            );
            const deviations = compareForecastToActual(plannable, actuals, 5)
                .filter((d) => d.category !== 'Uncategorized')
                .slice(0, 3);
            if (deviations.length > 0) setData({ month: lastActual.yearMonth, deviations });
        });
    }, [accountId]);

    if (!data) return null;

    const maxVal = Math.max(...data.deviations.flatMap((d) => [d.forecast, d.actual]), 1);

    return (
        <Card>
            <h2 className={`text-lg font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                {formatYearMonth(data.month)}: plan vs reality
            </h2>
            <p className={`text-xs mb-4 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                Biggest gaps between your planned monthly spending and what the bank actually recorded.
            </p>
            <div className="space-y-3">
                {data.deviations.map((d) => (
                    <div key={d.category}>
                        <div className="flex items-center justify-between text-sm mb-1">
                            <span className={isDark ? 'text-gray-200' : 'text-gray-700'}>{d.category}</span>
                            <span className={`font-medium ${d.delta > 0 ? 'text-red-500' : 'text-green-500'}`}>
                                {d.delta > 0 ? '+' : ''}{formatCurrency(d.delta, currency)}
                            </span>
                        </div>
                        {/* Paired bars: plan (muted) vs actual (category color) */}
                        <div className="space-y-0.5">
                            <div className="flex items-center gap-2">
                                <div className={`h-2 rounded ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`} style={{ width: `${(d.forecast / maxVal) * 100}%`, minWidth: d.forecast > 0 ? 4 : 0 }} />
                                <span className="text-[10px] opacity-50 whitespace-nowrap">plan {formatCurrency(d.forecast, currency)}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="h-2 rounded" style={{ width: `${(d.actual / maxVal) * 100}%`, minWidth: d.actual > 0 ? 4 : 0, backgroundColor: getCategoryColor(d.category) }} />
                                <span className="text-[10px] opacity-50 whitespace-nowrap">actual {formatCurrency(d.actual, currency)}</span>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}
