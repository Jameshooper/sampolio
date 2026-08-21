'use client';

import { useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeMortgageSankey } from '@/lib/chart-descriptions';
import { formatCurrency } from '@/lib/constants';
import { buildMortgageSankeySnapshot } from '@/lib/mortgage-utils';
import type { SharedMortgage, MortgageProjectionMonth, Currency } from '@/types';

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer]);

const BLUE = '#3b82f6';
const PURPLE = '#a855f7';
const GRAY = '#9ca3af';
const SLATE = '#64748b';
const GREEN = '#22c55e';
const EMERALD = '#10b981';
const AMBER = '#f59e0b';
const ORANGE = '#f97316';
const RED = '#ef4444';
const LIGHT_BLUE = '#60a5fa';

interface SankeyNode {
  name: string;
  depth: number;
  itemStyle: { color: string; borderColor: string };
}
interface SankeyLink {
  source: string;
  target: string;
  value: number;
  lineStyle: { color: string; opacity: number };
}

/**
 * Money-flow Sankey for the ownership panel: what each member has paid in by
 * the scrubber month (down payment + monthly transfers) → the whole mortgage
 * → interest/amortization paid vs left, plus down payments and fees outlets.
 */
export function MortgageOwnershipSankey({
  months,
  mortgage,
  currency,
  idx,
  currentUserId,
}: {
  months: MortgageProjectionMonth[];
  mortgage: SharedMortgage;
  currency: Currency;
  idx: number;
  currentUserId?: string;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { demoMasked } = useAppContext() ?? {};

  const snapshot = useMemo(
    () => buildMortgageSankeySnapshot(months, mortgage, idx),
    [months, mortgage, idx]
  );

  const description = useMemo(() => {
    if (!snapshot) return [];
    const totalPaidIn = snapshot.members.reduce((s, m) => s + m.paidSoFar, 0);
    return describeMortgageSankey(
      {
        totalPaidIn,
        interestPaid: snapshot.interestPaid,
        amortizationPaid: snapshot.amortizationPaid,
        amortizationLeft: snapshot.amortizationLeft,
      },
      (n) => formatCurrency(n, currency),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [snapshot, currency, demoMasked]);

  const howToRead: ReadCue[] = [
    { shape: 'band', color: BLUE, text: 'Bands on the left are the money each person has paid into the loan.' },
    { shape: 'band', color: GREEN, text: 'Bands on the right show where it went: paying down the loan vs interest.' },
  ];

  const option = useMemo(() => {
    if (!snapshot) return null;

    const CENTER = 'Whole mortgage';
    const nodes: SankeyNode[] = [];
    const links: SankeyLink[] = [];
    const addNode = (name: string, depth: number, color: string) =>
      nodes.push({ name, depth, itemStyle: { color, borderColor: color } });
    const addLink = (source: string, target: string, value: number, color: string) => {
      if (value > 0.005) links.push({ source, target, value, lineStyle: { color, opacity: 0.3 } });
    };

    addNode(CENTER, 1, SLATE);

    // Left: each member's paid-in so far + the future payments still owed.
    const memberColors = [BLUE, PURPLE, EMERALD, AMBER];
    snapshot.members.forEach((m, i) => {
      if (m.paidSoFar <= 0.005) return;
      const color = m.userId === currentUserId ? BLUE : memberColors[(i + 1) % memberColors.length];
      const name = `${m.name} — paid so far`;
      addNode(name, 0, color);
      addLink(name, CENTER, m.paidSoFar, color);
    });
    if (snapshot.stillToPay > 0.005) {
      addNode('Still to pay', 0, GRAY);
      addLink('Still to pay', CENTER, snapshot.stillToPay, GRAY);
    }

    // Right: where the whole-mortgage money goes.
    const buckets: Array<[string, number, string]> = [
      ['Amortization paid', snapshot.amortizationPaid, GREEN],
      ['Interest paid', snapshot.interestPaid, AMBER],
      ['Amortization left', snapshot.amortizationLeft, LIGHT_BLUE],
      ['Interest left', snapshot.interestLeft, RED],
      ['Down payments', snapshot.downPayments, EMERALD],
      ['Fees & insurance', snapshot.feesAndInsurance, ORANGE],
    ];
    for (const [name, value, color] of buckets) {
      if (value <= 0.005) continue;
      addNode(name, 2, color);
      addLink(CENTER, name, value, color);
    }

    return {
      animation: false,
      tooltip: {
        trigger: 'item' as const,
        formatter: (params: Record<string, unknown>) => {
          if (params.dataType === 'node') {
            return `<strong>${params.name}</strong><br/>${formatCurrency(params.value as number, currency)}`;
          }
          if (params.dataType === 'edge') {
            const d = params.data as { source: string; target: string; value: number };
            return `${d.source} → ${d.target}<br/>${formatCurrency(d.value, currency)}`;
          }
          return '';
        },
      },
      series: [
        {
          type: 'sankey',
          layoutIterations: 0,
          nodeGap: 14,
          nodeWidth: 16,
          left: 10,
          right: 130,
          top: 10,
          bottom: 10,
          data: nodes,
          links,
          orient: 'horizontal',
          draggable: false,
          label: {
            show: true,
            position: 'right' as const,
            formatter: (params: { name: string; value: number }) =>
              `${params.name}\n${formatCurrency(params.value, currency)}`,
            fontSize: 10,
            color: isDark ? '#d1d5db' : '#374151',
          },
          emphasis: { focus: 'adjacency', lineStyle: { opacity: 0.6 } },
          lineStyle: { curveness: 0.5 },
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [snapshot, currency, isDark, currentUserId, demoMasked]);

  if (!option) return null;

  return (
    <ChartExplain chartLabel="Where the mortgage money goes" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <ReactEChartsCore
        key={demoMasked ? 'masked' : 'plain'}
        echarts={echarts}
        option={option}
        style={{ height: '320px', width: '100%' }}
        notMerge
        theme={isDark ? 'dark' : undefined}
        opts={{ renderer: 'canvas' }}
      />
    </ChartExplain>
  );
}
