'use client';

import { useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { Steps } from 'primereact/steps';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { Checkbox } from 'primereact/checkbox';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { MonthPicker, HelpTip } from '@/components/ui/form-primitives';
import { CURRENCIES, MORTGAGE_PAYMENT_MODES, MORTGAGE_DAY_COUNTS, formatCurrency } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import { deriveLoanShares } from '@/lib/mortgage-utils';
import { mortgageSetupSchema } from '@/lib/schemas/mortgage.schema';
import { createMortgage } from '@/lib/actions/shared-mortgages';
import type { Currency, CreateMortgageRequest, MortgagePaymentMode, MortgageDayCount, SharedMortgage } from '@/types';

interface LoanDraft {
  label: string;
  kind: 'asp' | 'regular';
  initialPrincipal: number;
  startDate: string;
  termYears: number;
  paymentMode: MortgagePaymentMode;
  margin: number;
  dayCount: MortgageDayCount;
  insuranceMonthly: number;
  aspEnabled: boolean;
}

function defaultLoans(startMonth: string): LoanDraft[] {
  return [
    { label: 'ASP loan', kind: 'asp', initialPrincipal: 0, startDate: startMonth, termYears: 25, paymentMode: 'annuity-fixed-term', margin: 0.4, dayCount: 'actual/360', insuranceMonthly: 0, aspEnabled: false },
    { label: 'Regular loan', kind: 'regular', initialPrincipal: 0, startDate: startMonth, termYears: 25, paymentMode: 'annuity-fixed-term', margin: 0.4, dayCount: 'actual/360', insuranceMonthly: 0, aspEnabled: false },
  ];
}

const STEPS = [{ label: 'Home' }, { label: 'People' }, { label: 'Loans' }, { label: 'Rate & fees' }, { label: 'Review' }];

export function MortgageSetupWizard({
  visible,
  isSimple,
  onClose,
  onCreated,
}: {
  visible: boolean;
  isSimple: boolean;
  onClose: () => void;
  onCreated: (m: SharedMortgage) => void;
}) {
  const startMonth = getCurrentYearMonth();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('Home');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [housePrice, setHousePrice] = useState<number>(0);
  const [creatorPayment, setCreatorPayment] = useState<number>(0);
  const [creatorTarget, setCreatorTarget] = useState<number>(50);
  const [partnerEmail, setPartnerEmail] = useState('');
  const [partnerPayment, setPartnerPayment] = useState<number>(0);
  const [partnerTarget, setPartnerTarget] = useState<number>(50);
  const [includeSecondLoan, setIncludeSecondLoan] = useState(true);
  const [loans, setLoans] = useState<LoanDraft[]>(defaultLoans(startMonth));
  const [initialEuribor, setInitialEuribor] = useState<number>(2.31);
  const [resetMonth, setResetMonth] = useState<number>(12);
  const [resetDay, setResetDay] = useState<number>(14);
  const [invoicingFee, setInvoicingFee] = useState<number>(0);
  const [serviceFee, setServiceFee] = useState<number>(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const activeLoans = includeSecondLoan ? loans : [loans[0]];
  const hasPartner = !!partnerEmail;
  // Default partner target to the complement of the creator's so they sum to 100%.
  const effectiveCreatorTarget = hasPartner ? creatorTarget : 100;
  const targets = hasPartner ? [effectiveCreatorTarget / 100, partnerTarget / 100] : [1];
  const targetSum = hasPartner ? effectiveCreatorTarget + partnerTarget : 100;
  const shares = deriveLoanShares(housePrice || 1, hasPartner ? [creatorPayment, partnerPayment] : [creatorPayment], targets);

  const updateLoan = (i: number, patch: Partial<LoanDraft>) =>
    setLoans((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async () => {
    setError('');
    const genesis = activeLoans.reduce((min, l) => (l.startDate < min ? l.startDate : min), activeLoans[0].startDate);
    const parsed = mortgageSetupSchema.safeParse({
      name, currency, housePrice,
      creatorOwnershipTargetPercent: effectiveCreatorTarget / 100,
      partnerOwnershipTargetPercent: hasPartner ? partnerTarget / 100 : undefined,
      rateResetMonth: resetMonth, rateResetDay: resetDay, creatorInitialPayment: creatorPayment,
      partnerEmail, partnerInitialPayment: partnerPayment, initialEuribor,
      invoicingFeeMonthly: invoicingFee, serviceFeeMonthly: serviceFee,
      loans: activeLoans.map((l) => ({
        label: l.label, kind: l.kind, initialPrincipal: l.initialPrincipal, startDate: l.startDate,
        originalTermMonths: l.termYears * 12, paymentMode: l.paymentMode, margin: l.margin, dayCount: l.dayCount,
        insuranceMonthly: l.insuranceMonthly, aspEnabled: l.aspEnabled,
      })),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }

    const costs: CreateMortgageRequest['costs'] = [];
    if (invoicingFee > 0) costs!.push({ type: 'invoicing-fee', effectiveDate: genesis, amount: invoicingFee });
    if (serviceFee > 0) costs!.push({ type: 'service-fee', effectiveDate: genesis, amount: serviceFee });

    const request: CreateMortgageRequest = {
      name, currency, housePrice,
      rateResetMonth: resetMonth, rateResetDay: resetDay,
      creatorInitialPayment: creatorPayment,
      creatorLoanSharePercent: shares[0] ?? 1,
      creatorOwnershipTargetPercent: effectiveCreatorTarget / 100,
      members: hasPartner ? [{ email: partnerEmail, initialPayment: partnerPayment, loanSharePercent: shares[1] ?? 0, ownershipTargetPercent: partnerTarget / 100 }] : [],
      loans: activeLoans.map((l) => ({
        label: l.label, kind: l.kind, initialPrincipal: l.initialPrincipal, startDate: l.startDate,
        originalTermMonths: l.termYears * 12, paymentMode: l.paymentMode, margin: l.margin, dayCount: l.dayCount,
        aspSubsidy: l.kind === 'asp' && l.aspEnabled ? { enabled: true, thresholdRate: 3.8, subsidyShare: 0.7, eligibilityYears: 10 } : undefined,
      })),
      rates: [{ effectiveDate: genesis, euriborRate: initialEuribor }],
      costs,
    };

    setSaving(true);
    const res = await createMortgage(request);
    if (res.success && res.data) {
      // Add genesis insurance per loan (needs the created loan ids)
      const created = res.data;
      const { setMortgageCost } = await import('@/lib/actions/shared-mortgages');
      await Promise.all(
        activeLoans.map((l, i) =>
          l.insuranceMonthly > 0
            ? setMortgageCost(created.id, { type: 'loan-insurance', loanId: created.loans[i].id, effectiveDate: genesis, amount: l.insuranceMonthly })
            : Promise.resolve(null)
        )
      );
      setSaving(false);
      onCreated(created);
    } else {
      setSaving(false);
      setError(res.error ?? 'Failed to create mortgage');
    }
  };

  const targetsValid = !hasPartner || Math.abs(targetSum - 100) < 0.5;
  const canNext = () => {
    if (step === 0) return !!name && housePrice > 0;
    if (step === 1) return targetsValid;
    if (step === 2) return activeLoans.every((l) => l.initialPrincipal > 0 && l.termYears > 0);
    return true;
  };

  return (
    <Dialog header="Set up your mortgage" visible={visible} onHide={onClose} style={{ width: '40rem' }} maximizable>
      <Steps model={STEPS} activeIndex={step} readOnly className="mb-4" />

      {step === 0 && (
        <div className="space-y-3">
          <Message severity="info" text="Let's set up your home loan from the beginning, so the whole history is tracked." />
          <div>
            <label className="text-sm font-medium">Name</label>
            <InputText value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">House price</label>
              <InputNumber value={housePrice} onValueChange={(e) => setHousePrice(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
            </div>
            <div>
              <label className="text-sm font-medium">Currency</label>
              <Dropdown value={currency} options={CURRENCIES.map((c) => ({ label: `${c.symbol} ${c.label}`, value: c.value }))} onChange={(e) => setCurrency(e.value)} className="w-full" />
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <Message severity="info" text="Who's on this mortgage, how much did each pay up front, and what share of the home is each aiming to own?" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Your down payment</label>
              <InputNumber value={creatorPayment} onValueChange={(e) => setCreatorPayment(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
            </div>
            {hasPartner && (
              <div>
                <label className="text-sm font-medium">Your target ownership</label>
                <InputNumber value={creatorTarget} onValueChange={(e) => { const v = e.value ?? 0; setCreatorTarget(v); setPartnerTarget(Math.round((100 - v) * 100) / 100); }} suffix=" %" className="w-full" />
              </div>
            )}
          </div>
          <div className="border-t surface-border pt-3">
            <label className="text-sm font-medium">Partner&apos;s email (optional)</label>
            <InputText value={partnerEmail} onChange={(e) => setPartnerEmail(e.target.value)} placeholder="partner@example.com" className="w-full" />
            <HelpTip text="They need a Sampolio account. You can also add them later." />
          </div>
          {hasPartner && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Partner&apos;s down payment</label>
                <InputNumber value={partnerPayment} onValueChange={(e) => setPartnerPayment(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
              </div>
              <div>
                <label className="text-sm font-medium">Partner&apos;s target ownership</label>
                <InputNumber value={partnerTarget} onValueChange={(e) => { const v = e.value ?? 0; setPartnerTarget(v); setCreatorTarget(Math.round((100 - v) * 100) / 100); }} suffix=" %" className="w-full" />
              </div>
            </div>
          )}
          {hasPartner && !targetsValid && (
            <Message severity="warn" text={`Ownership targets add up to ${targetSum}% — they must total 100%.`} />
          )}
          {housePrice > 0 && targetsValid && (
            <Message
              severity="info"
              text={
                hasPartner
                  ? `Based on your down payments, you'll carry ${(shares[0] * 100).toFixed(1)}% and your partner ${(shares[1] * 100).toFixed(1)}% of the monthly loan — moving you both toward a ${Math.round(effectiveCreatorTarget)}/${Math.round(partnerTarget)} split.`
                  : `You'll carry 100% of the loan for now.`
              }
            />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {!isSimple && (
            <div className="flex items-center gap-2">
              <Checkbox inputId="second" checked={includeSecondLoan} onChange={(e) => setIncludeSecondLoan(!!e.checked)} />
              <label htmlFor="second" className="text-sm">This mortgage has two loans (e.g. an ASP + a regular loan)</label>
            </div>
          )}
          {activeLoans.map((loan, i) => (
            <div key={i} className="p-3 rounded-lg surface-ground space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs opacity-70">Loan name</label>
                  <InputText value={loan.label} onChange={(e) => updateLoan(i, { label: e.target.value })} className="w-full" />
                </div>
                <div>
                  <label className="text-xs opacity-70">Type</label>
                  <Dropdown value={loan.kind} options={[{ label: 'ASP (subsidized)', value: 'asp' }, { label: 'Regular', value: 'regular' }]} onChange={(e) => updateLoan(i, { kind: e.value })} className="w-full" />
                </div>
                <div>
                  <label className="text-xs opacity-70">Initial principal</label>
                  <InputNumber value={loan.initialPrincipal} onValueChange={(e) => updateLoan(i, { initialPrincipal: e.value ?? 0 })} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                </div>
                <div>
                  <label className="text-xs opacity-70">Start month</label>
                  <MonthPicker value={loan.startDate} onChange={(v) => updateLoan(i, { startDate: v })} />
                </div>
                <div>
                  <label className="text-xs opacity-70">Term (years)</label>
                  <InputNumber value={loan.termYears} onValueChange={(e) => updateLoan(i, { termYears: e.value ?? 25 })} className="w-full" />
                </div>
                <div>
                  <label className="text-xs opacity-70">Margin</label>
                  <InputNumber value={loan.margin} onValueChange={(e) => updateLoan(i, { margin: e.value ?? 0 })} suffix=" %" minFractionDigits={2} maxFractionDigits={3} className="w-full" />
                </div>
                {!isSimple && (
                  <>
                    <div>
                      <label className="text-xs opacity-70">Payment mode</label>
                      <Dropdown value={loan.paymentMode} options={MORTGAGE_PAYMENT_MODES} onChange={(e) => updateLoan(i, { paymentMode: e.value })} className="w-full" />
                    </div>
                    <div>
                      <label className="text-xs opacity-70">Day count</label>
                      <Dropdown value={loan.dayCount} options={MORTGAGE_DAY_COUNTS} onChange={(e) => updateLoan(i, { dayCount: e.value })} className="w-full" />
                    </div>
                    <div>
                      <label className="text-xs opacity-70">Insurance / month</label>
                      <InputNumber value={loan.insuranceMonthly} onValueChange={(e) => updateLoan(i, { insuranceMonthly: e.value ?? 0 })} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                    </div>
                  </>
                )}
                {loan.kind === 'asp' && (
                  <div className="flex items-center gap-2 mt-1">
                    <Checkbox inputId={`asp-${i}`} checked={loan.aspEnabled} onChange={(e) => updateLoan(i, { aspEnabled: !!e.checked })} />
                    <label htmlFor={`asp-${i}`} className="text-xs">Apply ASP interest subsidy</label>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Current 12-month Euribor rate</label>
            <InputNumber value={initialEuribor} onValueChange={(e) => setInitialEuribor(e.value ?? 0)} suffix=" %" minFractionDigits={2} maxFractionDigits={3} className="w-full" />
            <HelpTip text="Your loan rate = this Euribor + each loan's margin. You'll update it once a year." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Rate reset month</label>
              <InputNumber value={resetMonth} onValueChange={(e) => setResetMonth(e.value ?? 12)} className="w-full" />
            </div>
            <div>
              <label className="text-sm font-medium">Rate reset day</label>
              <InputNumber value={resetDay} onValueChange={(e) => setResetDay(e.value ?? 14)} className="w-full" />
            </div>
          </div>
          {!isSimple && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium">Invoicing fee / month</label>
                <InputNumber value={invoicingFee} onValueChange={(e) => setInvoicingFee(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
              </div>
              <div>
                <label className="text-sm font-medium">Service fee / month</label>
                <InputNumber value={serviceFee} onValueChange={(e) => setServiceFee(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
              </div>
            </div>
          )}
        </div>
      )}

      {step === 4 && (
        <div className="space-y-2 text-sm">
          <Message severity="info" text="Review and create. You can correct balances or update the rate any time." />
          <div className="p-3 rounded-lg surface-ground space-y-1">
            <div className="flex justify-between"><span className="opacity-60">Home</span><span>{name} · {formatCurrency(housePrice, currency)}</span></div>
            <div className="flex justify-between"><span className="opacity-60">Loans</span><span>{activeLoans.map((l) => `${l.label} (${formatCurrency(l.initialPrincipal, currency)})`).join(', ')}</span></div>
            <div className="flex justify-between"><span className="opacity-60">Your share</span><span>{(shares[0] * 100).toFixed(1)}%</span></div>
            {partnerEmail && <div className="flex justify-between"><span className="opacity-60">Partner</span><span>{partnerEmail} · {(shares[1] * 100).toFixed(1)}%</span></div>}
            <div className="flex justify-between"><span className="opacity-60">Euribor + margin</span><span>{(initialEuribor + (activeLoans[0]?.margin ?? 0)).toFixed(2)}%</span></div>
          </div>
        </div>
      )}

      {error && <Message severity="error" text={error} className="mt-3 block" />}

      <div className="flex justify-between mt-4">
        <Button label="Back" text onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || saving} />
        {step < STEPS.length - 1 ? (
          <Button label="Next" onClick={() => setStep((s) => s + 1)} disabled={!canNext()} />
        ) : (
          <Button label="Create mortgage" loading={saving} onClick={submit} />
        )}
      </div>
    </Dialog>
  );
}
