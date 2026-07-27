'use client';

import { useState } from 'react';
import { Card } from 'primereact/card';
import { Dialog } from 'primereact/dialog';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { SubEntityList, MonthPicker } from '@/components/ui/form-primitives';
import { formatCurrency, formatYearMonthShort, formatRate } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import {
  setMortgageRate,
  deleteMortgageRate,
  setMortgageCost,
  deleteMortgageCost,
} from '@/lib/actions/shared-mortgages';
import type { SharedMortgage, MortgageRateEntry, MortgageCostEntry, MortgageCostType, Currency } from '@/types';

const COST_LABELS: Record<MortgageCostType, string> = {
  'loan-insurance': 'Insurance',
  'invoicing-fee': 'Invoicing fee',
  'service-fee': 'Service fee',
};

export function MortgageHistoryStrips({
  mortgage,
  rates,
  costs,
  currency,
  onChanged,
}: {
  mortgage: SharedMortgage;
  rates: MortgageRateEntry[];
  costs: MortgageCostEntry[];
  currency: Currency;
  onChanged: (msg: string) => void;
}) {
  const loanLabel = (id?: string) => mortgage.loans.find((l) => l.id === id)?.label ?? '';
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Rate dialog (add + edit) ──
  const [rateDialog, setRateDialog] = useState(false);
  const [editingRate, setEditingRate] = useState<MortgageRateEntry | null>(null);
  const [euribor, setEuribor] = useState<number>(0);
  const [rateDate, setRateDate] = useState(getCurrentYearMonth());

  const openAddRate = () => {
    setEditingRate(null);
    setEuribor(rates[rates.length - 1]?.euriborRate ?? 0);
    setRateDate(getCurrentYearMonth());
    setError('');
    setRateDialog(true);
  };
  const openEditRate = (id: string) => {
    const r = rates.find((x) => x.id === id);
    if (!r) return;
    setEditingRate(r);
    setEuribor(r.euriborRate);
    setRateDate(r.effectiveDate);
    setError('');
    setRateDialog(true);
  };
  const saveRate = async () => {
    setSaving(true);
    setError('');
    // If the month changed on an existing entry, remove the old one first.
    if (editingRate && editingRate.effectiveDate !== rateDate) {
      await deleteMortgageRate(mortgage.id, editingRate.id);
    }
    const res = await setMortgageRate(mortgage.id, { effectiveDate: rateDate, euriborRate: euribor });
    setSaving(false);
    if (res.success) {
      setRateDialog(false);
      onChanged(editingRate ? 'Rate updated.' : 'Rate added.');
    } else setError(res.error ?? 'Failed to save rate');
  };

  // ── Cost dialog (add + edit) ──
  const [costDialog, setCostDialog] = useState(false);
  const [editingCost, setEditingCost] = useState<MortgageCostEntry | null>(null);
  const [type, setType] = useState<MortgageCostType>('invoicing-fee');
  const [loanId, setLoanId] = useState<string>(mortgage.loans[0]?.id ?? '');
  const [costDate, setCostDate] = useState(getCurrentYearMonth());
  const [amount, setAmount] = useState<number>(0);

  const openAddCost = () => {
    setEditingCost(null);
    setType('invoicing-fee');
    setLoanId(mortgage.loans[0]?.id ?? '');
    setCostDate(getCurrentYearMonth());
    setAmount(0);
    setError('');
    setCostDialog(true);
  };
  const openEditCost = (id: string) => {
    const c = costs.find((x) => x.id === id);
    if (!c) return;
    setEditingCost(c);
    setType(c.type);
    setLoanId(c.loanId ?? mortgage.loans[0]?.id ?? '');
    setCostDate(c.effectiveDate);
    setAmount(c.amount);
    setError('');
    setCostDialog(true);
  };
  const saveCost = async () => {
    setSaving(true);
    setError('');
    const newLoanId = type === 'loan-insurance' ? loanId : undefined;
    // If the key (type/loan/month) changed on an existing entry, remove the old one.
    if (editingCost && (editingCost.type !== type || editingCost.loanId !== newLoanId || editingCost.effectiveDate !== costDate)) {
      await deleteMortgageCost(mortgage.id, editingCost.id);
    }
    const res = await setMortgageCost(mortgage.id, { type, loanId: newLoanId, effectiveDate: costDate, amount });
    setSaving(false);
    if (res.success) {
      setCostDialog(false);
      onChanged(editingCost ? 'Fee updated.' : 'Fee added.');
    } else setError(res.error ?? 'Failed to save');
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <SubEntityList
          title="Euribor rate history"
          addLabel="Add rate"
          items={rates.map((r) => ({ id: r.id, label: formatRate(r.euriborRate), detail: `from ${formatYearMonthShort(r.effectiveDate)}` }))}
          onAdd={openAddRate}
          onEditItem={openEditRate}
          onDeleteItem={async (id) => {
            const res = await deleteMortgageRate(mortgage.id, id);
            if (res.success) onChanged('Rate removed.');
          }}
        />
      </Card>

      <Card>
        <SubEntityList
          title="Fees & insurance history"
          addLabel="Add / change a fee"
          items={costs.map((c) => ({
            id: c.id,
            label: `${COST_LABELS[c.type]}${c.loanId ? ` (${loanLabel(c.loanId)})` : ''}: ${formatCurrency(c.amount, currency)}`,
            detail: `from ${formatYearMonthShort(c.effectiveDate)}`,
          }))}
          onAdd={openAddCost}
          onEditItem={openEditCost}
          onDeleteItem={async (id) => {
            const res = await deleteMortgageCost(mortgage.id, id);
            if (res.success) onChanged('Fee entry removed.');
          }}
        />
      </Card>

      {/* Rate add/edit dialog */}
      <Dialog header={editingRate ? 'Edit Euribor rate' : 'Add Euribor rate'} visible={rateDialog} onHide={() => setRateDialog(false)} style={{ width: '26rem' }}>
        <p className="text-sm opacity-70 mb-3">The rate applies from the chosen month onward (your loan rate = Euribor + each loan&apos;s margin).</p>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Effective from</label>
            <MonthPicker value={rateDate} onChange={setRateDate} />
          </div>
          <div>
            <label className="text-sm font-medium">12-month Euribor rate</label>
            <InputNumber value={euribor} onValueChange={(e) => setEuribor(e.value ?? 0)} suffix=" %" minFractionDigits={2} maxFractionDigits={3} className="w-full" />
          </div>
          {error && <Message severity="error" text={error} />}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button label="Cancel" text onClick={() => setRateDialog(false)} />
          <Button label="Save" loading={saving} onClick={saveRate} />
        </div>
      </Dialog>

      {/* Cost add/edit dialog */}
      <Dialog header={editingCost ? 'Edit fee or insurance' : 'Add fee or insurance'} visible={costDialog} onHide={() => setCostDialog(false)} style={{ width: '28rem' }}>
        <p className="text-sm opacity-70 mb-3">The amount applies from the chosen month onward; earlier history is kept.</p>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">What</label>
            <Dropdown
              value={type}
              options={(Object.keys(COST_LABELS) as MortgageCostType[]).map((t) => ({ label: COST_LABELS[t], value: t }))}
              onChange={(e) => setType(e.value)}
              className="w-full"
            />
          </div>
          {type === 'loan-insurance' && (
            <div>
              <label className="text-sm font-medium">Loan</label>
              <Dropdown value={loanId} options={mortgage.loans.map((l) => ({ label: l.label, value: l.id }))} onChange={(e) => setLoanId(e.value)} className="w-full" />
            </div>
          )}
          <div>
            <label className="text-sm font-medium">Effective from</label>
            <MonthPicker value={costDate} onChange={setCostDate} />
          </div>
          <div>
            <label className="text-sm font-medium">Monthly amount</label>
            <InputNumber value={amount} onValueChange={(e) => setAmount(e.value ?? 0)} mode="currency" currency={currency} locale="fi-FI" className="w-full" />
          </div>
          {error && <Message severity="error" text={error} />}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button label="Cancel" text onClick={() => setCostDialog(false)} />
          <Button label="Save" loading={saving} onClick={saveCost} />
        </div>
      </Dialog>
    </div>
  );
}
