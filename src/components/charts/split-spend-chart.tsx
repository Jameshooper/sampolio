'use client';

import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { TooltipComponent, GridComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCents, formatYearMonthShort, getCategoryColor } from '@/lib/constants';
import { bucketSpendByCategory, type SplitInsights } from '@/lib/split-insights';
import type { Currency } from '@/types';

echarts.use([BarChart, TooltipComponent, GridComponent, LegendComponent, CanvasRenderer]);

// A small pleasant palette, assigned by a stable hash of the series key (group
// id or user id) so a given group/member always keeps the same colour across
// renders and both chart modes. Deliberately independent of CATEGORY_COLORS
// (those carry discretionary/fixed semantics that don't apply here).
const PALETTE = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#ef4444', '#14b8a6', '#eab308', '#6366f1',
];
function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Max category series before the long tail folds into one "Other" bucket. */
const CATEGORY_LIMIT = 8;

interface SplitSpendChartProps {
  insights: SplitInsights;
  mode: 'group' | 'member' | 'category';
  currency: Currency;
}

/** Stacked monthly spend across split groups — one bar per month, one stacked
 * series per group (mode 'group'), per member who fronted money (mode
 * 'member'), or per expense category (mode 'category', capped at
 * CATEGORY_LIMIT + an "Other" bucket and colored from the app-wide
 * CATEGORY_COLORS map, never positionally). Width-fluid; the caller sets the
 * height via its wrapper. */
export function SplitSpendChart({ insights, mode, currency }: SplitSpendChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { demoMasked } = useAppContext() ?? {};

  const option = useMemo(() => {
    const axisColor = isDark ? '#9ca3af' : '#6b7280';
    const splitColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(148,163,184,0.25)';
    const months = insights.months;

    // Category mode collapses the long tail into one "Other" series so the
    // stack stays legible (pure helper, so the bucketing is unit-tested).
    const buckets = mode === 'category' ? bucketSpendByCategory(insights, CATEGORY_LIMIT) : null;

    // Per-month total across whichever series set is showing (all groups' spend,
    // all members' fronted amounts, or all categories), precomputed once so both
    // the tooltip percentage and the in-bar labels (member mode) share the same
    // numbers instead of re-summing per hover/render.
    const monthTotals =
      mode === 'group'
        ? months.map((m) => insights.groups.reduce((sum, g) => sum + (insights.spendByGroup[m]?.[g.id] ?? 0), 0))
        : mode === 'category'
          ? months.map((m) => buckets!.categories.reduce((sum, c) => sum + (buckets!.spend[m]?.[c] ?? 0), 0))
          : months.map((m) => insights.members.reduce((sum, mem) => sum + (insights.paidByMember[m]?.[mem.userId] ?? 0), 0));

    const series =
      mode === 'group'
        ? insights.groups.map((g) => ({
            name: g.name,
            type: 'bar' as const,
            stack: 'total',
            emphasis: { focus: 'series' as const },
            data: months.map((m) => insights.spendByGroup[m]?.[g.id] ?? 0),
            itemStyle: { color: colorForKey(g.id), borderRadius: [0, 0, 0, 0] as [number, number, number, number] },
          }))
        : mode === 'category'
        ? buckets!.categories.map((category) => ({
            name: category,
            type: 'bar' as const,
            stack: 'total',
            emphasis: { focus: 'series' as const },
            data: months.map((m) => buckets!.spend[m]?.[category] ?? 0),
            // Canonical category color — never a positional palette index.
            itemStyle: { color: getCategoryColor(category), borderRadius: [0, 0, 0, 0] as [number, number, number, number] },
          }))
        : insights.members.map((mem) => ({
            name: mem.name,
            type: 'bar' as const,
            stack: 'total',
            emphasis: { focus: 'series' as const },
            data: months.map((m) => insights.paidByMember[m]?.[mem.userId] ?? 0),
            itemStyle: { color: colorForKey(mem.userId) },
            // In-bar percentage share of that month's total, hidden when the
            // segment is too small to legibly fit the label.
            label: {
              show: true,
              position: 'inside' as const,
              color: '#fff',
              fontSize: 10,
              formatter: (p: { value: number; dataIndex: number }) => {
                const total = monthTotals[p.dataIndex] ?? 0;
                if (total <= 0) return '';
                const pct = Math.round(((p.value ?? 0) / total) * 100);
                return pct < 8 ? '' : `${pct}%`;
              },
            },
          }));

    return {
      grid: { left: 8, right: 12, top: 32, bottom: 8, containLabel: true },
      legend: { top: 0, type: 'scroll' as const, textStyle: { color: isDark ? '#e5e7eb' : '#374151' } },
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (
          params: { axisValue: string; seriesName: string; value: number; marker: string; dataIndex: number }[],
        ) => {
          if (!params.length) return '';
          const total = monthTotals[params[0].dataIndex] ?? 0;
          const rows = params
            .filter((p) => (p.value ?? 0) !== 0)
            .map((p) => {
              const pct = total > 0 ? Math.round(((p.value ?? 0) / total) * 100) : 0;
              return `${p.marker}${p.seriesName}: ${formatCents(p.value, currency)} (${pct}%)`;
            });
          if (rows.length === 0) return `${params[0].axisValue}<br/>No spending`;
          return `<strong>${params[0].axisValue}</strong><br/>${rows.join('<br/>')}`;
        },
      },
      xAxis: {
        type: 'category' as const,
        data: months.map((m) => formatYearMonthShort(m)),
        axisLabel: { color: axisColor, fontSize: 10, hideOverlap: true },
        axisLine: { lineStyle: { color: splitColor } },
      },
      yAxis: {
        type: 'value' as const,
        axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => formatCents(v, currency) },
        splitLine: { lineStyle: { color: splitColor } },
      },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCents output depends on demo mode
  }, [insights, mode, currency, isDark, demoMasked]);

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
