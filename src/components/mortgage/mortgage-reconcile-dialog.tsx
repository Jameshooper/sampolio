'use client';

import { useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputNumber } from 'primereact/inputnumber';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { Tag } from 'primereact/tag';
import { HelpTip } from '@/components/ui/form-primitives';
import { formatCurrency, formatYearMonthShort } from '@/lib/constants';
import { reconcileMortgageMonth } from '@/lib/actions/shared-mortgages';
import type { SharedMortgage, MortgageProjectionMonth, Currency } from '@/types';

const round2 = (n: number) => Math.round(n * 100) / 100;

interface LoanDraft {
  loanId: string;
  label: string;
  showSubsidy: boolean;
  remaining: number;
  repayment: number; // full bank charge (P+I + insurance + invoicing share)
  interest: number;
  insurance: number;
  subsidy: number;
}

/**
 * Reconcile a single month: confirm (and optionally adjust) the per-loan figures
 * so the month flips from forecast → actual. Prefilled with Sampolio's projection
 * so a typical "nothing drifted" month is a one-click confirm.
 */
export function MortgageReconcileDialog({
  visible,
  month,
  mortgage,
  currency,
  onClose,
  onSaved,
}: {
  visible: boolean;
  month: MortgageProjectionMonth | null;
  mortgage: SharedMortgage;
  currency: Currency;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [drafts, setDrafts] = useState<LoanDraft[]>([]);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-seed the editable rows from the projection whenever a new target month is
  // selected. Derive-during-render (not an effect) so there's no cascading render.
  if (month && month.yearMonth !== seededFor) {
    setSeededFor(month.yearMonth);
    setError('');
    setDrafts(
      mortgage.loans.map((loan) => {
        const lr = month.loans.find((l) => l.loanId === loan.id);
        return {
          loanId: loan.id,
          label: loan.label,
          showSubsidy: loan.kind === 'asp' && !!loan.aspSubsidy?.enabled,
          remaining: round2(lr?.endingPrincipal ?? 0),
          repayment: round2(lr?.monthlyCharge ?? 0),
          interest: round2(lr?.interestPaid ?? 0),
          insurance: round2(lr?.insurance ?? 0),
          subsidy: round2(lr?.subsidy ?? 0),
        };
      })
    );
  }

  const update = (loanId: string, field: keyof LoanDraft, value: number) =>
    setDrafts((d) => d.map((x) => (x.loanId === loanId ? { ...x, [field]: value } : x)));

  const totalCharge = drafts.reduce((s, d) => s + d.repayment, 0);
  const totalRemaining = drafts.reduce((s, d) => s + d.remaining, 0);

  const save = async () => {
    if (!month) return;
    setSaving(true);
    setError('');
    const entries = drafts.map((d) => ({
      loanId: d.loanId,
      yearMonth: month.yearMonth,
      remaining: d.remaining,
      repayment: d.repayment,
      interest: d.interest,
      insurance: d.insurance,
      subsidy: d.subsidy,
    }));
    const res = await reconcileMortgageMonth(mortgage.id, entries);
    setSaving(false);
    if (res.success) onSaved(`${formatYearMonthShort(month.yearMonth)} marked as actual.`);
    else setError(res.error ?? 'Failed to reconcile');
  };

  const label = month ? formatYearMonthShort(month.yearMonth) : '';

  return (
    <Dialog
      header={`Reconcile ${label}`}
      visible={visible}
      onHide={onClose}
      style={{ width: '40rem' }}
    >
      <p className="text-sm opacity-70 mb-3">
        These are Sampolio&apos;s projected figures for <b>{label}</b>. If they match your bank statement, just confirm —
        the month becomes an <b className="text-green-600">actual</b> and future forecasts continue from it. Adjust any
        value that drifted before confirming.
      </p>

      <div className="space-y-4">
        {drafts.map((d) => (
          <div key={d.loanId} className="p-3 rounded-lg surface-ground">
            <div className="font-medium mb-2">{d.label}</div>
            <div className={`grid gap-3 ${d.showSubsidy ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <label className="text-xs opacity-70">Remaining balance</label>
                <InputNumber value={d.remaining} onValueChange={(e) => update(d.loanId, 'remaining', e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                <HelpTip text="What's still owed on this loan after this month's payment." />
              </div>
              <div>
                <label className="text-xs opacity-70">Repayment (total charge)</label>
                <InputNumber value={d.repayment} onValueChange={(e) => update(d.loanId, 'repayment', e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                <HelpTip text="The bank's full charge this month: principal + interest + insurance + invoicing share." />
              </div>
              <div>
                <label className="text-xs opacity-70">Interest paid</label>
                <InputNumber value={d.interest} onValueChange={(e) => update(d.loanId, 'interest', e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                <HelpTip text="The interest part of this month's charge, after any subsidy." />
              </div>
              <div>
                <label className="text-xs opacity-70">Insurance</label>
                <InputNumber value={d.insurance} onValueChange={(e) => update(d.loanId, 'insurance', e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                <HelpTip text="Loan-protection insurance charged this month (0 if none)." />
              </div>
              {d.showSubsidy && (
                <div>
                  <label className="text-xs opacity-70">ASP subsidy</label>
                  <InputNumber value={d.subsidy} onValueChange={(e) => update(d.loanId, 'subsidy', e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
                  <HelpTip text="Government interest subsidy this month (only when the rate is above the ASP threshold)." />
                </div>
              )}
            </div>
          </div>
        ))}

        <div className="flex items-center gap-2 text-sm">
          <Tag value={`Total charge ${formatCurrency(totalCharge, currency)}`} severity="info" />
          <Tag value={`Remaining ${formatCurrency(totalRemaining, currency)}`} />
        </div>

        {error && <Message severity="error" text={error} />}
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button label="Cancel" text onClick={onClose} disabled={saving} />
        <Button label={`Confirm ${label} as actual`} icon="pi pi-check" loading={saving} onClick={save} disabled={!month || drafts.length === 0} />
      </div>
    </Dialog>
  );
}
