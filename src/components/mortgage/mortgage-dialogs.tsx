'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { SelectButton } from 'primereact/selectbutton';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { Tag } from 'primereact/tag';
import { MonthPicker, HelpTip } from '@/components/ui/form-primitives';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { formatCurrency, formatRate } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import { recomputeAnnuityPayment } from '@/lib/mortgage-projection';
import {
  setMortgageRate,
  recordMortgageBalanceSnapshot,
  addMortgageExtraPayment,
  addMortgageMemberByEmail,
  removeMortgageMember,
  updateMortgageMember,
  setMyMortgageLinkedAccount,
} from '@/lib/actions/shared-mortgages';
import { fetchCurrentEuribor12m } from '@/lib/actions/euribor';
import { getAccounts } from '@/lib/actions/accounts';
import type { SharedMortgage, Currency, FinancialAccount } from '@/types';

interface PreviewLoan {
  label: string;
  balance: number;
  remainingMonths: number;
  margin: number;
}

// ── Euribor update (the key yearly action) ──────────────────────────────────
export function EuriborUpdateDialog({
  visible,
  mortgageId,
  defaultEffectiveMonth,
  lastEuribor,
  previewLoans,
  currency,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mortgageId: string;
  defaultEffectiveMonth: string;
  lastEuribor: number;
  previewLoans: PreviewLoan[];
  currency: Currency;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [euribor, setEuribor] = useState<number>(lastEuribor);
  const [effectiveDate, setEffectiveDate] = useState(defaultEffectiveMonth);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Convenience prefill from a public source. Never auto-saves; manual entry
  // is always the fallback (a failed/slow fetch leaves the dialog untouched).
  const [prefill, setPrefill] = useState<{ rate: number; date: string; source: string } | null>(null);
  // Mirror of `euribor` — lets the async prefill see the CURRENT value.
  // (A touched-flag in onValueChange is unreliable: PrimeReact InputNumber can
  // fire it during initial formatting, before the fetch resolves.)
  const euriborRef = useRef(euribor);
  const [prefillApplied, setPrefillApplied] = useState(false);

  useEffect(() => {
    if (!visible) return;
    // Only prefill while the field still holds its opening default — any user
    // edit changes the value away from it and the prefill backs off.
    const initialRate = euriborRef.current;
    let cancelled = false;
    fetchCurrentEuribor12m().then((res) => {
      if (cancelled) return;
      if (!res.success || !res.data) {
        setPrefill(null);
        setPrefillApplied(false);
        return;
      }
      setPrefill(res.data);
      if (euriborRef.current === initialRate) {
        euriborRef.current = res.data.rate;
        setEuribor(res.data.rate);
        setPrefillApplied(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const handleHide = () => {
    // Clear the prefill note so a reopen starts clean (a failed refetch then
    // can't leave a stale "prefilled" claim behind).
    setPrefill(null);
    setPrefillApplied(false);
    onClose();
  };

  const oldTotal = previewLoans.reduce((s, l) => s + recomputeAnnuityPayment(l.balance, lastEuribor + l.margin, l.remainingMonths), 0);
  const newTotal = previewLoans.reduce((s, l) => s + recomputeAnnuityPayment(l.balance, euribor + l.margin, l.remainingMonths), 0);
  const delta = newTotal - oldTotal;

  const save = async () => {
    setSaving(true);
    setError('');
    const res = await setMortgageRate(mortgageId, { effectiveDate, euriborRate: euribor });
    setSaving(false);
    if (res.success) onSaved('Euribor updated — your payments are recalculated.');
    else setError(res.error ?? 'Failed to save');
  };

  return (
    <Dialog header="Update your Euribor rate" visible={visible} onHide={handleHide} style={{ width: '32rem' }}>
      <p className="text-sm opacity-70 mb-3">
        Banks reset the 12-month Euribor once a year. Enter the new rate and your payments update automatically.
      </p>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">New 12-month Euribor rate</label>
          <InputNumber
            value={euribor}
            onValueChange={(e) => {
              const next = e.value ?? 0;
              // A real edit moves the value away from what we hold — drop the
              // "prefilled" note then; formatting echoes (same value) don't.
              if (next !== euriborRef.current) setPrefillApplied(false);
              euriborRef.current = next;
              setEuribor(next);
            }}
            suffix=" %"
            minFractionDigits={2}
            maxFractionDigits={3}
            className="w-full"
          />
          {prefillApplied && prefill && (
            <p className="text-xs opacity-70 mt-1">
              Prefilled from {prefill.source} ({prefill.date}) — confirm before saving.
            </p>
          )}
          <HelpTip text="Euribor is the rate European banks charge each other. Your loan rate = Euribor + the bank's fixed margin." />
        </div>
        <div>
          <label className="text-sm font-medium">Effective from</label>
          <MonthPicker value={effectiveDate} onChange={setEffectiveDate} />
        </div>

        <div className="p-3 rounded-lg surface-ground text-sm">
          <div className="flex items-center justify-between">
            <span className="opacity-70">Loan payment (principal + interest)</span>
            <span>
              {formatCurrency(oldTotal, currency)} → <span className="font-semibold">{formatCurrency(newTotal, currency)}</span>
            </span>
          </div>
          <div className="mt-2">
            <Tag
              value={`${delta >= 0 ? '+' : ''}${formatCurrency(delta, currency)} / month`}
              severity={delta > 0 ? 'danger' : delta < 0 ? 'success' : 'info'}
            />
            <span className="ml-2 opacity-60">
              {delta > 0 ? 'goes up' : delta < 0 ? 'goes down' : 'no change'} at the new rate ({formatRate(euribor + (previewLoans[0]?.margin ?? 0))})
            </span>
          </div>
        </div>

        {error && <Message severity="error" text={error} />}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button label="Cancel" text onClick={handleHide} />
        <Button label="Update rate" loading={saving} onClick={save} />
      </div>
    </Dialog>
  );
}

// ── Drift adjustment ────────────────────────────────────────────────────────
export function DriftAdjustmentDialog({
  visible,
  mortgageId,
  loans,
  expectedByLoan,
  currency,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mortgageId: string;
  loans: { id: string; label: string }[];
  expectedByLoan: Record<string, number>;
  currency: Currency;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [loanId, setLoanId] = useState(loans[0]?.id ?? '');
  const [yearMonth, setYearMonth] = useState(getCurrentYearMonth());
  const [actualBalance, setActualBalance] = useState<number>(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const expected = expectedByLoan[loanId] ?? 0;
  const variance = actualBalance - expected;

  const save = async () => {
    setSaving(true);
    setError('');
    const res = await recordMortgageBalanceSnapshot(mortgageId, { loanId, yearMonth, actualBalance });
    setSaving(false);
    if (res.success) onSaved('Balance corrected — projections re-anchored to your real number.');
    else setError(res.error ?? 'Failed to save');
  };

  return (
    <Dialog header="Correct a balance" visible={visible} onHide={onClose} style={{ width: '30rem' }}>
      <p className="text-sm opacity-70 mb-3">
        If your bank statement differs from our estimate, enter the real balance here. We&apos;ll re-anchor future projections to it.
      </p>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Loan</label>
          <Dropdown value={loanId} options={loans.map((l) => ({ label: l.label, value: l.id }))} onChange={(e) => setLoanId(e.value)} className="w-full" />
        </div>
        <div>
          <label className="text-sm font-medium">Month of the statement</label>
          <MonthPicker value={yearMonth} onChange={setYearMonth} />
        </div>
        <div>
          <label className="text-sm font-medium">Actual balance from your bank statement</label>
          <InputNumber value={actualBalance} onValueChange={(e) => setActualBalance(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
        </div>
        <div className="p-3 rounded-lg surface-ground text-sm">
          We projected {formatCurrency(expected, currency)}. You entered {formatCurrency(actualBalance, currency)}.
          <div className="mt-1">
            <Tag value={`Difference: ${variance >= 0 ? '+' : ''}${formatCurrency(variance, currency)}`} severity={Math.abs(variance) < 1 ? 'info' : variance > 0 ? 'danger' : 'success'} />
          </div>
        </div>
        {error && <Message severity="error" text={error} />}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button label="Cancel" text onClick={onClose} />
        <Button label="Save correction" loading={saving} onClick={save} disabled={!loanId} />
      </div>
    </Dialog>
  );
}

// ── Extra / early payment ────────────────────────────────────────────────────
export function ExtraPaymentDialog({
  visible,
  mortgageId,
  loans,
  currency,
  onClose,
  onSaved,
}: {
  visible: boolean;
  mortgageId: string;
  loans: { id: string; label: string }[];
  currency: Currency;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [loanId, setLoanId] = useState(loans[0]?.id ?? '');
  const [date, setDate] = useState(getCurrentYearMonth());
  const [amount, setAmount] = useState<number>(0);
  const [mode, setMode] = useState<'shorten-term' | 'lower-payment'>('shorten-term');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!amount || amount <= 0) { setError('Enter an amount'); return; }
    setSaving(true);
    setError('');
    const res = await addMortgageExtraPayment(mortgageId, { loanId, date, amount, mode });
    setSaving(false);
    if (res.success) onSaved('Extra payment added.');
    else setError(res.error ?? 'Failed to save');
  };

  return (
    <Dialog header="Make an extra payment" visible={visible} onHide={onClose} style={{ width: '30rem' }}>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Loan</label>
          <Dropdown value={loanId} options={loans.map((l) => ({ label: l.label, value: l.id }))} onChange={(e) => setLoanId(e.value)} className="w-full" />
        </div>
        <div>
          <label className="text-sm font-medium">Month</label>
          <MonthPicker value={date} onChange={setDate} />
        </div>
        <div>
          <label className="text-sm font-medium">Amount</label>
          <InputNumber value={amount} onValueChange={(e) => setAmount(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
        </div>
        <div>
          <label className="text-sm font-medium block mb-1">What should it do?</label>
          <SelectButton
            value={mode}
            onChange={(e) => e.value && setMode(e.value)}
            options={[
              { label: 'Pay it off sooner', value: 'shorten-term' },
              { label: 'Lower my monthly payment', value: 'lower-payment' },
            ]}
          />
          <HelpTip
            text={
              mode === 'shorten-term'
                ? 'Your monthly payment stays the same, but you finish paying earlier.'
                : 'You keep paying until the same end date, but each month costs less.'
            }
          />
        </div>
        {error && <Message severity="error" text={error} />}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button label="Cancel" text onClick={onClose} />
        <Button label="Add payment" loading={saving} onClick={save} disabled={!loanId} />
      </div>
    </Dialog>
  );
}

// ── Members management ───────────────────────────────────────────────────────
export function MortgageMembersDialog({
  visible,
  mortgage,
  currentUserId,
  onClose,
  onChanged,
}: {
  visible: boolean;
  mortgage: SharedMortgage;
  currentUserId?: string;
  onClose: () => void;
  onChanged: (msg: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [initialPayment, setInitialPayment] = useState<number>(0);
  const [sharePercent, setSharePercent] = useState<number>(50);
  const [targetPercent, setTargetPercent] = useState<number>(50);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const isOwner = mortgage.members.find((m) => m.userId === currentUserId)?.role === 'owner';
  const myLinkedAccountId = mortgage.members.find((m) => m.userId === currentUserId)?.linkedAccountId ?? null;
  const profiles = useUserProfiles(mortgage.members.map((m) => m.userId));

  // Load the current user's own cash accounts to offer as the "pay from" account.
  useEffect(() => {
    if (!visible) return;
    getAccounts().then((res) => {
      if (res.success && res.data) setAccounts(res.data.filter((a) => !a.isArchived));
    });
  }, [visible]);

  const linkAccount = async (accountId: string | null) => {
    const res = await setMyMortgageLinkedAccount(mortgage.id, accountId);
    if (res.success) onChanged(accountId ? 'Mortgage transfer will show in that account’s cashflow.' : 'Mortgage transfer removed from cashflow.');
    else setError(res.error ?? 'Failed to update linked account');
  };

  const add = async () => {
    setSaving(true);
    setError('');
    const res = await addMortgageMemberByEmail(mortgage.id, { email, initialPayment, loanSharePercent: sharePercent / 100, ownershipTargetPercent: targetPercent / 100 });
    setSaving(false);
    if (res.success) {
      setEmail('');
      onChanged('Member added.');
    } else setError(res.error ?? 'Failed to add member');
  };

  const remove = async (userId: string) => {
    const res = await removeMortgageMember(mortgage.id, userId);
    if (res.success) onChanged('Member removed.');
    else setError(res.error ?? 'Failed to remove member');
  };

  const changeRole = async (userId: string, role: 'owner' | 'member') => {
    setError('');
    const res = await updateMortgageMember(mortgage.id, userId, { role });
    if (res.success) onChanged('Member updated.');
    else setError(res.error ?? 'Failed to update member');
  };

  return (
    <Dialog header="Who can see this mortgage" visible={visible} onHide={onClose} style={{ width: '32rem' }}>
      <p className="text-sm opacity-70 mb-3">Both members can see and edit everything here — there&apos;s no privacy between you.</p>
      {/* Shared error slot at the top so role/remove failures are visible without scrolling. */}
      {error && <Message severity="error" text={error} className="w-full mb-3" />}
      <div className="space-y-2 mb-4">
        {mortgage.members.map((m) => (
          <div key={m.userId} className="p-2 rounded surface-ground text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex items-center gap-2">
                <UserAvatar userId={m.userId} name={m.name} avatarUrl={profiles[m.userId]?.avatarUrl} size={32} />
                <div className="min-w-0">
                  <span className="font-medium">{m.name}</span>
                  <span className="opacity-50 ml-2 break-all">{m.email}</span>
                  {m.userId === currentUserId && <Tag value="you" severity="success" className="ml-2 text-xs" />}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap shrink-0">
                {isOwner ? (
                  <Dropdown
                    value={m.role}
                    options={[
                      { label: 'Owner', value: 'owner' },
                      { label: 'Member', value: 'member' },
                    ]}
                    onChange={(e) => changeRole(m.userId, e.value)}
                    style={{ width: '8rem' }}
                  />
                ) : (
                  m.role === 'owner' && <Tag value="owner" severity="info" className="text-xs" />
                )}
                {isOwner && m.userId !== currentUserId && (
                  <Button icon="pi pi-trash" text severity="danger" size="small" onClick={() => remove(m.userId)} />
                )}
              </div>
            </div>
            {/* Each member privately links the cash account they pay the transfer from. */}
            {m.userId === currentUserId && (
              <div className="mt-2">
                {/* Label + dropdown wrap as a row on wider screens and stack on
                    mobile; the help text is a full-width block below — putting
                    HelpTip inside the flex row squeezes it into a skinny column. */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <span className="text-xs opacity-70 whitespace-nowrap shrink-0">Pay this mortgage from</span>
                  <Dropdown
                    value={myLinkedAccountId}
                    options={[{ label: 'Not linked (hide from cashflow)', value: null }, ...accounts.map((a) => ({ label: a.name, value: a.id }))]}
                    onChange={(e) => linkAccount(typeof e.value === 'string' ? e.value : null)}
                    placeholder="Choose an account"
                    className="w-full sm:flex-1"
                    showClear={false}
                  />
                </div>
                <HelpTip text="Your monthly transfer to this mortgage will appear as a recurring expense in the chosen account's cashflow, recomputed each month from the loan." />
              </div>
            )}
          </div>
        ))}
      </div>

      {isOwner && (
        <div className="border-t surface-border pt-3 space-y-2">
          <label className="text-sm font-medium">Invite by email</label>
          <InputText value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@example.com" className="w-full" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="min-w-0">
              <label className="text-xs opacity-70">Down payment</label>
              <InputNumber value={initialPayment} onValueChange={(e) => setInitialPayment(e.value ?? 0)} mode="currency" currency={mortgage.currency} locale="fi-FI" className="w-full" inputClassName="w-full" />
            </div>
            <div className="min-w-0">
              <label className="text-xs opacity-70">Loan share %</label>
              <InputNumber value={sharePercent} onValueChange={(e) => setSharePercent(e.value ?? 0)} suffix=" %" className="w-full" inputClassName="w-full" />
            </div>
            <div className="min-w-0">
              <label className="text-xs opacity-70">Target own %</label>
              <InputNumber value={targetPercent} onValueChange={(e) => setTargetPercent(e.value ?? 0)} suffix=" %" className="w-full" inputClassName="w-full" />
            </div>
          </div>
          <Button label="Add member" loading={saving} onClick={add} disabled={!email} className="w-full mt-1" />
        </div>
      )}
    </Dialog>
  );
}
