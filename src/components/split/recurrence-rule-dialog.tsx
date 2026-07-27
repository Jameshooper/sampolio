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
import { createSplitRecurrenceRule, updateSplitRecurrenceRule } from '@/lib/actions/split-groups';
import { toCents } from '@/lib/split-utils';
import { SPLIT_CATEGORIES, SPLIT_INTERVALS } from '@/lib/constants';
import { SplitEditor, emptyDraft, draftFromSpec, resolveDraftSpec, type SplitDraft } from './split-editor';
import type { Currency, SplitGroupMember, SplitRecurrenceRule } from '@/types';

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function RecurrenceRuleDialog({
  visible,
  onHide,
  groupId,
  members,
  currency,
  myId,
  rule,
  onSaved,
}: {
  visible: boolean;
  onHide: () => void;
  groupId: string;
  members: SplitGroupMember[];
  currency: Currency;
  myId: string;
  rule?: SplitRecurrenceRule;
  onSaved: () => void;
}) {
  const isMobile = useIsMobile();
  const editing = !!rule;
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [category, setCategory] = useState('General');
  const [draft, setDraft] = useState<SplitDraft>(() => emptyDraft(myId));
  const [interval, setInterval] = useState('monthly');
  const [anchorDate, setAnchorDate] = useState<Date>(new Date());
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    if (rule) {
      setTitle(rule.title);
      setAmount(rule.amountCents / 100);
      setCategory(rule.category);
      setDraft(draftFromSpec(rule.split, myId, members));
      setInterval(rule.interval);
      setAnchorDate(new Date(rule.anchorDate));
      setEndDate(rule.endDate ? new Date(rule.endDate) : null);
    } else {
      setTitle('');
      setAmount(null);
      setCategory('General');
      setDraft(emptyDraft(myId));
      setInterval('monthly');
      setAnchorDate(new Date());
      setEndDate(null);
    }
    setError('');
  }, [visible, rule, myId, members]);

  const save = async () => {
    if (!title.trim()) return setError('Add a description');
    if (!amount || amount <= 0) return setError('Add an amount');
    if (endDate && isoFromDate(endDate) < isoFromDate(anchorDate)) return setError('End date must be on or after the start');
    const { spec, error: splitError } = resolveDraftSpec(draft, members, toCents(amount), myId);
    if (!spec) return setError(splitError ?? 'Check the split');
    setSaving(true);
    setError('');
    const base = {
      title: title.trim(),
      category,
      amountCents: toCents(amount),
      split: spec,
      interval: interval as SplitRecurrenceRule['interval'],
      anchorDate: isoFromDate(anchorDate),
    };
    // On edit, endDate is tri-state: send null to clear it. On create, only
    // include the key when set (the create schema has no null).
    const res = editing
      ? await updateSplitRecurrenceRule(groupId, rule!.id, { ...base, endDate: endDate ? isoFromDate(endDate) : null })
      : await createSplitRecurrenceRule(groupId, { ...base, ...(endDate ? { endDate: isoFromDate(endDate) } : {}) });
    setSaving(false);
    if (!res.success) return setError(res.error ?? 'Failed to save');
    onSaved();
    onHide();
  };

  return (
    <Dialog
      header={editing ? 'Edit recurring expense' : 'New recurring expense'}
      visible={visible}
      onHide={onHide}
      maximized={isMobile}
      modal
      dismissableMask
      style={{ width: '28rem' }}
    >
      <div className="flex flex-col gap-3 pt-1">
        <InputText value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Rent, Internet" className="w-full" />
        <InputNumber
          value={amount}
          onValueChange={(e) => setAmount(e.value ?? null)}
          mode="currency"
          currency={currency}
          locale="fi-FI"
          placeholder="0,00"
          className="w-full"
          inputClassName="w-full text-xl font-semibold"
        />

        <SplitEditor
          members={members}
          myId={myId}
          currency={currency}
          amountCents={amount != null ? toCents(amount) : null}
          value={draft}
          onChange={setDraft}
        />

        <div className="flex items-center gap-2 border-t pt-3 border-gray-100 dark:border-gray-800">
          <span className="text-sm text-gray-500 w-20 shrink-0">Repeats</span>
          <Dropdown value={interval} onChange={(e) => setInterval(e.value)} options={SPLIT_INTERVALS} className="flex-1 min-w-0" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 w-20 shrink-0">Starting</span>
          <Calendar value={anchorDate} onChange={(e) => e.value && setAnchorDate(e.value as Date)} dateFormat="dd.mm.yy" className="flex-1 min-w-0" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 w-20 shrink-0">Ends</span>
          {/* No `e.value &&` guard — the Clear button sends null to stop the recurrence's end. */}
          <Calendar
            value={endDate}
            onChange={(e) => setEndDate((e.value as Date) ?? null)}
            dateFormat="dd.mm.yy"
            placeholder="Never"
            showButtonBar
            minDate={anchorDate}
            className="flex-1 min-w-0"
          />
        </div>
        <p className="text-xs text-gray-400 -mt-1 pl-[calc(5rem+0.5rem)]">Shortening the end date removes generated expenses after it.</p>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 w-20 shrink-0">Category</span>
          <Dropdown value={category} onChange={(e) => setCategory(e.value)} options={SPLIT_CATEGORIES.filter((c) => c !== 'Payment')} filter className="flex-1 min-w-0" />
        </div>
        {error && <Message severity="error" text={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text onClick={onHide} disabled={saving} />
          <Button label={editing ? 'Save' : 'Create'} severity="success" loading={saving} onClick={save} />
        </div>
      </div>
    </Dialog>
  );
}
