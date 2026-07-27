'use client';

import { useMemo } from 'react';
import { Chart } from 'primereact/chart';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { useAppContext } from '@/components/layout/app-layout';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeWealth } from '@/lib/chart-descriptions';
import { rgb, rgba, computeScopedNetWorth, wealthCategoriesForScope, type WealthScope } from './wealth-chart';
import type { WealthProjectionMonth, Currency } from '@/types';

interface NetWorthChartProps {
    data: WealthProjectionMonth[];
    currency: Currency;
    scope: WealthScope;
    maxMonths?: number;
}

const ZERO_LINE_LABEL = 'Zero Line';

export function NetWorthChart({ data, currency, scope, maxMonths = 60 }: NetWorthChartProps) {
    const { demoMasked } = useAppContext() ?? {};
    const displayData = data.slice(0, Math.min(maxMonths, data.length));
    const scopeLabel = scope === 'total' ? 'net worth' : 'spendable money';

    // Same describe engine as the stacked WealthChart, scoped to this view.
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
        { shape: 'line', color: rgb('netWorth'), text: 'The line is your net worth: everything you own minus what you owe.' },
        { shape: 'line', color: 'rgba(239, 68, 68, 0.8)', dashed: true, text: "The dashed red line is zero — above it you're ahead, below it behind." },
        { shape: 'band', color: rgba('netWorth', 0.3), text: 'The line rising means you\'re growing your wealth; falling means it\'s shrinking.' },
    ];

    if (displayData.length === 0) {
        return (
            <div className="flex items-center justify-center h-64 text-gray-500">
                No wealth projection data available.
            </div>
        );
    }

    const labels = displayData.map(m => formatYearMonth(m.yearMonth));
    const netWorthLabel = scope === 'total' ? 'Net Worth' : 'Liquid Net Worth';

    // Find min/max for scaling
    const netWorths = displayData.map(m => computeScopedNetWorth(m, scope));
    const minNetWorth = Math.min(...netWorths);
    const maxNetWorth = Math.max(...netWorths);

    const chartData = {
        labels,
        datasets: [
            {
                label: netWorthLabel,
                data: netWorths,
                borderColor: rgb('netWorth'),
                backgroundColor: (context: { chart: { ctx: CanvasRenderingContext2D, chartArea: { top: number, bottom: number } } }) => {
                    const ctx = context.chart.ctx;
                    const chartArea = context.chart.chartArea;
                    if (!chartArea) return rgba('netWorth', 0.3);

                    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                    gradient.addColorStop(0, rgba('netWorth', 0.4));
                    gradient.addColorStop(1, rgba('netWorth', 0.05));
                    return gradient;
                },
                fill: true,
                tension: 0.4,
                pointRadius: 2,
                pointHoverRadius: 6,
                borderWidth: 3,
            },
            // Zero line reference
            {
                label: ZERO_LINE_LABEL,
                data: displayData.map(() => 0),
                borderColor: 'rgba(239, 68, 68, 0.5)',
                borderDash: [5, 5],
                borderWidth: 2,
                pointRadius: 0,
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
                display: true,
                position: 'top' as const,
                labels: {
                    usePointStyle: true,
                    padding: 20,
                    // The dashed zero reference line isn't a real series — keep it
                    // out of the legend, which is now the card's only legend.
                    filter: function (item: { text: string }) {
                        return item.text !== ZERO_LINE_LABEL;
                    },
                },
            },
            tooltip: {
                callbacks: {
                    title: function (context: { label: string }[]) {
                        return context[0]?.label || '';
                    },
                    label: function (context: { datasetIndex: number, raw: number, dataIndex: number }) {
                        if (context.datasetIndex === 1) return null; // Skip zero line
                        const month = displayData[context.dataIndex];
                        const lines = [
                            `${netWorthLabel}: ${formatCurrency(context.raw, currency)}`,
                            `---`,
                        ];
                        for (const category of wealthCategoriesForScope(scope)) {
                            const value = category.value(month);
                            if (value === 0) continue; // skip zero-valued lines for this month
                            lines.push(`${category.label}: ${formatCurrency(value, currency)}`);
                        }
                        return lines;
                    },
                },
            },
        },
        scales: {
            x: {
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
                grid: {
                    color: 'rgba(0, 0, 0, 0.1)',
                },
                min: minNetWorth < 0 ? minNetWorth * 1.1 : 0,
                max: maxNetWorth > 0 ? maxNetWorth * 1.1 : 100,
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
            chartLabel={scope === 'total' ? 'Net worth over time' : 'Spendable money over time'}
            howToRead={howToRead}
            description={description}
            plainWordsLabel="In plain words"
        >
            <div className="h-72 lg:h-96">
                <Chart type="line" data={chartData} options={chartOptions} className="!h-full" />
            </div>
        </ChartExplain>
    );
}
