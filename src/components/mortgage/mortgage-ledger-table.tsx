'use client';

import { useEffect, useMemo, useRef } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { InputSwitch } from 'primereact/inputswitch';
import { Tooltip } from 'primereact/tooltip';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { formatCurrency, formatYearMonthShort, formatRate } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import type { SharedMortgage, MortgageProjectionMonth, Currency } from '@/types';

interface LedgerRow {
  yearMonth: string;
  label: string;
  isActual: boolean;
  isHistorical: boolean;
  rate: number;
  totalRemaining: number;
  totalCharge: number;
  totalInterest: number;
  totalSubsidy: number;
  totalInsurance: number;
  fees: number;
  perLoan: Record<string, { remaining: number; charge: number; interest: number; insurance: number }>;
  deposits: Record<string, number>;
}

type Tone = 'debt' | 'cost' | 'in' | undefined;
const toneClass: Record<string, string> = {
  debt: 'text-red-500',
  cost: 'text-amber-600',
  in: 'text-blue-500',
};
// A vertical divider that starts a new column category.
const SEP = { borderLeft: '2px solid rgba(120,120,120,0.35)' } as const;

/** Column header with a teaching tooltip. */
function Hdr({ label, tip }: { label: string; tip: string }) {
  return (
    <span className="inline-flex items-center gap-1 justify-end w-full">
      {label}
      <i className="pi pi-info-circle text-xs opacity-40" data-pr-tooltip={tip} data-pr-position="top" />
    </span>
  );
}

export function MortgageLedgerTable({
  months,
  mortgage,
  currency,
  showBreakdown,
  onToggleBreakdown,
  isSimple,
  onReconcile,
  onRevert,
}: {
  months: MortgageProjectionMonth[];
  mortgage: SharedMortgage;
  currency: Currency;
  showBreakdown: boolean;
  onToggleBreakdown: (v: boolean) => void;
  isSimple: boolean;
  /** Mark an elapsed forecast month as actual (opens the reconcile dialog). */
  onReconcile?: (yearMonth: string) => void;
  /** Revert a recorded actual month back to a forecast. */
  onRevert?: (yearMonth: string) => void;
}) {
  const cur = (v: number) => formatCurrency(v, currency);
  const currentMonth = getCurrentYearMonth();

  // The next month still awaiting reconciliation (earliest elapsed forecast),
  // surfaced as a one-click action in the header.
  const monthToReconcile = months.find((m) => m.isHistorical && !m.isAllActual)?.yearMonth ?? null;

  const rows = useMemo<LedgerRow[]>(
    () =>
      months.map((m) => ({
        yearMonth: m.yearMonth,
        label: formatYearMonthShort(m.yearMonth),
        isActual: m.isAllActual,
        isHistorical: m.isHistorical,
        rate: m.loans[0]?.effectiveAnnualRate ?? 0,
        totalRemaining: m.totalRemaining,
        totalCharge: m.totalCharge,
        totalInterest: m.totalInterest,
        totalSubsidy: m.totalSubsidy,
        totalInsurance: m.totalInsurance,
        fees: m.invoicingFee + m.serviceFee,
        perLoan: Object.fromEntries(
          m.loans.map((l) => [l.loanId, { remaining: l.endingPrincipal, charge: l.monthlyCharge, interest: l.interestPaid, insurance: l.insurance }])
        ),
        deposits: Object.fromEntries(m.members.map((p) => [p.userId, p.monthlyDeposit])),
      })),
    [months]
  );

  // "Paid so far" — cumulative across recorded/elapsed months (≤ current month).
  const paidSoFar = useMemo(() => {
    const acc = { charge: 0, interest: 0, insurance: 0, fees: 0, deposits: {} as Record<string, number> };
    for (const m of months) {
      if (!m.isHistorical) continue;
      acc.charge += m.totalCharge;
      acc.interest += m.totalInterest;
      acc.insurance += m.totalInsurance;
      acc.fees += m.invoicingFee + m.serviceFee;
      for (const p of m.members) acc.deposits[p.userId] = (acc.deposits[p.userId] ?? 0) + p.monthlyDeposit;
    }
    return acc;
  }, [months]);

  // Show the ASP-subsidy column whenever the mortgage has a subsidy-eligible loan
  // (so the column is present even in months/years the rate sits below the
  // threshold and the subsidy is €0) or any recorded month actually has one.
  const hasSubsidy =
    mortgage.loans.some((l) => l.kind === 'asp' && l.aspSubsidy?.enabled) ||
    months.some((m) => m.totalSubsidy > 0.005);

  // Forecast rows dimmed, recorded actuals solid; current month bolded + tagged.
  const rowClass = (row: LedgerRow) =>
    `${row.isActual ? '' : 'opacity-70'} ${row.yearMonth === currentMonth ? 'ledger-current font-bold' : ''}`.trim();

  // Open the ledger centered on the current month (retried — the page re-renders
  // once its data loads, which resets the scroll position).
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const center = () => {
      const wrap = containerRef.current?.querySelector('.p-datatable-wrapper') as HTMLElement | null;
      const row = wrap?.querySelector('tr.ledger-current') as HTMLElement | null;
      if (!wrap || !row) return;
      const wrapRect = wrap.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      wrap.scrollTop += rowRect.top - wrapRect.top - wrap.clientHeight / 2 + rowRect.height / 2;
    };
    const timers = [200, 500, 900, 1400].map((d) => setTimeout(center, d));
    return () => timers.forEach(clearTimeout);
  }, [months.length, showBreakdown]);

  // ── Build the columns as a keyed array (stable keys avoid header/body
  // misalignment when the breakdown toggles). ──
  type LoanField = 'remaining' | 'charge' | 'interest' | 'insurance';
  const cols: React.ReactNode[] = [];

  const valueCol = (opts: {
    key: string;
    header: React.ReactNode;
    get: (r: LedgerRow) => number;
    tone?: Tone;
    footer?: number;
    bold?: boolean;
    sep?: boolean;
  }) => {
    const cls = `${opts.tone ? toneClass[opts.tone] : ''} ${opts.bold ? 'font-semibold' : ''}`.trim();
    cols.push(
      <Column
        key={opts.key}
        header={opts.header}
        align="right"
        body={(r: LedgerRow) => <span className={cls}>{cur(opts.get(r))}</span>}
        footer={opts.footer !== undefined ? <span className={opts.tone ? toneClass[opts.tone] : ''}>{cur(opts.footer)}</span> : undefined}
        style={{ minWidth: opts.bold ? '132px' : '112px' }}
        headerStyle={opts.sep ? SEP : undefined}
        bodyStyle={opts.sep ? SEP : undefined}
        footerStyle={opts.sep ? SEP : undefined}
      />
    );
  };

  // A category = optional per-loan columns (breakdown) + the total column.
  const group = (opts: {
    field: LoanField;
    total: (r: LedgerRow) => number;
    label: string;
    tip: string;
    tone?: Tone;
    footer?: number;
    perLoanSuffix?: string;
  }) => {
    if (showBreakdown) {
      mortgage.loans.forEach((l, i) =>
        valueCol({ key: `${opts.field}-${l.id}`, header: `${l.label}${opts.perLoanSuffix ?? ''}`, get: (r) => r.perLoan[l.id]?.[opts.field] ?? 0, tone: opts.tone, sep: i === 0 })
      );
      valueCol({ key: `${opts.field}-total`, header: <Hdr label={opts.label} tip={opts.tip} />, get: opts.total, tone: opts.tone, footer: opts.footer, bold: true });
    } else {
      valueCol({ key: `${opts.field}-total`, header: <Hdr label={opts.label} tip={opts.tip} />, get: opts.total, tone: opts.tone, footer: opts.footer, bold: true, sep: true });
    }
  };

  // Month (with actual/forecast tag) + "Paid so far" footer label.
  const canReconcile = !!onReconcile;
  cols.push(
    <Column
      key="month"
      header="Month"
      frozen
      alignFrozen="left"
      body={(r: LedgerRow) => (
        <span className="whitespace-nowrap inline-flex items-center gap-1">
          {r.label}
          <Tag value={r.isActual ? 'actual' : 'forecast'} severity={r.isActual ? 'success' : 'info'} className="ml-1 text-xs" />
          {/* Elapsed-but-unreconciled → offer to mark it actual. */}
          {canReconcile && r.isHistorical && !r.isActual && (
            <Button
              icon="pi pi-check"
              rounded
              text
              size="small"
              severity="success"
              className="!w-7 !h-7"
              tooltip="Mark this month as actual"
              tooltipOptions={{ position: 'top' }}
              onClick={() => onReconcile?.(r.yearMonth)}
            />
          )}
          {/* Recorded actual → allow reverting to a forecast. */}
          {onRevert && r.isActual && (
            <Button
              icon="pi pi-undo"
              rounded
              text
              size="small"
              severity="secondary"
              className="!w-7 !h-7 opacity-50 hover:opacity-100"
              tooltip="Revert to forecast"
              tooltipOptions={{ position: 'top' }}
              onClick={() => onRevert(r.yearMonth)}
            />
          )}
        </span>
      )}
      footer={<span className="font-semibold whitespace-nowrap">Paid so far ▸</span>}
      style={{ minWidth: '190px' }}
    />
  );
  cols.push(
    <Column key="rate" header={<Hdr label="Rate" tip="Yearly interest rate = Euribor + the bank's fixed margin." />} align="right" body={(r: LedgerRow) => formatRate(r.rate)} style={{ minWidth: '90px' }} headerStyle={SEP} bodyStyle={SEP} footerStyle={SEP} />
  );

  group({ field: 'remaining', total: (r) => r.totalRemaining, label: 'Total remaining', tip: "What's still owed (the sum of the loan columns).", tone: 'debt' });
  group({ field: 'charge', total: (r) => r.totalCharge, label: 'Repayment', tip: "The bank's total charge this month for the loan (principal + interest + insurance + fee share).", perLoanSuffix: ' pay', footer: paidSoFar.charge });
  group({ field: 'interest', total: (r) => r.totalInterest, label: 'Interest', tip: 'The cost of borrowing this month (after any ASP subsidy). A cost, not principal.', tone: 'cost', perLoanSuffix: ' int.', footer: paidSoFar.interest });

  if (hasSubsidy) {
    valueCol({ key: 'subsidy', header: <Hdr label="ASP subsidy" tip="Interest the government covers on the ASP loan when the rate is above the threshold (money in)." />, get: (r) => r.totalSubsidy, tone: 'in', sep: true });
  }

  if (!isSimple) {
    group({ field: 'insurance', total: (r) => r.totalInsurance, label: 'Insurance', tip: 'Loan protection insurance — a separate cost, not part of paying down the loan.', tone: 'cost', perLoanSuffix: ' ins.', footer: paidSoFar.insurance });
    valueCol({ key: 'fees', header: <Hdr label="Fees" tip="Invoicing fee + bank service fee this month (a cost)." />, get: (r) => r.fees, tone: 'cost', footer: paidSoFar.fees, sep: true });
  }

  // Per-person transfers (what each member pays into the loan account).
  mortgage.members.forEach((m, i) =>
    valueCol({
      key: `deposit-${m.userId}`,
      header: <Hdr label={`${m.name} transfers`} tip={`What ${m.name} pays into the loan account this month: their share of the charge + the per-person service fee.`} />,
      get: (r) => r.deposits[m.userId] ?? 0,
      tone: 'in',
      footer: paidSoFar.deposits[m.userId] ?? 0,
      bold: true,
      sep: i === 0,
    })
  );

  return (
    <div ref={containerRef}>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between mb-3 gap-3 sm:gap-4">
        <div>
          <h2 className="text-lg font-semibold">Payment schedule</h2>
          <p className="text-sm opacity-60">
            Every month from the start of the loan, scroll freely. <b className="text-green-600">Actual</b> rows are your confirmed
            bank figures; <b>forecast</b> rows (dimmed) are projected. Opens centered on the current month. Use the{' '}
            <i className="pi pi-check text-green-600 text-xs" /> on an elapsed month to mark it as actual.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:shrink-0">
          {canReconcile && monthToReconcile && (
            <Button
              label={`Reconcile ${formatYearMonthShort(monthToReconcile)}`}
              icon="pi pi-check"
              size="small"
              severity="success"
              onClick={() => onReconcile?.(monthToReconcile)}
            />
          )}
          {!isSimple && (
            <div className="flex items-center gap-2">
              <span className="text-sm opacity-70">Loan-by-loan breakdown</span>
              <InputSwitch checked={showBreakdown} onChange={(e) => onToggleBreakdown(e.value)} />
            </div>
          )}
        </div>
      </div>

      <Tooltip target="[data-pr-tooltip]" />

      {/* key forces a clean remount when the column set changes — PrimeReact's
          scrollable table renders header/body as separate tables and otherwise
          fails to re-sync them when columns are added/removed dynamically. */}
      {/* `mortgage-ledger` scopes the mobile-density override in globals.css
          (smaller font + tighter cell padding + a narrower frozen Month column
          below lg) — desktop is untouched. */}
      <DataTable
        className="mortgage-ledger"
        key={`ledger-${showBreakdown ? 'bd' : 'flat'}-${isSimple ? 's' : 'a'}-${hasSubsidy ? 'sub' : ''}-${mortgage.loans.length}-${mortgage.members.length}`}
        value={rows}
        scrollable
        scrollHeight="560px"
        size="small"
        stripedRows
        rowClassName={rowClass}
        dataKey="yearMonth"
      >
        {cols}
      </DataTable>

      <p className="text-xs opacity-60 mt-2">
        <span className="text-red-500 font-medium">Red</span> = balance still owed ·
        <span className="text-amber-600 font-medium"> amber</span> = costs that don&apos;t reduce the loan (interest, insurance, fees) ·
        <span className="text-blue-500 font-medium"> blue</span> = money paid in (transfers, subsidy).
        The bold <b>Paid so far ▸</b> row totals everything paid up to the current month.
        {showBreakdown && ' Each "Total" column equals the sum of the two loan columns to its left.'}
      </p>
    </div>
  );
}
