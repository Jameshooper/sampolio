'use client';

import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCents, formatYearMonth, formatYearMonthShort } from '@/lib/constants';
import type { SplitInsights } from '@/lib/split-insights';
import type { Currency } from '@/types';

echarts.use([BarChart, LineChart, TooltipComponent, GridComponent, MarkLineComponent, CanvasRenderer]);

const BLUE = '#3b82f6';
/** Monthly-change bars: green = moved in your favour, orange = you owe more
 * (the same green/orange pair the split balance banners use). */
const UP = '#22c55e';
const DOWN = '#f97316';

interface SplitNetChartProps {
  insights: SplitInsights;
  currency: Currency;
}

/** Smallest "nice" number at or above x. The ladder is deliberately fine
 * (1/1.2/1.5/2/2.5/3/4/5/6/8/10 × 10^k) so the axis top hugs the data — a
 * coarse ladder can double the axis and squash the line into half the plot. */
function niceCeil(x: number): number {
  if (x <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / pow;
  const f = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => m <= s) ?? 10;
  return f * pow;
}

/** The viewer's month-end running net across all groups — a line with a subtle
 * area fill and a dashed zero markLine, over per-month change bars. `net > 0` ⇒
 * owed to the viewer, `< 0` ⇒ the viewer owes. The first month's change is
 * measured against `insights.viewerNetBaseline` (the position just before the
 * window), so it isn't drawn as one giant swing. Width-fluid; the caller sets
 * the height. */
export function SplitNetChart({ insights, currency }: SplitNetChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { demoMasked } = useAppContext() ?? {};

  const option = useMemo(() => {
    const axisColor = isDark ? '#9ca3af' : '#6b7280';
    const splitColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';
    const months = insights.months;
    const nets = months.map((m) => insights.viewerNetByMonth[m] ?? 0);
    // Month-over-month change; month one is measured against the pre-window net.
    const deltas = nets.map((v, i) => v - (i === 0 ? insights.viewerNetBaseline : nets[i - 1]));

    // When a large standing balance dwarfs the monthly changes, bars sharing
    // the line's axis become invisible slivers. In that case (all nets on one
    // side of zero — a zero crossing implies a delta as big as the level, so
    // the shared axis is fine there) the bars move to a HIDDEN second y-axis
    // whose zero is pinned to the same pixel as the primary axis's zero: the
    // primary axis reserves a band across zero (min = −max/4, so zero stays on
    // a gridline with splitNumber 5) and the bar axis is solved from the same
    // zero fraction, with the tallest bar capped at ~80% of its band. Bars
    // stay true zero-anchored; the tooltip carries the exact figures.
    const maxAbsNet = Math.max(...nets.map(Math.abs), 0);
    const maxAbsDelta = Math.max(...deltas.map(Math.abs), 0);
    const oneSided = nets.every((n) => n >= 0) || nets.every((n) => n <= 0);
    const useBarAxis = oneSided && maxAbsDelta > 0 && maxAbsDelta < 0.25 * maxAbsNet;
    let netAxis: Record<string, number> = {};
    let barAxis = { min: 0, max: 1 };
    if (useBarAxis) {
      const positiveNets = nets.some((n) => n > 0);
      const span = niceCeil(maxAbsNet * 1.05);
      const hi1 = positiveNets ? span : span / 4;
      const lo1 = positiveNets ? -span / 4 : -span;
      const f = (0 - lo1) / (hi1 - lo1); // zero's fraction from the bottom
      const maxPos = Math.max(...deltas.filter((d) => d > 0), 0);
      const maxNeg = Math.max(...deltas.filter((d) => d < 0).map((d) => -d), 0);
      const scale = Math.max(f > 0 ? maxNeg / f : 0, f < 1 ? maxPos / (1 - f) : 0, 1) / 0.8;
      netAxis = { min: lo1, max: hi1, splitNumber: 5 };
      barAxis = { min: -scale * f, max: scale * (1 - f) };
    }

    return {
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis' as const,
        // Re-read the source arrays by dataIndex (the cashflow-waterfall
        // pattern) so the two series can't be confused for one another.
        formatter: (params: { axisValue: string; dataIndex: number }[]) => {
          if (!params.length) return '';
          const i = params[0].dataIndex;
          const v = nets[i] ?? 0;
          const d = deltas[i] ?? 0;
          const label = v > 0 ? 'Owed to you' : v < 0 ? 'You owe' : 'Settled up';
          const change =
            d === 0
              ? 'Change: none'
              : `Change: ${d > 0 ? '+' : '−'}${formatCents(Math.abs(d), currency)}`;
          return `<strong>${formatYearMonth(params[0].axisValue)}</strong><br/>${label}: ${formatCents(
            Math.abs(v),
            currency,
          )}<br/>${change}`;
        },
      },
      xAxis: {
        type: 'category' as const,
        data: months,
        // NOTE: no boundaryGap:false — the change bars at either end would be
        // clipped in half by the plot edge.
        axisLabel: {
          color: axisColor,
          fontSize: 10,
          formatter: (v: string) => formatYearMonthShort(v),
          hideOverlap: true,
        },
        axisLine: { lineStyle: { color: splitColor } },
      },
      yAxis: [
        {
          type: 'value' as const,
          ...netAxis,
          axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => formatCents(v, currency) },
          splitLine: { lineStyle: { color: splitColor } },
        },
        // Hidden bar axis (see above); harmlessly unused when !useBarAxis.
        { type: 'value' as const, show: false, min: barAxis.min, max: barAxis.max },
      ],
      series: [
        {
          name: 'Monthly change',
          type: 'bar' as const,
          yAxisIndex: useBarAxis ? 1 : 0,
          barMaxWidth: 22,
          data: deltas.map((d) => ({
            value: d,
            itemStyle: {
              color: d >= 0 ? UP : DOWN,
              opacity: 0.55,
              borderRadius: (d >= 0 ? [2, 2, 0, 0] : [0, 0, 2, 2]) as [number, number, number, number],
            },
          })),
        },
        {
          name: 'Net balance',
          type: 'line' as const,
          z: 10,
          data: nets,
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
