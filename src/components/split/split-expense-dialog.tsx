'use client';
/* eslint-disable react-hooks/set-state-in-effect -- the form intentionally resets its fields when the dialog opens */

import { useEffect, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { Calendar } from 'primereact/calendar';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { useIsMobile } from '@/lib/hooks/use-media-query';
import { createSplitExpense, updateSplitExpense } from '@/lib/actions/split-groups';
import { toCents } from '@/lib/split-utils';
import { SPLIT_CATEGORIES } from '@/lib/constants';
import { SplitEditor, emptyDraft, draftFromExpense, resolveDraftSpec, type SplitDraft } from './split-editor';
import type { Currency, SplitExpense, SplitExpenseItem, SplitGroupMember } from '@/types';

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function SplitExpenseDialog({
  visible,
  onHide,
  groupId,
  members,
  currency,
  myId,
  expense,
  onSaved,
}: {
  visible: boolean;
  onHide: () => void;
  groupId: string;
  members: SplitGroupMember[];
  currency: Currency;
  myId: string;
  expense?: SplitExpenseItem;
  onSaved: (saved?: SplitExpense) => void;
}) {
  const isMobile = useIsMobile();
  const editing = !!expense;

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [draft, setDraft] = useState<SplitDraft>(() => emptyDraft(myId));
  const [category, setCategory] = useState('General');
  const [date, setDate] = useState<Date>(new Date());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    if (expense) {
      setTitle(expense.title);
      setAmount(expense.amountCents / 100);
      setDraft(draftFromExpense(expense, myId, members));
      setCategory(expense.category);
      setDate(new Date(expense.date));
      setNote(expense.note ?? '');
    } else {
      setTitle('');
      setAmount(null);
      setDraft(emptyDraft(myId));
      setCategory('General');
      setDate(new Date());
      setNote('');
    }
    setError('');
  }, [visible, expense, myId, members]);

  const save = async () => {
    if (!title.trim()) return setError('Add a description');
    if (!amount || amount <= 0) return setError('Add an amount');
    const { spec, error: splitError } = resolveDraftSpec(draft, members, toCents(amount), myId);
    if (!spec) return setError(splitError ?? 'Check the split');
    setSaving(true);
    setError('');
    const payload = {
      title: title.trim(),
      category,
      amountCents: toCents(amount),
      date: isoFromDate(date),
      note: note.trim() || undefined,
      split: spec,
    };
    const res = editing
      ? await updateSplitExpense(groupId, expense!.id, payload)
      : await createSplitExpense(groupId, payload);
    setSaving(false);
    if (!res.success) return setError(res.error ?? 'Failed to save');
    onSaved(res.data);
    onHide();
  };

  return (
    <Dialog
      header={editing ? 'Edit expense' : 'Add expense'}
      visible={visible}
      onHide={onHide}
      maximized={isMobile}
      modal
      dismissableMask
      style={{ width: '32rem' }}
    >
      <div className="flex flex-col gap-3 pt-1">
        <InputNumber
          value={amount}
          onValueChange={(e) => setAmount(e.value ?? null)}
          mode="currency"
          currency={currency}
          locale="fi-FI"
          placeholder="0,00"
          className="w-full"
          inputClassName="w-full text-xl font-semibold"
          autoFocus={!editing}
        />
        <InputText value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Description" className="w-full" />

        <SplitEditor
          members={members}
          myId={myId}
          currency={currency}
          amountCents={amount != null ? toCents(amount) : null}
          value={draft}
          onChange={setDraft}
        />

        <div className="flex items-center gap-2 border-t pt-3 border-gray-100 dark:border-gray-800">
          <span className="text-sm text-gray-500 w-20 shrink-0">Category</span>
          <Dropdown
            value={category}
            onChange={(e) => setCategory(e.value)}
            options={SPLIT_CATEGORIES.filter((c) => c !== 'Payment')}
            filter
            className="flex-1 min-w-0"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 w-20 shrink-0">Date</span>
          <Calendar value={date} onChange={(e) => e.value && setDate(e.value as Date)} dateFormat="dd.mm.yy" className="flex-1 min-w-0" />
        </div>
        <InputText value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="w-full" />

        {error && <Message severity="error" text={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text onClick={onHide} disabled={saving} />
          <Button label={editing ? 'Save' : 'Add'} severity="success" loading={saving} onClick={save} />
        </div>
      </div>
    </Dialog>
  );
}
