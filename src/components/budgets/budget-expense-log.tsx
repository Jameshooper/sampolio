'use client';

import { useState, useMemo } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { Calendar } from 'primereact/calendar';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Message } from 'primereact/message';
import { confirmDialog } from 'primereact/confirmdialog';
import { MdDelete } from 'react-icons/md';
import { BUDGET_CATEGORIES, formatCurrency } from '@/lib/constants';
import { useAppContext } from '@/components/layout/app-layout';
import { budgetExpenseEntrySchema } from '@/lib/schemas/budget.schema';
import { addBudgetExpenseEntry, updateBudgetExpenseEntry, deleteBudgetExpenseEntry } from '@/lib/actions/budgets';
import { BudgetVsActualBars } from './budget-vs-actual-bars';
import type { BudgetActualsRollup } from '@/lib/budget-utils';
import type { Budget, BudgetExpenseEntry } from '@/types';

/** Local-date ISO string (never UTC — a late-night entry must stay on its day). */
function dateToIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isoToDate(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function BudgetExpenseLog({
  budget,
  rollup,
  onChanged,
}: {
  budget: Budget;
  rollup: BudgetActualsRollup;
  onChanged: (b: Budget) => void;
}) {
  const demoMasked = useAppContext()?.demoMasked ?? false;
  // Quick-entry row: date and category stick between submits so logging five
  // same-day receipts is type → Enter → type → Enter.
  const [date, setDate] = useState<Date>(new Date());
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [category, setCategory] = useState<string>('Other');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [editEntry, setEditEntry] = useState<BudgetExpenseEntry | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Seed "last used" category/source from the most recent entry, once per
  // budget. Derive-during-render — after that the quick-entry state sticks on
  // its own between submits.
  if (budget.id !== seededFor) {
    setSeededFor(budget.id);
    const latest = [...budget.expenseEntries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest) {
      setCategory(latest.category);
      setSourceId(latest.fundingSourceId ?? null);
    }
  }

  const sourceOptions = [
    { label: '—', value: null as string | null },
    ...budget.fundingSources.map(s => ({ label: s.name, value: s.id as string | null })),
  ];

  const entries = useMemo(
    () => [...budget.expenseEntries].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
    [budget.expenseEntries]
  );
  const sourceNames = new Map(budget.fundingSources.map(s => [s.id, s.name]));

  const submitQuickEntry = async () => {
    setError('');
    const parsed = budgetExpenseEntrySchema.safeParse({
      date: dateToIso(date),
      description,
      amount: amount ?? undefined,
      category,
      fundingSourceId: sourceId ?? undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the entry');
      return;
    }
    setSaving(true);
    const res = await addBudgetExpenseEntry(budget.id, { ...parsed.data, fundingSourceId: sourceId ?? undefined });
    setSaving(false);
    if (res.success && res.data) {
      onChanged(res.data);
      setDescription('');
      setAmount(null);
    } else {
      setError(res.error ?? 'Something went wrong');
    }
  };

  const handleDelete = (entry: BudgetExpenseEntry) =>
    confirmDialog({
      message: `Delete “${entry.description || entry.category}” (${formatCurrency(entry.amount, budget.currency)})?`,
      header: 'Delete expense',
      acceptLabel: 'Delete',
      rejectLabel: 'Keep it',
      acceptClassName: 'p-button-danger',
      accept: async () => {
        const res = await deleteBudgetExpenseEntry(budget.id, entry.id);
        if (res.success && res.data) onChanged(res.data);
      },
    });

  return (
    <Card>
      <h3 className="text-base font-semibold mb-1">Spending log</h3>
      <p className="text-sm opacity-60 mb-3">Jot down what you actually spend — it takes ten seconds and makes the grant report for you.</p>

      {/* Quick entry */}
      <form
        className="flex flex-wrap gap-2 items-start mb-4"
        onSubmit={(e) => { e.preventDefault(); submitQuickEntry(); }}
      >
        <Calendar value={date} onChange={(e) => e.value && setDate(e.value as Date)} dateFormat="dd.mm.yy" className="w-32" />
        <InputText value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Groceries at ICA" className="flex-1 min-w-40" />
        <InputNumber
          value={amount}
          onValueChange={(e) => setAmount(e.value ?? null)}
          mode="currency"
          currency={budget.currency}
          locale="fi-FI"
          placeholder="Amount"
          inputClassName="w-28"
        />
        <Dropdown value={category} options={BUDGET_CATEGORIES} onChange={(e) => setCategory(e.value)} className="w-40" />
        {budget.fundingSources.length > 0 && (
          <Dropdown
            value={sourceId}
            options={sourceOptions}
            onChange={(e) => setSourceId(typeof e.value === 'string' ? e.value : null)}
            placeholder="Paid by"
            className="w-40"
            tooltip="Which money pays this? Not sure? Leave it — it doesn't change the totals."
            tooltipOptions={{ position: 'top', showDelay: 500 }}
          />
        )}
        <Button label="Add" type="submit" loading={saving} />
      </form>
      {error && <Message severity="error" text={error} className="w-full mb-3" />}

      {/* Budget vs actual */}
      {entries.length > 0 && (
        <div className="mb-4">
          <BudgetVsActualBars rollup={rollup} currency={budget.currency} />
        </div>
      )}

      {entries.length === 0 ? (
        <p className="text-sm opacity-50">Nothing logged yet. When the trip starts, add what you spend here.</p>
      ) : (
        <DataTable
          // Remount when demo mode flips: DataTable's memoized internals keep
          // stale formatCurrency output across re-renders otherwise.
          key={demoMasked ? 'masked' : 'plain'}
          value={entries}
          size="small"
          dataKey="id"
          onRowClick={(e) => setEditEntry(e.data as BudgetExpenseEntry)}
          rowClassName={() => 'cursor-pointer'}
          footer={
            <div className="flex justify-between text-sm font-semibold">
              <span>Total spent</span>
              <span>{formatCurrency(rollup.totalActual, budget.currency)}</span>
            </div>
          }
        >
          <Column field="date" header="Date" style={{ width: '7rem' }} />
          <Column field="description" header="What" body={(e: BudgetExpenseEntry) => e.description || <span className="opacity-40">—</span>} />
          <Column field="category" header="Category" style={{ width: '10rem' }} />
          <Column
            header="Paid by"
            style={{ width: '10rem' }}
            body={(e: BudgetExpenseEntry) => (e.fundingSourceId ? sourceNames.get(e.fundingSourceId) ?? '—' : <span className="opacity-40">—</span>)}
          />
          <Column
            header="Amount"
            style={{ width: '8rem' }}
            alignHeader="right"
            body={(e: BudgetExpenseEntry) => <span className="block text-right">{formatCurrency(e.amount, budget.currency)}</span>}
          />
          <Column
            style={{ width: '3rem' }}
            body={(e: BudgetExpenseEntry) => (
              <Button icon={<MdDelete />} text severity="danger" size="small" className="!p-1" onClick={(ev) => { ev.stopPropagation(); handleDelete(e); }} />
            )}
          />
        </DataTable>
      )}

      <ExpenseEditDialog
        budget={budget}
        entry={editEntry}
        onHide={() => setEditEntry(null)}
        onSaved={onChanged}
      />
    </Card>
  );
}

function ExpenseEditDialog({
  budget,
  entry,
  onHide,
  onSaved,
}: {
  budget: Budget;
  entry: BudgetExpenseEntry | null;
  onHide: () => void;
  onSaved: (b: Budget) => void;
}) {
  const [date, setDate] = useState<Date | null>(null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [category, setCategory] = useState('Other');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Re-seed when a different entry is opened, derive-during-render.
  if (entry && entry.id !== seededFor) {
    setSeededFor(entry.id);
    setDate(isoToDate(entry.date));
    setDescription(entry.description);
    setAmount(entry.amount);
    setCategory(entry.category);
    setSourceId(entry.fundingSourceId ?? null);
    setNote(entry.note ?? '');
    setError('');
  }
  if (!entry && seededFor) setSeededFor(null);

  const submit = async () => {
    if (!entry) return;
    setError('');
    const parsed = budgetExpenseEntrySchema.safeParse({
      date: date ? dateToIso(date) : '',
      description,
      amount: amount ?? undefined,
      category,
      note,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }
    setSaving(true);
    const res = await updateBudgetExpenseEntry(budget.id, entry.id, {
      ...parsed.data,
      fundingSourceId: sourceId ?? undefined,
    });
    setSaving(false);
    if (res.success && res.data) {
      onSaved(res.data);
      onHide();
    } else {
      setError(res.error ?? 'Something went wrong');
    }
  };

  return (
    <Dialog header="Edit expense" visible={!!entry} onHide={onHide} style={{ width: '26rem' }}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Date</label>
            <Calendar value={date} onChange={(e) => setDate((e.value as Date) ?? null)} dateFormat="dd.mm.yy" className="w-full" />
          </div>
          <div>
            <label className="text-sm font-medium">Amount</label>
            <InputNumber value={amount} onValueChange={(e) => setAmount(e.value ?? null)} mode="currency" currency={budget.currency} locale="fi-FI" className="w-full" />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">What was it?</label>
          <InputText value={description} onChange={(e) => setDescription(e.target.value)} className="w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Category</label>
            <Dropdown value={category} options={BUDGET_CATEGORIES} onChange={(e) => setCategory(e.value)} className="w-full" />
          </div>
          <div>
            <label className="text-sm font-medium">Paid by</label>
            <Dropdown
              value={sourceId}
              options={[{ label: '—', value: null as string | null }, ...budget.fundingSources.map(s => ({ label: s.name, value: s.id as string | null }))]}
              onChange={(e) => setSourceId(typeof e.value === 'string' ? e.value : null)}
              className="w-full"
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Note <span className="opacity-50 font-normal">(optional)</span></label>
          <InputText value={note} onChange={(e) => setNote(e.target.value)} className="w-full" />
        </div>
        {error && <Message severity="error" text={error} className="w-full" />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text severity="secondary" onClick={onHide} disabled={saving} />
          <Button label="Save" loading={saving} onClick={submit} />
        </div>
      </div>
    </Dialog>
  );
}
