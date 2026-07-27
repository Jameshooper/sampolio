'use client';

import { useMemo, useRef, useCallback } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { BarChart, LineChart, CandlestickChart } from 'echarts/charts';
import {
    TooltipComponent,
    GridComponent,
    LegendComponent,
    DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { describeWaterfall, type WaterfallMonthLike } from '@/lib/chart-descriptions';
import {
    ChartExplainButton,
    ChartExplainPanel,
    ChartTourBar,
    useChartExplain,
    useChartTour,
    type ReadCue,
    type ChartTourStep,
} from '@/components/ui/chart-explain';
import type { MonthlyProjection, Currency } from '@/types';

echarts.use([
    CandlestickChart,
    BarChart,
    LineChart,
    TooltipComponent,
    GridComponent,
    LegendComponent,
    DataZoomComponent,
    CanvasRenderer,
]);

interface CashflowWaterfallChartProps {
    data: MonthlyProjection[];
    currency: Currency;
    height?: string;
    /** The current calendar month ("YYYY-MM"); used only by the plain-words
     *  description. Falls back to the first forecast month when omitted. */
    nowMonth?: string;
}

/**
 * Cashflow waterfall chart that shows:
 * - Candlestick-style bars: open = startingBalance, close = endingBalance,
 *   high = startingBalance + totalIncome, low = endingBalance (or startingBalance whichever is lower)
 *   Green when endingBalance >= startingBalance, red otherwise.
 * - Overlaid transparent income (green) and expense (red) indicator bars
 * - Balance line tracking the ending balance over time
 */
export function CashflowWaterfallChart({ data, currency, height = '420px', nowMonth }: CashflowWaterfallChartProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const { demoMasked } = useAppContext() ?? {};

    const option = useMemo(() => {
        const months = data.map(m => formatYearMonth(m.yearMonth));

        // For each month, build the candlestick data:
        // ECharts candlestick format: [open, close, low, high]
        // We use: open = startingBalance, close = endingBalance
        //         low = min(startingBalance, endingBalance)
        //         high = startingBalance + totalIncome (peak before expenses)
        const candlestickData = data.map(m => {
            const open = m.startingBalance;
            const close = m.endingBalance;
            const peak = m.startingBalance + m.totalIncome;
            const low = Math.min(open, close);
            const high = Math.max(peak, open, close);
            return [open, close, low, high];
        });

        // Income bars (stacked on top of starting balance). Real "actual" months
        // (reconstructed from bank transactions) get a flatter, desaturated fill so
        // they read as past fact vs. the forecast's gradient bars.
        const incomeData = data.map(m =>
            m.isActual ? { value: m.totalIncome, itemStyle: { color: 'rgba(34, 197, 94, 0.35)' } } : m.totalIncome
        );

        // Expense bars (shown as negative from the peak)
        const expenseData = data.map(m =>
            m.isActual ? { value: m.totalExpenses, itemStyle: { color: 'rgba(239, 68, 68, 0.35)' } } : m.totalExpenses
        );

        // Balance line
        const balanceLine = data.map(m => m.endingBalance);

        const textColor = isDark ? '#e5e7eb' : '#374151';
        const gridLineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

        // Boundary between past actuals and the forecast → a "Now" marker line.
        const firstForecastIdx = data.findIndex(m => !m.isActual);
        const showNowLine = firstForecastIdx > 0 && firstForecastIdx < data.length;
        const boundaryCategory = showNowLine ? months[firstForecastIdx] : null;

        // Default the visible window to "now + next 12 months" (current month at the
        // left edge). The slider + inside-drag let the user pan back to the
        // retrospective or out to the far future. Without actuals the window simply
        // starts at the first month.
        const total = data.length;
        const WINDOW = 13; // current month + next 12
        const winStart = firstForecastIdx > 0 ? firstForecastIdx : 0;
        const hasZoom = total > WINDOW;
        const zoomStartPct = hasZoom ? (winStart / total) * 100 : 0;
        const zoomEndPct = hasZoom ? Math.min(100, ((winStart + WINDOW) / total) * 100) : 100;

        return {
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                textStyle: { color: textColor },
                formatter: (params: Array<{ seriesName: string; value: number | number[]; dataIndex: number; marker: string }>) => {
                    const idx = params[0]?.dataIndex ?? 0;
                    const m = data[idx];
                    if (!m) return '';
                    const lines = [
                        `<strong>${formatYearMonth(m.yearMonth)}</strong>`,
                        `Starting: ${formatCurrency(m.startingBalance, currency)}`,
                        `<span style="color:#22c55e">▲ Income: +${formatCurrency(m.totalIncome, currency)}</span>`,
                        `<span style="color:#ef4444">▼ Expenses: -${formatCurrency(m.totalExpenses, currency)}</span>`,
                        `<span style="color:${m.netChange >= 0 ? '#22c55e' : '#ef4444'}">Net: ${m.netChange >= 0 ? '+' : ''}${formatCurrency(m.netChange, currency)}</span>`,
                        `<strong>Ending: ${formatCurrency(m.endingBalance, currency)}</strong>`,
                    ];
                    return lines.join('<br/>');
                },
            },
            legend: {
                data: ['Income', 'Expenses', 'Balance'],
                top: 0,
                textStyle: { color: textColor },
            },
            grid: {
                left: 80,
                right: 30,
                top: 40,
                bottom: hasZoom ? 80 : 50,
            },
            dataZoom: hasZoom ? [
                {
                    type: 'slider',
                    start: zoomStartPct,
                    end: zoomEndPct,
                    bottom: 10,
                    textStyle: { color: textColor },
                },
                {
                    type: 'inside',
                    start: zoomStartPct,
                    end: zoomEndPct,
                },
            ] : [],
            xAxis: {
                type: 'category',
                data: months,
                axisLabel: {
                    color: textColor,
                    rotate: data.length > 8 ? 45 : 0,
                    fontSize: 11,
                },
                axisLine: { lineStyle: { color: gridLineColor } },
            },
            yAxis: {
                type: 'value',
                axisLabel: {
                    color: textColor,
                    formatter: (v: number) => {
                        if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(0)}k`;
                        return v.toString();
                    },
                },
                splitLine: { lineStyle: { color: gridLineColor } },
            },
            series: [
                // Stack 1: Income — transparent base at startingBalance, then income going up
                {
                    name: '_baseIncome',
                    type: 'bar',
                    stack: 'income',
                    silent: true,
                    itemStyle: { borderColor: 'transparent', color: 'transparent' },
                    emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
                    data: data.map(m => m.startingBalance),
                },
                {
                    name: 'Income',
                    type: 'bar',
                    stack: 'income',
                    barGap: '-100%',
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(34, 197, 94, 0.85)' },
                            { offset: 1, color: 'rgba(34, 197, 94, 0.45)' },
                        ]),
                        borderRadius: [2, 2, 0, 0],
                    },
                    data: incomeData,
                },
                // Stack 2: Expenses — transparent base at endingBalance, then expenses going up to the peak
                {
                    name: '_baseExpense',
                    type: 'bar',
                    stack: 'expense',
                    silent: true,
                    itemStyle: { borderColor: 'transparent', color: 'transparent' },
                    emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
                    barGap: '-100%',
                    data: data.map(m => m.endingBalance),
                },
                {
                    name: 'Expenses',
                    type: 'bar',
                    stack: 'expense',
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(239, 68, 68, 0.5)' },
                            { offset: 1, color: 'rgba(239, 68, 68, 0.85)' },
                        ]),
                        borderRadius: [2, 2, 0, 0],
                    },
                    data: expenseData,
                },
                // Balance line
                {
                    name: 'Balance',
                    type: 'line',
                    data: balanceLine,
                    smooth: 0.3,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: {
                        width: 3,
                        color: '#8b5cf6',
                    },
                    itemStyle: {
                        color: '#8b5cf6',
                        borderWidth: 2,
                        borderColor: isDark ? '#1f2937' : '#ffffff',
                    },
                    markLine: showNowLine
                        ? {
                            silent: true,
                            symbol: 'none',
                            lineStyle: { color: isDark ? '#a78bfa' : '#7c3aed', type: 'dashed', width: 1.5 },
                            label: {
                                show: true,
                                formatter: 'Now',
                                position: 'insideEndTop',
                                color: isDark ? '#c4b5fd' : '#7c3aed',
                                fontSize: 11,
                            },
                            data: [{ xAxis: boundaryCategory }],
                        }
                        : undefined,
                    z: 10,
                },
            ],
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [data, currency, isDark, demoMasked]);

    // Explain / plain-words / guided tour
    const explain = useChartExplain();
    const chartRef = useRef<ReactEChartsCore>(null);
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance() ?? null, []);

    const resolvedNow = nowMonth ?? data.find((m) => !m.isActual)?.yearMonth ?? data[0]?.yearMonth ?? '';

    const description = useMemo(() => {
        const months: WaterfallMonthLike[] = data.map((m) => ({
            month: m.yearMonth,
            netChange: m.netChange,
            endingBalance: m.endingBalance,
            isActual: m.isActual,
        }));
        return describeWaterfall(months, resolvedNow, (n) => formatCurrency(n, currency));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [data, resolvedNow, currency, demoMasked]);

    const howToRead: ReadCue[] = useMemo(
        () => [
            { shape: 'updown', color: '#22c55e', color2: '#ef4444', text: 'Green is money coming in that month; red is money going out.' },
            { shape: 'line', color: '#8b5cf6', text: 'The purple line is your balance climbing or dipping over time.' },
            { shape: 'square', color: 'rgba(34,197,94,0.35)', text: 'Faded bars are the real past; bright bars are the forecast ahead.' },
            { shape: 'line', color: '#7c3aed', dashed: true, text: 'The dashed "Now" line splits the real past from the forecast.' },
        ],
        []
    );

    const tourSteps: ChartTourStep[] = useMemo(() => {
        const firstForecastIdx = data.findIndex((m) => !m.isActual);
        const hasActuals = firstForecastIdx > 0;
        const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
        const pastIdx = hasActuals ? range(0, firstForecastIdx) : [];
        const futureIdx = range(hasActuals ? firstForecastIdx : 0, data.length);
        // Series order: 0 _baseIncome, 1 Income, 2 _baseExpense, 3 Expenses, 4 Balance.
        const hlBars = (dataIndex?: number[]) => (chart: EChartsType) => {
            chart.dispatchAction({ type: 'highlight', seriesIndex: 1, ...(dataIndex ? { dataIndex } : {}) });
            chart.dispatchAction({ type: 'highlight', seriesIndex: 3, ...(dataIndex ? { dataIndex } : {}) });
        };
        const dpBars = () => (chart: EChartsType) => {
            chart.dispatchAction({ type: 'downplay', seriesIndex: 1 });
            chart.dispatchAction({ type: 'downplay', seriesIndex: 3 });
        };
        const steps: ChartTourStep[] = [
            { text: 'Each month is one bar — green is money in, red is money out.', apply: hlBars(), clear: dpBars() },
            {
                text: 'The purple line is your balance, month after month.',
                apply: (chart) => chart.dispatchAction({ type: 'highlight', seriesIndex: 4 }),
                clear: (chart) => chart.dispatchAction({ type: 'downplay', seriesIndex: 4 }),
            },
        ];
        if (hasActuals) {
            steps.push({ text: 'Faded bars on the left are the real past, pulled from your bank.', apply: hlBars(pastIdx), clear: dpBars() });
            steps.push({ text: "Everything right of the 'Now' line is the forecast ahead.", apply: hlBars(futureIdx), clear: dpBars() });
        } else {
            steps.push({ text: 'Every bar here is a forecast — connect a bank to see real history.', apply: hlBars(futureIdx), clear: dpBars() });
        }
        return steps;
    }, [data]);

    const tour = useChartTour(tourSteps, getChart);

    if (data.length === 0) {
        return (
            <div className="flex items-center justify-center h-64 text-gray-500">
                No projection data available.
            </div>
        );
    }

    return (
        <div>
            <div className="mb-2 flex items-center justify-end">
                <ChartExplainButton open={explain.open} onClick={explain.toggle} controls={explain.panelId} />
            </div>
            <ChartExplainPanel
                id={explain.panelId}
                open={explain.open}
                chartLabel="Cashflow projection"
                howToRead={howToRead}
                description={description}
                onStartTour={tour.start}
                describedById={explain.descId}
            />
            <ReactEChartsCore
                key={demoMasked ? 'masked' : 'plain'}
                ref={chartRef}
                echarts={echarts}
                option={option}
                style={{ height, width: '100%' }}
                notMerge
                lazyUpdate
                aria-describedby={explain.descId}
            />
            {tour.active && <ChartTourBar tour={tour} label="Cashflow projection" />}
        </div>
    );
}
