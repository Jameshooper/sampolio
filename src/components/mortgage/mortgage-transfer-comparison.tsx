'use client';

/**
 * Mortgage transfer / refinancing comparison simulator.
 *
 * Collapsed by default (rarely used). Lets the user enter a competing bank's
 * offer and compares it side-by-side with the current mortgage — table, a
 * cumulative-cost chart, and a break-even point. All math is ephemeral and
 * client-side (see src/lib/mortgage-transfer-utils.ts); nothing is persisted.
 */

import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { SelectButton } from 'primereact/selectbutton';
import { Tag } from 'primereact/tag';
import { MdSwapHoriz, MdExpandMore, MdExpandLess, MdInfoOutline } from 'react-icons/md';
import { useTheme } from '@/components/providers/theme-provider';
import { mortgageOfferSchema, type MortgageOfferFormData } from '@/lib/schemas/mortgage.schema';
import { computeTransferComparison } from '@/lib/mortgage-transfer-utils';
import { TransferComparisonChart } from './mortgage-charts';
import { formatCurrency, formatRate, formatYearMonth } from '@/lib/constants';
import { addMonths, getMonthsBetween } from '@/lib/projection';
import type { MortgageProjectionInputsResult } from '@/lib/actions/shared-mortgages';
import type { MortgageProjectionMonth, Currency, YearMonth } from '@/types';

interface Props {
  inputs: MortgageProjectionInputsResult;
  months: MortgageProjectionMonth[];
  currentRow: MortgageProjectionMonth | undefined;
  currentMonth: YearMonth;
  currency: Currency;
}

function termLabel(months: number): string {
  return `${months} mo (~${(months / 12).toFixed(1)} yr)`;
}

export function MortgageTransferComparison({ inputs, months, currentRow, currentMonth, currency }: Props) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [open, setOpen] = useState(false);

  const refiStart = addMonths(currentMonth, 1);
  const loans = inputs.mortgage.loans;
  const hasAsp = loans.some((l) => l.kind === 'asp' && l.aspSubsidy?.enabled === true);

  // Sensible prefills derived from the current mortgage.
  const { latestEuribor, defaultMargin, defaultTerm, defaultInsurance, defaultServiceFee } = useMemo(() => {
    const latest = inputs.rates[inputs.rates.length - 1]?.euriborRate ?? 0;
    const balances = loans.map((l) => currentRow?.loans.find((x) => x.loanId === l.id)?.endingPrincipal ?? 0);
    const totalBal = balances.reduce((s, b) => s + b, 0);
    const weightedMargin = totalBal > 0 ? loans.reduce((s, l, i) => s + l.margin * balances[i], 0) / totalBal : (loans[0]?.margin ?? 0);
    const remaining = Math.max(
      ...loans.map((l) => Math.max(1, l.originalTermMonths - getMonthsBetween(l.startDate, refiStart)))
    );
    return {
      latestEuribor: latest,
      defaultMargin: Math.round(weightedMargin * 100) / 100,
      defaultTerm: remaining,
      defaultInsurance: Math.round((currentRow?.totalInsurance ?? 0) * 100) / 100,
      // The new bank's total monthly servicing charge — prefilled with the
      // current invoicing + service fees so an equal-margin offer reads neutral.
      defaultServiceFee: currentRow
        ? Math.round(((currentRow.serviceFee + currentRow.invoicingFee) || 2.5) * 100) / 100
        : 2.5,
    };
  }, [inputs.rates, loans, currentRow, refiStart]);

  const { control, watch } = useForm<MortgageOfferFormData>({
    resolver: zodResolver(mortgageOfferSchema),
    mode: 'onChange',
    defaultValues: {
      margin: defaultMargin,
      euriborRate: latestEuribor,
      termMonths: defaultTerm,
      paymentMode: 'annuity-fixed-term',
      arrangementFee: 0,
      deedTransferFee: 44,
      otherOneOffCosts: 0,
      earlyRepaymentPenalty: 0,
      monthlyServiceFee: defaultServiceFee,
      monthlyInsurance: defaultInsurance,
      retainAsp: hasAsp,
    },
  });

  const offer = watch();
  const comparison = useMemo(() => {
    if (!currentRow || currentRow.totalRemaining <= 0.005) return null;
    const parsed = mortgageOfferSchema.safeParse(offer);
    if (!parsed.success) return null;
    return computeTransferComparison(months, inputs, currentRow, refiStart, parsed.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(offer), months, inputs, currentRow, refiStart]);

  const cardBg = isDark ? 'bg-gray-900' : 'bg-white';
  const subtleBg = isDark ? 'bg-gray-800/60' : 'bg-gray-50';

  return (
    <div className={`rounded-xl border ${isDark ? 'border-gray-700' : 'border-gray-200'} ${cardBg}`}>
      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 p-4 sm:p-5 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-blue-500 text-xl shrink-0"><MdSwapHoriz /></span>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-semibold truncate">Compare a transfer offer from another bank</h2>
            <p className="text-xs sm:text-sm opacity-60 truncate">See if refinancing to a lower margin is worth the switching costs.</p>
          </div>
        </div>
        <span className="text-2xl opacity-60 shrink-0">{open ? <MdExpandLess /> : <MdExpandMore />}</span>
      </button>

      {open && (
        <div className="px-4 sm:px-5 pb-5 space-y-5">
          {/* Explainer */}
          <div className={`flex gap-3 p-3 rounded-lg text-xs sm:text-sm ${isDark ? 'bg-blue-900/20 text-blue-200' : 'bg-blue-50 text-blue-800'}`}>
            <span className="text-base shrink-0 mt-0.5"><MdInfoOutline /></span>
            <div className="space-y-1">
              <p>In Finland, moving a mortgage to another bank is a <strong>refinance</strong>: the new bank grants a new loan for your remaining balance and pays off the old one. No transfer tax (varainsiirtovero) applies — you keep the home.</p>
              <p>Your <strong>ASP interest subsidy can move with the loan</strong> (it follows the loan; the 10-year clock keeps running from your original draw, and the amount can&apos;t increase) — use the toggle to model a bank that won&apos;t take it over.</p>
              <p>Typical one-off costs: a new-loan arrangement fee (often negotiable), the electronic mortgage-deed transfer (~€44 at the National Land Survey), maybe a valuation. Variable/Euribor loans normally have no early-repayment penalty. The reference rate is held at your current Euribor for both, so the difference comes from margin, fees and ASP.</p>
            </div>
          </div>

          {/* Offer form */}
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3">
            <Field label="New margin">
              <Controller name="margin" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} suffix=" %" minFractionDigits={2} maxFractionDigits={3} min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Reference rate (Euribor)">
              <Controller name="euriborRate" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} suffix=" %" minFractionDigits={2} maxFractionDigits={3} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Loan term (months)">
              <Controller name="termMonths" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 1)} suffix=" mo" min={1} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Arrangement fee">
              <Controller name="arrangementFee" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Mortgage-deed transfer">
              <Controller name="deedTransferFee" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Other one-off costs">
              <Controller name="otherOneOffCosts" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Early-repayment penalty">
              <Controller name="earlyRepaymentPenalty" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Monthly service fee">
              <Controller name="monthlyServiceFee" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Monthly insurance">
              <Controller name="monthlyInsurance" control={control} render={({ field }) => (
                <InputNumber value={field.value} onValueChange={(e) => field.onChange(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" min={0} className="w-full" inputClassName="w-full" />
              )} />
            </Field>
            <Field label="Payment mode">
              <Controller name="paymentMode" control={control} render={({ field }) => (
                <SelectButton
                  value={field.value}
                  onChange={(e) => e.value && field.onChange(e.value)}
                  options={[{ label: 'Fixed term', value: 'annuity-fixed-term' }, { label: 'Fixed payment', value: 'fixed-payment' }]}
                  className="text-xs"
                />
              )} />
            </Field>
            {hasAsp && (
              <Field label="Retain ASP subsidy">
                <Controller name="retainAsp" control={control} render={({ field }) => (
                  <div className="flex items-center gap-2 h-[42px]">
                    <InputSwitch checked={field.value} onChange={(e) => field.onChange(e.value)} />
                    <span className="text-xs opacity-70">{field.value ? 'Kept on transfer' : 'Lost on transfer'}</span>
                  </div>
                )} />
              </Field>
            )}
          </div>

          {!comparison ? (
            <p className="text-sm opacity-60">No active balance to refinance, or the offer values are incomplete.</p>
          ) : (
            <>
              {/* Headline */}
              <div className={`flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg ${subtleBg}`}>
                <div className="flex items-center gap-2">
                  <span className="text-sm opacity-70">Refinancing</span>
                  <span className="font-semibold">{formatCurrency(comparison.offer.startBalance, currency)}</span>
                  <span className="text-sm opacity-70">from {formatYearMonth(refiStart)}</span>
                </div>
                <div className="sm:ml-auto flex flex-wrap items-center gap-3">
                  <Tag
                    severity={comparison.netLifetimeSaving >= 0 ? 'success' : 'danger'}
                    value={`${comparison.netLifetimeSaving >= 0 ? 'Saves' : 'Costs'} ${formatCurrency(Math.abs(comparison.netLifetimeSaving), currency)} over the loan's life`}
                  />
                  <span className="text-sm opacity-80">
                    {comparison.breakEvenMonths != null
                      ? `Pays for itself in ${termLabel(comparison.breakEvenMonths)}`
                      : "Doesn't pay off within the term"}
                  </span>
                </div>
              </div>

              {/* Side-by-side table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse min-w-[420px]">
                  <thead>
                    <tr className={`border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                      <th className={`sticky left-0 ${cardBg} text-left font-medium py-2 pr-3`}></th>
                      <th className="text-right font-semibold py-2 px-3">Current</th>
                      <th className="text-right font-semibold py-2 pl-3">This offer</th>
                    </tr>
                  </thead>
                  <tbody>
                    <ComparisonRow label="Interest rate (Euribor + margin)" cardBg={cardBg} isDark={isDark}
                      current={formatRate(comparison.current.allInRate)} offer={formatRate(comparison.offer.allInRate)} />
                    <ComparisonRow label="Monthly payment" cardBg={cardBg} isDark={isDark}
                      current={formatCurrency(comparison.current.firstMonthlyCharge, currency)} offer={formatCurrency(comparison.offer.firstMonthlyCharge, currency)} />
                    <ComparisonRow label="Payoff" cardBg={cardBg} isDark={isDark}
                      current={comparison.current.payoffMonth ? formatYearMonth(comparison.current.payoffMonth) : '—'}
                      offer={comparison.offer.payoffMonth ? formatYearMonth(comparison.offer.payoffMonth) : '—'} />
                    <ComparisonRow label="Remaining term" cardBg={cardBg} isDark={isDark}
                      current={termLabel(comparison.current.remainingMonths)} offer={termLabel(comparison.offer.remainingMonths)} />
                    <ComparisonRow label="Total interest (out-of-pocket)" cardBg={cardBg} isDark={isDark}
                      current={formatCurrency(comparison.current.totalInterest, currency)} offer={formatCurrency(comparison.offer.totalInterest, currency)} />
                    {(hasAsp || comparison.current.totalSubsidy > 0) && (
                      <ComparisonRow label="ASP subsidy received" cardBg={cardBg} isDark={isDark}
                        current={formatCurrency(comparison.current.totalSubsidy, currency)} offer={formatCurrency(comparison.offer.totalSubsidy, currency)} />
                    )}
                    <ComparisonRow label="Service + invoicing fees" cardBg={cardBg} isDark={isDark}
                      current={formatCurrency(comparison.current.totalFees, currency)} offer={formatCurrency(comparison.offer.totalFees, currency)} />
                    <ComparisonRow label="Insurance" cardBg={cardBg} isDark={isDark}
                      current={formatCurrency(comparison.current.totalInsurance, currency)} offer={formatCurrency(comparison.offer.totalInsurance, currency)} />
                    <ComparisonRow label="One-off transfer costs" cardBg={cardBg} isDark={isDark}
                      current="—" offer={formatCurrency(comparison.offer.oneOffCosts, currency)} />
                    <tr className={`border-t-2 ${isDark ? 'border-gray-600' : 'border-gray-300'} font-semibold`}>
                      <td className={`sticky left-0 ${cardBg} py-2 pr-3`}>Total cost of borrowing</td>
                      <td className="text-right py-2 px-3">{formatCurrency(comparison.current.lifetimeCost, currency)}</td>
                      <td className="text-right py-2 pl-3">{formatCurrency(comparison.offer.lifetimeCost, currency)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="text-xs opacity-50">
                &ldquo;Cost of borrowing&rdquo; = interest (net of any ASP subsidy) + fees + insurance + one-off switching costs over each scenario&apos;s own term. Principal is excluded (it builds equity, not cost).
              </p>

              {/* Cumulative cost chart */}
              <div>
                <h3 className="text-sm font-semibold mb-2">Cumulative cost over time</h3>
                <TransferComparisonChart series={comparison.series} currency={currency} breakEvenMonths={comparison.breakEvenMonths} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs opacity-70">{label}</span>
      {children}
    </label>
  );
}

function ComparisonRow({ label, current, offer, cardBg, isDark }: { label: string; current: string; offer: string; cardBg: string; isDark: boolean }) {
  return (
    <tr className={`border-b ${isDark ? 'border-gray-800' : 'border-gray-100'}`}>
      <td className={`sticky left-0 ${cardBg} py-2 pr-3 opacity-80`}>{label}</td>
      <td className="text-right py-2 px-3">{current}</td>
      <td className="text-right py-2 pl-3">{offer}</td>
    </tr>
  );
}
