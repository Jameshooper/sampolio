'use client';

import { useMemo } from 'react';
import { Chart } from 'primereact/chart';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { useAppContext } from '@/components/layout/app-layout';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeWealth } from '@/lib/chart-descriptions';
import type { WealthProjectionMonth, Currency } from '@/types';

export type WealthScope = 'liquid' | 'total';

/**
 * Single source of truth for wealth-category colors (RGB triples, no alpha) —
 * shared by WealthChart and NetWorthChart so the breakdown bars, the net
 * worth overlay/line, and the tooltip text never disagree on what color means
 * what. Use `rgb()`/`rgba()` below to render a given category.
 */
export const WEALTH_COLORS = {
    netWorth: '59, 130, 246', // blue
    cash: '34, 197, 94', // green
    investments: '168, 85, 247', // purple
    receivables: '20, 184, 166', // teal
    homeValue: '245, 158, 11', // amber
    debts: '239, 68, 68', // red
    cards: '244, 63, 94', // rose
    mortgage: '120, 53, 15', // deep brown — distinct from debts red
} as const;

export function rgb(key: keyof typeof WEALTH_COLORS): string {
    return `rgb(${WEALTH_COLORS[key]})`;
}

export function rgba(key: keyof typeof WEALTH_COLORS, alpha: number): string {
    return `rgba(${WEALTH_COLORS[key]}, ${alpha})`;
}

interface WealthCategory {
    key: keyof typeof WEALTH_COLORS;
    label: string;
    stack: 'assets' | 'liabilities';
    value: (m: WealthProjectionMonth) => number;
}

// Total-scope categories: every asset/liability that folds into full net worth.
const TOTAL_CATEGORIES: WealthCategory[] = [
    { key: 'cash', label: 'Cash', stack: 'assets', value: (m) => m.cashAccountsTotal },
    { key: 'investments', label: 'Investments', stack: 'assets', value: (m) => m.investmentsTotal },
    { key: 'receivables', label: 'Receivables', stack: 'assets', value: (m) => m.receivablesTotal },
    { key: 'homeValue', label: 'Home value', stack: 'assets', value: (m) => m.mortgageStakeTotal ?? 0 },
    { key: 'debts', label: 'Debts', stack: 'liabilities', value: (m) => -m.debtsTotal },
    { key: 'cards', label: 'Credit cards', stack: 'liabilities', value: (m) => -(m.cardLiabilitiesTotal ?? 0) },
    { key: 'mortgage', label: 'Mortgage', stack: 'liabilities', value: (m) => -(m.mortgageLiabilityTotal ?? 0) },
];

// Liquid-scope categories: cash + investments net of debts and card liabilities.
const LIQUID_CATEGORIES: WealthCategory[] = [
    { key: 'cash', label: 'Cash', stack: 'assets', value: (m) => m.cashAccountsTotal },
    { key: 'investments', label: 'Investments', stack: 'assets', value: (m) => m.investmentsTotal },
    { key: 'debts', label: 'Debts', stack: 'liabilities', value: (m) => -m.debtsTotal },
    { key: 'cards', label: 'Credit cards', stack: 'liabilities', value: (m) => -(m.cardLiabilitiesTotal ?? 0) },
];

/** The breakdown categories for a scope, shared by WealthChart's stacked bars
 *  and NetWorthChart's tooltip breakdown. */
export function wealthCategoriesForScope(scope: WealthScope): WealthCategory[] {
    return scope === 'total' ? TOTAL_CATEGORIES : LIQUID_CATEGORIES;
}

/** Net worth for a given month, following the scope toggle: 'total' is the
 *  full net worth (incl. mortgage equity + split balance); 'liquid' is cash +
 *  investments net of debts and card liabilities. Shared with NetWorthChart
 *  so both views always agree on the number. */
export function computeScopedNetWorth(m: WealthProjectionMonth, scope: WealthScope): number {
    if (scope === 'total') return m.netWorth;
    return m.cashAccountsTotal + m.investmentsTotal - m.debtsTotal - (m.cardLiabilitiesTotal ?? 0);
}

interface WealthChartProps {
    data: WealthProjectionMonth[];
    currency: Currency;
    scope: WealthScope;
    maxMonths?: number;
}

export function WealthChart({ data, currency, scope, maxMonths = 60 }: WealthChartProps) {
    const { demoMasked } = useAppContext() ?? {};
    const displayData = data.slice(0, Math.min(maxMonths, data.length));
    const scopeLabel = scope === 'total' ? 'net worth' : 'spendable money';

    // Plain-words description (money formatted at call time, so demo-mask aware).
    const description = useMemo(() => {
        const points = displayData.map((m) => ({ month: m.yearMonth, netWorth: computeScopedNetWorth(m, scope) }));
        const latest = displayData[0];
        const components = latest
            ? wealthCategoriesForScope(scope).map((c) => ({
                  label: c.label,
                  value: Math.abs(c.value(latest)),
                  kind: c.stack === 'assets' ? ('asset' as const) : ('liability' as const),
              }))
            : [];
        return describeWealth(points, components, scopeLabel, (n) => formatCurrency(n, currency));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [displayData, scope, scopeLabel, currency, demoMasked]);

    const howToRead: ReadCue[] = [
        { shape: 'band', color: rgb('cash'), text: 'Bars above the line are what you own — cash, investments, your home.' },
        { shape: 'band', color: rgb('debts'), text: 'Bars below the line are what you owe — loans and cards.' },
        { shape: 'line', color: rgb('netWorth'), text: 'The blue line is your net worth: what you own minus what you owe.' },
    ];

    if (displayData.length === 0) {
        return (
            <div className="flex items-center justify-center h-64 text-gray-500">
                No wealth projection data available.
            </div>
        );
    }

    const labels = displayData.map(m => formatYearMonth(m.yearMonth));

    // Build one series per category, then drop any that's 0 for every month
    // (e.g. no mortgage/cards/receivables) so the legend stays uncluttered.
    const visibleSeries = wealthCategoriesForScope(scope)
        .map((c) => ({ ...c, values: displayData.map(c.value) }))
        .filter((c) => c.values.some((v) => v !== 0));

    const netWorthLabel = scope === 'total' ? 'Net worth' : 'Liquid net worth';
    const netWorthValues = displayData.map((m) => computeScopedNetWorth(m, scope));

    const chartData = {
        labels,
        datasets: [
            ...visibleSeries.map((s) => ({
                label: s.label,
                data: s.values,
                backgroundColor: rgba(s.key, 0.7),
                borderColor: rgb(s.key),
                borderWidth: 1,
                stack: s.stack,
            })),
            // Net worth overlay, drawn last so it renders on top of the stacked
            // bars. No `stack` key, so it plots its own (unstacked) value.
            {
                type: 'line' as const,
                label: netWorthLabel,
                data: netWorthValues,
                borderColor: rgb('netWorth'),
                backgroundColor: rgb('netWorth'),
                borderWidth: 3,
                tension: 0.4,
                pointRadius: 2,
                pointHoverRadius: 6,
                fill: false,
            },
        ],
    };

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index' as const,
            intersect: false,
        },
        plugins: {
            legend: {
                position: 'top' as const,
                labels: {
                    usePointStyle: true,
                    padding: 20,
                },
            },
            tooltip: {
                callbacks: {
                    title: function (context: { label: string }[]) {
                        return context[0]?.label || '';
                    },
                    label: function (context: { dataset: { label: string }, raw: number }) {
                        // The net worth line already gets its own footer line below.
                        if (context.dataset.label === netWorthLabel) return null;
                        const value = Math.abs(context.raw);
                        return `${context.dataset.label}: ${formatCurrency(value, currency)}`;
                    },
                    footer: function (context: { dataIndex: number }[]) {
                        const month = displayData[context[0].dataIndex];
                        return `${netWorthLabel}: ${formatCurrency(computeScopedNetWorth(month, scope), currency)}`;
                    },
                },
            },
        },
        scales: {
            x: {
                stacked: true,
                grid: {
                    display: false,
                },
                ticks: {
                    maxRotation: 45,
                    minRotation: 45,
                    maxTicksLimit: 12,
                },
            },
            y: {
                stacked: true,
                grid: {
                    color: 'rgba(0, 0, 0, 0.1)',
                },
                ticks: {
                    callback: function (value: number | string) {
                        if (typeof value === 'number') {
                            return formatCurrency(value, currency);
                        }
                        return value;
                    },
                },
            },
        },
    };

    return (
        <ChartExplain
            chartLabel={scope === 'total' ? 'Net worth projection' : 'Spendable money projection'}
            howToRead={howToRead}
            description={description}
            plainWordsLabel="In plain words"
        >
            <div className="h-72 lg:h-96">
                <Chart type="bar" data={chartData} options={chartOptions} className="!h-full" />
            </div>
        </ChartExplain>
    );
}
