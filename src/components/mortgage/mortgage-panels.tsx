'use client';

import { useMemo, useState } from 'react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { ProgressBar } from 'primereact/progressbar';
import { Slider } from 'primereact/slider';
import { Tooltip } from 'primereact/tooltip';
import { MdHouse, MdPercent, MdEvent, MdCheckCircle, MdPayments } from 'react-icons/md';
import { formatCurrency, formatYearMonth, formatRate } from '@/lib/constants';
import { MortgageOwnershipSankey } from '@/components/mortgage/mortgage-sankey';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import type { SharedMortgage, MortgageProjectionMonth, MortgageLoan, Currency } from '@/types';

/** A hover-info icon that teaches without crowding the layout. */
function InfoIcon({ tip }: { tip: string }) {
  return <i className="pi pi-info-circle text-xs opacity-40 ml-1" data-pr-tooltip={tip} data-pr-position="top" />;
}

function findCurrentRow(months: MortgageProjectionMonth[], currentMonth: string): MortgageProjectionMonth | undefined {
  return months.find((m) => m.yearMonth === currentMonth) ?? [...months].reverse().find((m) => m.isHistorical) ?? months[months.length - 1];
}

// ── Hero summary ───────────────────────────────────────────────────────────
function HeroStat({ icon, label, value, sub, valueClass }: { icon: React.ReactNode; label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-60">
        {icon}
        <span>{label}</span>
      </div>
      <span className={`text-xl font-bold mt-0.5 ${valueClass ?? ''}`}>{value}</span>
      {sub && <span className="text-xs opacity-50 mt-0.5">{sub}</span>}
    </div>
  );
}

export function MortgageHeroCard({
  months,
  mortgage,
  currency,
  currentMonth,
  nextResetDate,
  payoffMonth,
}: {
  months: MortgageProjectionMonth[];
  mortgage: SharedMortgage;
  currency: Currency;
  currentMonth: string;
  nextResetDate: Date;
  payoffMonth: string | null;
}) {
  const row = findCurrentRow(months, currentMonth);
  const firstLoan = mortgage.loans[0];
  const rate = row?.loans[0]?.effectiveAnnualRate ?? 0;
  const euribor = rate - (firstLoan?.margin ?? 0);
  // The full amount transferred to the loan account this month = sum of each member's deposit.
  const monthlyPayment = (row?.members ?? []).reduce((s, m) => s + m.monthlyDeposit, 0);
  const resetLabel = nextResetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <Card>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <HeroStat icon={<MdHouse />} label="Still to pay" value={formatCurrency(row?.totalRemaining ?? 0, currency)} sub="across all loans" valueClass="text-red-500" />
        <HeroStat icon={<MdPayments />} label="Monthly payment" value={formatCurrency(monthlyPayment, currency)} sub="total you both pay" />
        <HeroStat icon={<MdPercent />} label="Current rate" value={formatRate(rate)} sub={`Euribor ${formatRate(euribor)} + ${formatRate(firstLoan?.margin ?? 0)}`.replace(/ %/g, '%')} />
        <HeroStat icon={<MdEvent />} label="Rate updates next" value={resetLabel} sub="you'll enter the new Euribor then" />
        <HeroStat icon={<MdCheckCircle />} label="Loan fully paid" value={payoffMonth ? formatYearMonth(payoffMonth) : '—'} sub="if rate & payments hold" valueClass="text-green-500" />
      </div>
    </Card>
  );
}

// ── Simple-mode personal summary ─────────────────────────────────────────────
/** One card answering the three questions a non-finance member has: what do I
 *  pay each month, how much of the home is mine, and what have I built up so
 *  far. Rendered only in Simple display mode, above the hero card. */
export function MyMortgageSummaryCard({
  months,
  mortgage,
  currency,
  currentMonth,
  currentUserId,
}: {
  months: MortgageProjectionMonth[];
  mortgage: SharedMortgage;
  currency: Currency;
  currentMonth: string;
  currentUserId?: string;
}) {
  const row = findCurrentRow(months, currentMonth);
  const pos = row?.members.find((p) => p.userId === currentUserId);
  const member = mortgage.members.find((m) => m.userId === currentUserId);
  if (!row || !pos || !member) return null;

  const ownershipPct = pos.ownershipPercent * 100;
  const targetPct = member.ownershipTargetPercent * 100;

  return (
    <Card className="border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/10">
      <h2 className="text-lg font-semibold mb-1">You and this mortgage</h2>
      <p className="text-sm opacity-70 mb-4">
        Every month you pay {formatCurrency(pos.monthlyDeposit, currency)}, and a bit more of the home becomes yours.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <HeroStat icon={<MdPayments />} label="You pay per month" value={formatCurrency(pos.monthlyDeposit, currency)} sub="your share of the bill" />
        <HeroStat icon={<MdHouse />} label="Of the home, you own" value={`${ownershipPct.toFixed(1)}%`} sub={`aiming for ${Math.round(targetPct)}%`} />
        <HeroStat icon={<MdCheckCircle />} label="You've built up" value={formatCurrency(pos.equity, currency)} sub="down payment + payments so far" valueClass="text-green-500" />
      </div>
    </Card>
  );
}

// ── Ownership balancing panel (the centerpiece) ──────────────────────────────
export function OwnershipBalancePanel({
  months,
  mortgage,
  currency,
  currentUserId,
  currentMonth,
  isSimple,
}: {
  months: MortgageProjectionMonth[];
  mortgage: SharedMortgage;
  currency: Currency;
  currentUserId?: string;
  currentMonth: string;
  isSimple: boolean;
}) {
  // The current month is the scrubber's "now" / default position.
  const baseIdx = useMemo(() => {
    const i = months.findIndex((m) => m.yearMonth === currentMonth);
    if (i >= 0) return i;
    let last = 0;
    for (let k = 0; k < months.length; k++) if (months[k].isHistorical) last = k;
    return last;
  }, [months, currentMonth]);
  // Scrub up to payoff (first month the loan is cleared), else the last month.
  const payoffIdx = useMemo(() => {
    const i = months.findIndex((m) => m.totalRemaining <= 0.005);
    return i >= 0 ? i : months.length - 1;
  }, [months]);

  const [idx, setIdx] = useState(baseIdx);
  const profiles = useUserProfiles(mortgage.members.map((m) => m.userId));

  if (months.length === 0) return null;
  const splitLabel = mortgage.members.map((m) => Math.round(m.ownershipTargetPercent * 100)).join('/');

  const canScrub = payoffIdx > baseIdx;
  const safeIdx = Math.min(Math.max(idx, baseIdx), Math.max(baseIdx, payoffIdx));
  const row = months[safeIdx];
  if (!row) return null;
  const isNow = safeIdx === baseIdx;
  const monthsAhead = safeIdx - baseIdx;
  const aheadLabel =
    monthsAhead >= 12
      ? `${Math.floor(monthsAhead / 12)}y ${monthsAhead % 12}m`
      : `${monthsAhead}m`;

  return (
    <Card>
      <Tooltip target="[data-pr-tooltip]" />
      <h2 className="text-lg font-semibold mb-1">Who owns how much</h2>
      <p className="text-sm opacity-70 mb-4">
        You both own this home together. Because someone paid more up front, they own more right now — but every
        payment moves you both toward your agreed {splitLabel} split.
        {canScrub && ' Drag the slider to see how your shares converge over time.'}
      </p>

      {/* Time scrubber: from now to payoff. Drives the bars + figures below. */}
      {canScrub && (
        <div className="mb-5 p-3 rounded-lg surface-ground">
          <div className="flex items-center justify-between mb-2 text-sm">
            <span className="opacity-70">Your position at</span>
            <span className="flex items-center gap-2">
              <span className="font-semibold">{isNow ? 'Today' : formatYearMonth(row.yearMonth)}</span>
              {!isNow && <span className="text-xs opacity-50">in {aheadLabel}</span>}
              {!isNow && (
                <button
                  type="button"
                  onClick={() => setIdx(baseIdx)}
                  className="text-xs text-accent-500 hover:underline"
                >
                  reset
                </button>
              )}
            </span>
          </div>
          <Slider
            value={safeIdx}
            min={baseIdx}
            max={payoffIdx}
            onChange={(e) => setIdx(Array.isArray(e.value) ? e.value[0] : e.value)}
          />
          <div className="flex items-center justify-between mt-1 text-xs opacity-50">
            <span>Today</span>
            <span>Paid off · {formatYearMonth(months[payoffIdx].yearMonth)}</span>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {mortgage.members.map((member) => {
          const pos = row.members.find((p) => p.userId === member.userId);
          if (!pos) return null;
          const isYou = member.userId === currentUserId;
          const ownershipPct = pos.ownershipPercent * 100;
          const memberTargetPct = member.ownershipTargetPercent * 100;
          const progressToTarget = memberTargetPct > 0 ? Math.min(100, (ownershipPct / memberTargetPct) * 100) : 0;
          // Equity = the up-front down payment + this member's share of principal paid off since.
          const downPayment = member.initialPayment;
          const paidOffSince = Math.max(0, pos.equity - downPayment);
          return (
            <div key={member.userId} className={`p-3 rounded-lg ${isYou ? 'ring-1 ring-accent-400/40' : ''} surface-ground`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <UserAvatar userId={member.userId} name={member.name} avatarUrl={profiles[member.userId]?.avatarUrl} size={28} />
                  <span className="font-medium">{member.name}</span>
                  {isYou && <Tag value="you" severity="info" className="text-xs" />}
                </div>
                <span className="text-sm opacity-70">Owns {ownershipPct.toFixed(1)}% {isNow ? 'now' : `by ${formatYearMonth(row.yearMonth)}`} · aiming for {Math.round(memberTargetPct)}%</span>
              </div>
              <ProgressBar value={progressToTarget} showValue={false} style={{ height: '8px' }} className="progressbar-instant" />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-sm">
                <div>
                  <div className="opacity-60 text-xs">Equity built<InfoIcon tip="What you've actually paid toward the home: your up-front down payment plus your share of the principal paid off since." /></div>
                  <div className="font-semibold text-green-500">{formatCurrency(pos.equity, currency)}</div>
                  <div className="text-[11px] opacity-60 mt-0.5 leading-tight">
                    {formatCurrency(downPayment, currency)} down
                    <br />+ {formatCurrency(paidOffSince, currency)} paid off
                  </div>
                </div>
                <div>
                  <div className="opacity-60 text-xs">Loan left for you<InfoIcon tip="Your share of what's still owed on the loans." /></div>
                  <div className="font-semibold text-red-500">{formatCurrency(pos.liability, currency)}</div>
                </div>
                <div>
                  <div className="opacity-60 text-xs">Left to reach {Math.round(memberTargetPct)}%<InfoIcon tip="How much more you need to pay to own your target share of the home outright." /></div>
                  <div className="font-semibold">{formatCurrency(Math.max(0, pos.leftToOwnTarget), currency)}</div>
                </div>
                <div>
                  <div className="opacity-60 text-xs">Transfer / month<InfoIcon tip="What you transfer to the loan account each month: your share of the installment plus the per-person service fee." /></div>
                  <div className="font-semibold">{formatCurrency(pos.monthlyDeposit, currency)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Money-flow Sankey: follows the scrubber month above. */}
      <div className="mt-5">
        <h3 className="text-sm font-semibold mb-1">
          Where the money flows · {isNow ? 'Today' : formatYearMonth(row.yearMonth)}
        </h3>
        <p className="text-xs opacity-60 mb-2">
          What each of you has paid in so far (down payment + monthly transfers), against the whole mortgage and how
          much of its interest and amortization is already behind you.
        </p>
        <MortgageOwnershipSankey months={months} mortgage={mortgage} currency={currency} idx={safeIdx} currentUserId={currentUserId} />
      </div>
      {!isSimple && (
        <p className="text-xs opacity-60 mt-4">
          You each pay a different share of the monthly bill (set from your down payments). The person who paid less up
          front pays a slightly larger monthly share, so ownership gradually evens out to your {splitLabel} split.
        </p>
      )}
    </Card>
  );
}

// ── Per-loan card ────────────────────────────────────────────────────────────
export function SubLoanCard({
  loan,
  months,
  currency,
  currentMonth,
  isSimple,
}: {
  loan: MortgageLoan;
  months: MortgageProjectionMonth[];
  currency: Currency;
  currentMonth: string;
  isSimple: boolean;
}) {
  const row = findCurrentRow(months, currentMonth);
  const loanRow = row?.loans.find((l) => l.loanId === loan.id);
  const remaining = loanRow?.endingPrincipal ?? loan.initialPrincipal;
  const percentPaid = loan.initialPrincipal > 0 ? ((loan.initialPrincipal - remaining) / loan.initialPrincipal) * 100 : 0;
  const payoff = months.find((m) => (m.loans.find((l) => l.loanId === loan.id)?.endingPrincipal ?? 1) <= 0.005)?.yearMonth ?? null;
  const monthlyPI = loanRow?.scheduledPayment ?? loan.currentMonthlyPayment ?? 0;

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold">{loan.label}</h3>
        {loan.kind === 'asp' ? (
          <Tag value="ASP — subsidized" severity="success" className="text-xs" />
        ) : (
          <Tag value="Regular" severity="secondary" className="text-xs" />
        )}
      </div>
      <div className="text-2xl font-bold text-red-500">{formatCurrency(remaining, currency)}</div>
      <div className="text-xs opacity-60 mb-2">still owed</div>
      <ProgressBar value={percentPaid} showValue={false} style={{ height: '8px' }} />
      <div className="text-xs opacity-60 mt-1">{percentPaid.toFixed(0)}% paid off</div>
      <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
        <div>
          <div className="opacity-60 text-xs">Rate now</div>
          <div className="font-medium">{formatRate(loanRow?.effectiveAnnualRate ?? 0)}</div>
        </div>
        <div>
          <div className="opacity-60 text-xs">Monthly (loan)</div>
          <div className="font-medium">{formatCurrency(monthlyPI, currency)}</div>
        </div>
        <div>
          <div className="opacity-60 text-xs">Paid off</div>
          <div className="font-medium">{payoff ? formatYearMonth(payoff) : '—'}</div>
        </div>
        {!isSimple && (
          <div>
            <div className="opacity-60 text-xs flex items-center gap-1">Margin</div>
            <div className="font-medium">{formatRate(loan.margin)}</div>
          </div>
        )}
      </div>
    </Card>
  );
}
