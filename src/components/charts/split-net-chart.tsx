'use client';

import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCents, formatYearMonth, formatYearMonthShort } from '@/lib/constants';
import type { SplitInsights } from '@/lib/split-insights';
import type { Currency } from '@/types';

echarts.use([LineChart, TooltipComponent, GridComponent, MarkLineComponent, CanvasRenderer]);

const BLUE = '#3b82f6';

interface SplitNetChartProps {
  insights: SplitInsights;
  currency: Currency;
}

/** The viewer's month-end running net across all groups — a single line with a
 * subtle area fill and a dashed zero markLine. `net > 0` ⇒ owed to the viewer,
 * `< 0` ⇒ the viewer owes. Width-fluid; the caller sets the height. */
export function SplitNetChart({ insights, currency }: SplitNetChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { demoMasked } = useAppContext() ?? {};

  const option = useMemo(() => {
    const axisColor = isDark ? '#9ca3af' : '#6b7280';
    const splitColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';
    const months = insights.months;

    return {
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: { axisValue: string; data: number }[]) => {
          if (!params.length) return '';
          const v = params[0].data ?? 0;
          const label = v > 0 ? 'Owed to you' : v < 0 ? 'You owe' : 'Settled up';
          return `<strong>${formatYearMonth(params[0].axisValue)}</strong><br/>${label}: ${formatCents(Math.abs(v), currency)}`;
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
        axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => formatCents(v, currency) },
        splitLine: { lineStyle: { color: splitColor } },
      },
      series: [
        {
          name: 'Net balance',
          type: 'line' as const,
          data: months.map((m) => insights.viewerNetByMonth[m] ?? 0),
          showSymbol: false,
          smooth: true,
          lineStyle: { color: BLUE, width: 2.5 },
          itemStyle: { color: BLUE },
          areaStyle: { color: BLUE, opacity: 0.12 },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: axisColor, type: 'dashed' as const, opacity: 0.7 },
            data: [{ yAxis: 0 }],
            label: { show: false },
          },
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCents output depends on demo mode
  }, [insights, currency, isDark, demoMasked]);

  return (
    <ReactEChartsCore
      key={demoMasked ? 'masked' : 'plain'}
      echarts={echarts}
      option={option}
      style={{ height: '100%', width: '100%' }}
      notMerge
      theme={isDark ? 'dark' : undefined}
      opts={{ renderer: 'canvas' }}
    />
  );
}
