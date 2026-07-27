'use client';

import { useMemo } from 'react';
import { Chart } from 'primereact/chart';
import { formatCurrency, formatYearMonthShort } from '@/lib/constants';
import { useAppContext } from '@/components/layout/app-layout';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeBudgetMonths } from '@/lib/chart-descriptions';
import type { Currency } from '@/types';
import type { BudgetMonthRow } from '@/lib/budget-utils';

const RED = 'rgb(239, 68, 68)';
const GREEN = 'rgb(34, 197, 94)';
const BLUE = 'rgb(59, 130, 246)';

/** Month-by-month costs vs money in, with the running net as a line. */
export function BudgetMonthChart({ perMonth, currency }: { perMonth: BudgetMonthRow[]; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(
    () => describeBudgetMonths(perMonth, (n) => formatCurrency(n, currency)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    [perMonth, currency, demoMasked],
  );
  const howToRead: ReadCue[] = [
    { shape: 'square', color: RED, text: 'Red bars are what you plan to spend that month.' },
    { shape: 'square', color: GREEN, text: 'Green bars are money coming in that month.' },
    { shape: 'line', color: BLUE, text: 'The blue line is the running total left over as the plan goes on.' },
  ];

  if (perMonth.length === 0) return null;

  const data = {
    labels: perMonth.map(m => formatYearMonthShort(m.yearMonth)),
    datasets: [
      { type: 'bar' as const, label: 'Costs', data: perMonth.map(m => m.plannedCosts), backgroundColor: RED },
      { type: 'bar' as const, label: 'Money in', data: perMonth.map(m => m.fundingReceived), backgroundColor: GREEN },
      {
        type: 'line' as const,
        label: 'Running total',
        data: perMonth.map(m => m.cumulativeNet),
        borderColor: BLUE,
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 3,
        borderWidth: 2,
      },
    ],
  };

  const options = {
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'top' as const },
      tooltip: {
        callbacks: {
          label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false } },
      y: {
        grid: { color: 'rgba(128,128,128,0.12)' },
        ticks: { callback: (v: number | string) => (typeof v === 'number' ? formatCurrency(v, currency) : v) },
      },
    },
  };

  return (
    <ChartExplain
      chartLabel="Budget month by month"
      howToRead={howToRead}
      description={description}
      plainWordsLabel="In plain words"
    >
      <div style={{ height: '260px' }}>
        <Chart type="bar" data={data} options={options} style={{ height: '100%' }} />
      </div>
    </ChartExplain>
  );
}
