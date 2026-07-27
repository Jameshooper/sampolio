'use client';

/**
 * Mortgage visualizations (Chart.js via PrimeReact). Each chart takes an already
 * time-windowed slice of the projection and renders with plain-language titles
 * and tooltips. Colors follow the app convention: liability red, equity/asset
 * green, "you" blue, partner purple, neutral gray.
 */

import { useMemo } from 'react';
import { Chart } from 'primereact/chart';
import { formatCurrency, formatYearMonthShort, formatRate } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import { useAppContext } from '@/components/layout/app-layout';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import {
  describeMortgageBalance,
  describeOwnershipProgress,
  describePrincipalInterest,
  describeCumulativeCost,
  describeRateHistory,
  describePaymentBreakdown,
  describeEquityBuildup,
  describeTransferComparison,
} from '@/lib/chart-descriptions';
import type { SharedMortgage, MortgageProjectionMonth, Currency } from '@/types';

const RED = 'rgb(239, 68, 68)';
const GREEN = 'rgb(34, 197, 94)';
const BLUE = 'rgb(59, 130, 246)';
const PURPLE = 'rgb(168, 85, 247)';
const AMBER = 'rgb(245, 158, 11)';
const GRAY = 'rgb(148, 163, 184)';
const MEMBER_COLORS = [BLUE, PURPLE, AMBER, GREEN];

function EmptyState({ label }: { label: string }) {
  return <div className="flex items-center justify-center h-64 text-gray-500 text-sm">{label}</div>;
}

/** Index of the current month within a month slice (−1 if not in range). */
function todayIndexOf(months: MortgageProjectionMonth[]): number {
  const cur = getCurrentYearMonth();
  const exact = months.findIndex((m) => m.yearMonth === cur);
  if (exact >= 0) return exact;
  // Fall back to the last elapsed month (e.g. when the slice starts after today).
  let last = -1;
  for (let i = 0; i < months.length; i++) if (months[i].isHistorical) last = i;
  return last;
}

/**
 * A Chart.js inline plugin that draws a dashed vertical "Today" line on a
 * category x-axis at the given index. No-op when index < 0.
 */
function todayLinePlugin(index: number) {
  return {
    id: 'todayLine',
    afterDatasetsDraw(chart: {
      ctx: CanvasRenderingContext2D;
      chartArea: { top: number; bottom: number };
      scales: { x?: { getPixelForValue: (v: number) => number } };
    }) {
      if (index < 0) return;
      const x = chart.scales.x;
      if (!x) return;
      const px = x.getPixelForValue(index);
      if (px == null || Number.isNaN(px)) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(120,120,120,0.8)';
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
      // "Today" pill near the top of the line.
      ctx.setLineDash([]);
      ctx.font = '600 10px sans-serif';
      const label = 'Today';
      const tw = ctx.measureText(label).width;
      const boxW = tw + 8;
      ctx.fillStyle = 'rgba(120,120,120,0.9)';
      ctx.beginPath();
      ctx.roundRect(px - boxW / 2, chartArea.top + 2, boxW, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, chartArea.top + 9);
      ctx.restore();
    },
  };
}

const baseOptions = (currency: Currency) => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' as const, intersect: false },
  scales: {
    x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 45, maxTicksLimit: 12 } },
    y: {
      grid: { color: 'rgba(128,128,128,0.12)' },
      ticks: {
        callback: (v: number | string) => (typeof v === 'number' ? formatCurrency(v, currency) : v),
      },
    },
  },
});

// ── (a) Balance over time: the two loans melting to zero ───────────────────
export function MortgageBalanceChart({ months, mortgage, currency }: { months: MortgageProjectionMonth[]; mortgage: SharedMortgage; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const ti = todayIndexOf(months);
    const owedAt = (i: number) => months[i].loans.reduce((s, l) => s + l.endingPrincipal, 0);
    return describeMortgageBalance(
      owedAt(ti >= 0 ? ti : 0),
      owedAt(months.length - 1),
      months[months.length - 1].yearMonth,
      (n) => formatCurrency(n, currency),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [months, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'band', color: RED, text: "The shaded area is what you still owe; it melts toward zero." },
    { shape: 'line', color: GRAY, dashed: true, text: "The dashed 'Today' line splits the real past from the forecast." },
  ];
  if (months.length === 0) return <EmptyState label="No schedule to show yet." />;
  const labels = months.map((m) => formatYearMonthShort(m.yearMonth));
  const colors = [RED, AMBER, PURPLE];
  const data = {
    labels,
    datasets: mortgage.loans.map((loan, i) => ({
      label: loan.label,
      data: months.map((m) => m.loans.find((l) => l.loanId === loan.id)?.endingPrincipal ?? 0),
      borderColor: colors[i % colors.length],
      backgroundColor: colors[i % colors.length].replace('rgb', 'rgba').replace(')', ', 0.25)'),
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    })),
  };
  const options = {
    ...baseOptions(currency),
    plugins: {
      legend: { display: true, position: 'top' as const },
      tooltip: {
        callbacks: {
          label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}`,
        },
      },
    },
    scales: { ...baseOptions(currency).scales, y: { ...baseOptions(currency).scales.y, stacked: true }, x: { ...baseOptions(currency).scales.x, stacked: true } },
  };
  return (
    <ChartExplain chartLabel="What you still owe, over time" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '320px' }}><Chart type="line" data={data} options={options} plugins={[todayLinePlugin(todayIndexOf(months))]} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (b) Ownership progress to the target split ─────────────────────────────
export function OwnershipProgressChart({ months, mortgage, currency }: { months: MortgageProjectionMonth[]; mortgage: SharedMortgage; currency: Currency }) {
  void currency;
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const ti = todayIndexOf(months);
    const at = months[ti >= 0 ? ti : 0];
    return describeOwnershipProgress(
      mortgage.members.map((mem) => ({
        name: mem.name,
        currentPercent: (at.members.find((p) => p.userId === mem.userId)?.ownershipPercent ?? 0) * 100,
        targetPercent: mem.ownershipTargetPercent * 100,
      })),
    );
  }, [months, mortgage]);
  const howToRead: ReadCue[] = [
    { shape: 'line', color: BLUE, text: "Each solid line is one person's share of the home, climbing over time." },
    { shape: 'line', color: GRAY, dashed: true, text: 'The dashed line is the target share each person is heading toward.' },
  ];
  if (months.length === 0) return <EmptyState label="No ownership data yet." />;
  const labels = months.map((m) => formatYearMonthShort(m.yearMonth));
  const distinctTargets = [...new Set(mortgage.members.map((m) => Math.round(m.ownershipTargetPercent * 1000) / 10))];
  const data = {
    labels,
    datasets: [
      ...mortgage.members.map((mem, i) => ({
        label: mem.name,
        data: months.map((m) => (m.members.find((p) => p.userId === mem.userId)?.ownershipPercent ?? 0) * 100),
        borderColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2.5,
      })),
      ...distinctTargets.map((target) => ({
        label: `${target}% target`,
        data: months.map(() => target),
        borderColor: GRAY,
        borderDash: [6, 6],
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
      })),
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: true, position: 'top' as const },
      tooltip: { callbacks: { label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${c.raw.toFixed(1)}%` } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 45, maxTicksLimit: 12 } },
      y: { grid: { color: 'rgba(128,128,128,0.12)' }, ticks: { callback: (v: number | string) => `${v}%` } },
    },
  };
  return (
    <ChartExplain chartLabel="Path to owning the home" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '320px' }}><Chart type="line" data={data} options={options} plugins={[todayLinePlugin(todayIndexOf(months))]} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (c) Where each payment goes: principal vs interest (yearly buckets) ────
export function PrincipalInterestChart({ months, currency }: { months: MortgageProjectionMonth[]; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const principal = months.reduce((s, m) => s + m.loans.reduce((a, l) => a + l.principalPaid + l.extraPayment, 0), 0);
    const interest = months.reduce((s, m) => s + m.totalInterest, 0);
    return describePrincipalInterest(principal, interest, (n) => formatCurrency(n, currency));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [months, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'square', color: GREEN, text: "Green is the part of each year's payments that shrinks the loan." },
    { shape: 'square', color: RED, text: 'Red is interest — the bank\'s fee for lending you the money.' },
  ];
  if (months.length === 0) return <EmptyState label="No payments to show yet." />;
  const byYear = new Map<number, { principal: number; interest: number }>();
  for (const m of months) {
    const acc = byYear.get(m.year) ?? { principal: 0, interest: 0 };
    // principalPaidTotal is cumulative; use per-month principal via cumulative delta is complex,
    // so derive from per-loan principalPaid summed.
    const principal = m.loans.reduce((s, l) => s + l.principalPaid + l.extraPayment, 0);
    acc.principal += principal;
    acc.interest += m.totalInterest;
    byYear.set(m.year, acc);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const data = {
    labels: years.map(String),
    datasets: [
      { label: 'Principal (builds equity)', data: years.map((y) => byYear.get(y)!.principal), backgroundColor: GREEN, stack: 's' },
      { label: 'Interest (cost of borrowing)', data: years.map((y) => byYear.get(y)!.interest), backgroundColor: RED, stack: 's' },
    ],
  };
  const options = {
    ...baseOptions(currency),
    plugins: {
      legend: { display: true, position: 'top' as const },
      tooltip: { callbacks: { label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}` } },
    },
    scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, grid: { color: 'rgba(128,128,128,0.12)' }, ticks: { callback: (v: number | string) => (typeof v === 'number' ? formatCurrency(v, currency) : v) } } },
  };
  return (
    <ChartExplain chartLabel="Where each payment goes" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '320px' }}><Chart type="bar" data={data} options={options} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (d) Cumulative cost: interest vs principal paid to date ────────────────
export function CumulativeCostChart({ months, currency }: { months: MortgageProjectionMonth[]; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const ti = todayIndexOf(months);
    const at = months[ti >= 0 ? ti : months.length - 1];
    return describeCumulativeCost(at.cumPrincipalPaid, at.cumInterestPaid, (n) => formatCurrency(n, currency));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [months, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'line', color: GREEN, text: "The green line adds up what you've paid off the loan so far." },
    { shape: 'line', color: RED, text: "The red line adds up the interest you've paid so far." },
  ];
  if (months.length === 0) return <EmptyState label="Nothing paid yet." />;
  const labels = months.map((m) => formatYearMonthShort(m.yearMonth));
  const data = {
    labels,
    datasets: [
      { label: 'Principal paid', data: months.map((m) => m.cumPrincipalPaid), borderColor: GREEN, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Interest paid', data: months.map((m) => m.cumInterestPaid), borderColor: RED, backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2 },
    ],
  };
  const options = {
    ...baseOptions(currency),
    plugins: { legend: { display: true, position: 'top' as const }, tooltip: { callbacks: { label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}` } } },
  };
  return (
    <ChartExplain chartLabel="What the loan has cost you so far" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '320px' }}><Chart type="line" data={data} options={options} plugins={[todayLinePlugin(todayIndexOf(months))]} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (e) Interest-rate history (stepped) ────────────────────────────────────
export function RateHistoryChart({ months, mortgage }: { months: MortgageProjectionMonth[]; mortgage: SharedMortgage }) {
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const loanId = mortgage.loans[0]?.id;
    const rates = months.map((m) => m.loans.find((l) => l.loanId === loanId)?.effectiveAnnualRate ?? 0);
    const positive = rates.filter((r) => r > 0);
    if (positive.length === 0) return [];
    const ti = todayIndexOf(months);
    const cur = ti >= 0 && rates[ti] > 0 ? rates[ti] : positive[positive.length - 1];
    return describeRateHistory(cur, Math.min(...positive), Math.max(...positive));
  }, [months, mortgage]);
  const howToRead: ReadCue[] = [
    { shape: 'line', color: BLUE, text: 'The line is your interest rate; it steps whenever the rate changes.' },
    { shape: 'line', color: GRAY, dashed: true, text: "The dashed 'Today' line splits the past from what's expected next." },
  ];
  if (months.length === 0) return <EmptyState label="No rate history yet." />;
  const firstLoanId = mortgage.loans[0]?.id;
  const labels = months.map((m) => formatYearMonthShort(m.yearMonth));
  const data = {
    labels,
    datasets: [
      {
        label: 'Interest rate',
        data: months.map((m) => m.loans.find((l) => l.loanId === firstLoanId)?.effectiveAnnualRate ?? 0),
        borderColor: BLUE,
        backgroundColor: 'rgba(59,130,246,0.15)',
        stepped: true,
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
      },
    ],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c: { raw: number }) => formatRate(c.raw) } } },
    scales: {
      x: { grid: { display: false }, ticks: { maxRotation: 45, minRotation: 45, maxTicksLimit: 12 } },
      y: { grid: { color: 'rgba(128,128,128,0.12)' }, ticks: { callback: (v: number | string) => `${v}%` } },
    },
  };
  return (
    <ChartExplain chartLabel="How your rate has changed" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '300px' }}><Chart type="line" data={data} options={options} plugins={[todayLinePlugin(todayIndexOf(months))]} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (f) This month's payment, broken down ──────────────────────────────────
export function PaymentBreakdownChart({ month, currency }: { month: MortgageProjectionMonth | undefined; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (!month) return [];
    const principalPaid = month.loans.reduce((s, l) => s + l.principalPaid + l.extraPayment, 0);
    return describePaymentBreakdown(
      [
        { label: 'Principal', value: principalPaid },
        { label: 'Interest', value: month.totalInterest },
        { label: 'Insurance', value: month.totalInsurance },
        { label: 'Fees', value: month.invoicingFee + month.serviceFee },
      ],
      (n) => formatCurrency(n, currency),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [month, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'dot', color: GREEN, text: "Each slice is a part of this month's payment." },
    { shape: 'dot', color: RED, text: 'Interest is the bank\'s fee; principal shrinks the loan.' },
  ];
  if (!month) return <EmptyState label="No payment this month." />;
  const principal = month.loans.reduce((s, l) => s + l.principalPaid + l.extraPayment, 0);
  const segments = [
    { label: 'Principal', value: principal, color: GREEN },
    { label: 'Interest', value: month.totalInterest, color: RED },
    { label: 'Insurance', value: month.totalInsurance, color: AMBER },
    { label: 'Fees', value: month.invoicingFee + month.serviceFee, color: GRAY },
  ].filter((s) => s.value > 0.005);
  const data = {
    labels: segments.map((s) => s.label),
    datasets: [{ data: segments.map((s) => s.value), backgroundColor: segments.map((s) => s.color), borderWidth: 0 }],
  };
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '60%',
    plugins: {
      legend: { display: true, position: 'bottom' as const },
      tooltip: { callbacks: { label: (c: { label: string; raw: number }) => `${c.label}: ${formatCurrency(c.raw, currency)}` } },
    },
  };
  return (
    <ChartExplain chartLabel="This month's payment, broken down" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '300px' }}><Chart type="doughnut" data={data} options={options} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (g) Equity build-up per member ─────────────────────────────────────────
export function EquityBuildupChart({ months, mortgage, currency }: { months: MortgageProjectionMonth[]; mortgage: SharedMortgage; currency: Currency }) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (months.length === 0) return [];
    const ti = todayIndexOf(months);
    const at = months[ti >= 0 ? ti : months.length - 1];
    return describeEquityBuildup(
      mortgage.members.map((mem) => ({
        name: mem.name,
        equity: at.members.find((p) => p.userId === mem.userId)?.equity ?? 0,
      })),
      (n) => formatCurrency(n, currency),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [months, mortgage, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'band', color: BLUE, text: "Each shaded area is one person's equity — their share of the home's value." },
    { shape: 'line', color: GRAY, dashed: true, text: "The dashed 'Today' line splits the real past from the forecast." },
  ];
  if (months.length === 0) return <EmptyState label="No equity data yet." />;
  const labels = months.map((m) => formatYearMonthShort(m.yearMonth));
  const data = {
    labels,
    datasets: mortgage.members.map((mem, i) => ({
      label: mem.name,
      data: months.map((m) => m.members.find((p) => p.userId === mem.userId)?.equity ?? 0),
      borderColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
      backgroundColor: MEMBER_COLORS[i % MEMBER_COLORS.length].replace('rgb', 'rgba').replace(')', ', 0.25)'),
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    })),
  };
  const options = {
    ...baseOptions(currency),
    plugins: { legend: { display: true, position: 'top' as const }, tooltip: { callbacks: { label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}` } } },
    scales: { ...baseOptions(currency).scales, y: { ...baseOptions(currency).scales.y, stacked: true }, x: { ...baseOptions(currency).scales.x, stacked: true } },
  };
  return (
    <ChartExplain chartLabel="Your home equity, growing" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div style={{ height: '320px' }}><Chart type="line" data={data} options={options} plugins={[todayLinePlugin(todayIndexOf(months))]} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}

// ── (h) Transfer comparison: cumulative cost of borrowing, current vs offer ──
/** Dashed vertical marker at a category index (e.g. the break-even month). */
function markerLinePlugin(index: number, label: string) {
  return {
    id: 'breakEvenLine',
    afterDatasetsDraw(chart: {
      ctx: CanvasRenderingContext2D;
      chartArea: { top: number; bottom: number };
      scales: { x?: { getPixelForValue: (v: number) => number } };
    }) {
      if (index < 0) return;
      const x = chart.scales.x;
      if (!x) return;
      const px = x.getPixelForValue(index);
      if (px == null || Number.isNaN(px)) return;
      const { ctx, chartArea } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(34,197,94,0.9)';
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '600 10px sans-serif';
      const tw = ctx.measureText(label).width;
      const boxW = tw + 8;
      ctx.fillStyle = 'rgba(34,197,94,0.95)';
      ctx.beginPath();
      ctx.roundRect(px - boxW / 2, chartArea.top + 2, boxW, 14, 3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, chartArea.top + 9);
      ctx.restore();
    },
  };
}

export function TransferComparisonChart({
  series,
  currency,
  breakEvenMonths,
}: {
  series: { label: string; current: number; offer: number }[];
  currency: Currency;
  breakEvenMonths: number | null;
}) {
  const { demoMasked } = useAppContext() ?? {};
  const description = useMemo(() => {
    if (series.length === 0) return [];
    const last = series[series.length - 1];
    return describeTransferComparison(last.current, last.offer, breakEvenMonths, (n) => formatCurrency(n, currency));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
  }, [series, breakEvenMonths, currency, demoMasked]);
  const howToRead: ReadCue[] = [
    { shape: 'line', color: RED, text: "The red line is your current loan's cost, adding up over time." },
    { shape: 'line', color: GREEN, text: "The green line is the offer's cost, including switch-over fees." },
    { shape: 'line', color: GREEN, dashed: true, text: 'The dashed marker is when the offer pays for itself.' },
  ];
  if (series.length === 0) return <EmptyState label="Enter an offer to compare." />;
  const data = {
    labels: series.map((p) => formatYearMonthShort(p.label)),
    datasets: [
      { label: 'Current mortgage', data: series.map((p) => p.current), borderColor: RED, backgroundColor: 'transparent', tension: 0.2, pointRadius: 0, borderWidth: 2 },
      { label: 'This offer (incl. one-off costs)', data: series.map((p) => p.offer), borderColor: GREEN, backgroundColor: 'transparent', tension: 0.2, pointRadius: 0, borderWidth: 2 },
    ],
  };
  const options = {
    ...baseOptions(currency),
    plugins: {
      legend: { display: true, position: 'top' as const },
      tooltip: { callbacks: { label: (c: { dataset: { label?: string }; raw: number }) => `${c.dataset.label}: ${formatCurrency(c.raw, currency)}` } },
    },
  };
  const plugins = breakEvenMonths != null ? [markerLinePlugin(breakEvenMonths, 'Break-even')] : [];
  return (
    <ChartExplain chartLabel="Cumulative cost over time, current vs offer" howToRead={howToRead} description={description} plainWordsLabel="In plain words">
      <div className="h-72 lg:h-96"><Chart type="line" data={data} options={options} plugins={plugins} style={{ height: '100%' }} /></div>
    </ChartExplain>
  );
}
