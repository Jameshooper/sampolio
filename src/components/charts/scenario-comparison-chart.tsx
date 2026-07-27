'use client';

import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
    TooltipComponent,
    GridComponent,
    LegendComponent,
    MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, formatYearMonth, formatYearMonthShort } from '@/lib/constants';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeScenario } from '@/lib/chart-descriptions';
import type { MonthlyProjection, Currency } from '@/types';

echarts.use([
    LineChart,
    TooltipComponent,
    GridComponent,
    LegendComponent,
    MarkLineComponent,
    CanvasRenderer,
]);

interface ScenarioComparisonChartProps {
    current: MonthlyProjection[];
    modified: MonthlyProjection[];
    currency: Currency;
}

const GREEN = '#22c55e';
const RED = '#ef4444';
const BLUE = '#3b82f6';

/**
 * Two ending-balance lines over the full projection horizon — "Current plan"
 * vs "With changes" — so a scenario's shape is visible at a glance. A dashed
 * zero markLine anchors the axis; the modified line turns red where it dips
 * below zero (a piecewise visualMap on its value dimension). Width-fluid; the
 * caller controls height via the wrapper.
 */
export function ScenarioComparisonChart({ current, modified, currency }: ScenarioComparisonChartProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const { demoMasked } = useAppContext() ?? {};

    const option = useMemo(() => {
        // The x-axis follows the (longer) horizon; both runs share the same months.
        const months = (modified.length >= current.length ? modified : current).map((m) => m.yearMonth);
        const axisColor = isDark ? '#9ca3af' : '#6b7280';
        const splitColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';

        return {
            // ECharts 6 dropped `containLabel` — its default outerBounds already
            // keeps axis labels inside the grid.
            grid: { left: 8, right: 16, top: 40, bottom: 8 },
            legend: {
                top: 0,
                data: ['Current plan', 'With changes'],
                textStyle: { color: isDark ? '#e5e7eb' : '#374151' },
            },
            tooltip: {
                trigger: 'axis' as const,
                formatter: (params: { axisValue: string; dataIndex: number }[]) => {
                    if (!params.length) return '';
                    const idx = params[0].dataIndex;
                    const cur = current[idx]?.endingBalance;
                    const mod = modified[idx]?.endingBalance;
                    let html = `<strong>${formatYearMonth(params[0].axisValue)}</strong>`;
                    if (typeof cur === 'number') {
                        html += `<br/><span style="color:${BLUE}">●</span> Current: ${formatCurrency(cur, currency)}`;
                    }
                    if (typeof mod === 'number') {
                        html += `<br/><span style="color:${GREEN}">●</span> With changes: ${formatCurrency(mod, currency)}`;
                    }
                    if (typeof cur === 'number' && typeof mod === 'number') {
                        const diff = mod - cur;
                        html += `<br/>Difference: ${diff >= 0 ? '+' : ''}${formatCurrency(diff, currency)}`;
                    }
                    return html;
                },
            },
            xAxis: {
                type: 'category' as const,
                data: months,
                boundaryGap: false,
                axisLabel: {
                    color: axisColor,
                    fontSize: 10,
                    formatter: (v: string) => formatYearMonthShort(v),
                    hideOverlap: true,
                },
                axisLine: { lineStyle: { color: splitColor } },
            },
            yAxis: {
                type: 'value' as const,
                axisLabel: {
                    color: axisColor,
                    fontSize: 10,
                    formatter: (v: number) => formatCurrency(v, currency),
                },
                splitLine: { lineStyle: { color: splitColor } },
            },
            series: [
                {
                    name: 'Current plan',
                    type: 'line' as const,
                    data: current.map((m) => m.endingBalance),
                    showSymbol: false,
                    smooth: true,
                    lineStyle: { color: BLUE, width: 2, type: 'dashed' as const },
                    itemStyle: { color: BLUE },
                    z: 2,
                },
                {
                    name: 'With changes',
                    type: 'line' as const,
                    data: modified.map((m) => m.endingBalance),
                    showSymbol: false,
                    smooth: true,
                    lineStyle: { color: GREEN, width: 2.5 },
                    itemStyle: { color: GREEN },
                    z: 3,
                    markLine: {
                        silent: true,
                        symbol: 'none',
                        lineStyle: { color: axisColor, type: 'dashed' as const, opacity: 0.7 },
                        data: [{ yAxis: 0 }],
                        label: { show: false },
                    },
                },
                // Red overlay tracing only the below-zero stretches of the modified
                // run (null elsewhere → gaps), so trouble months pop visually.
                // Chosen over a visualMap piecewise split, which ECharts 6 applies
                // unreliably to plain 1-D line data.
                {
                    name: 'Below zero',
                    type: 'line' as const,
                    data: modified.map((m) => (m.endingBalance < 0 ? m.endingBalance : null)),
                    showSymbol: false,
                    smooth: true,
                    lineStyle: { color: RED, width: 2.5 },
                    itemStyle: { color: RED },
                    z: 4,
                    tooltip: { show: false },
                },
            ],
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [current, modified, currency, isDark, demoMasked]);

    const description = useMemo(
        () => describeScenario(current, modified, (n) => formatCurrency(n, currency)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
        [current, modified, currency, demoMasked]
    );

    const howToRead: ReadCue[] = [
        { shape: 'line', color: BLUE, dashed: true, text: 'The dashed blue line is your plan as it stands now.' },
        { shape: 'line', color: GREEN, text: 'The solid green line is your plan with the change.' },
        { shape: 'line', color: RED, text: 'Where the green line turns red, your balance would drop below zero.' },
    ];

    return (
        <ChartExplain
            chartLabel="Balance over time, current vs changed"
            howToRead={howToRead}
            description={description}
            plainWordsLabel="In plain words"
        >
            <div className="h-72 lg:h-96 w-full">
                <ReactEChartsCore
                    key={demoMasked ? 'masked' : 'plain'}
                    echarts={echarts}
                    option={option}
                    style={{ height: '100%', width: '100%' }}
                    notMerge
                    theme={isDark ? 'dark' : undefined}
                    opts={{ renderer: 'canvas' }}
                />
            </div>
        </ChartExplain>
    );
}
