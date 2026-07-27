'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { Calendar } from 'primereact/calendar';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { MdAdd } from 'react-icons/md';
import { useToast } from '@/components/providers/toast-provider';
import { useCelebration } from '@/components/providers/celebration-provider';
import { useIsMobile } from '@/lib/hooks/use-media-query';
import { getMySplitGroups, createSplitExpense, setDefaultSplitGroup } from '@/lib/actions/split-groups';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { toCents, guessCategory } from '@/lib/split-utils';
import { SPLIT_CATEGORIES } from '@/lib/constants';
import { SplitEditor, emptyDraft, resolveDraftSpec, type SplitDraft } from './split-editor';
import type { SplitGroup, SplitExpenseBankLink } from '@/types';

/** Optional prefill applied each time the dialog opens (e.g. "Split this" from
 * a bank transaction). Amount is in the selected group's currency. */
export interface QuickAddSplitInitial {
  title?: string;
  amount?: number;
  date?: string; // YYYY-MM-DD
  category?: string;
  /** Stamps the created expense with a pointer back to its source bank
   * transaction ("Split this"). `ownerUserId` is stamped server-side. */
  bankLink?: Omit<SplitExpenseBankLink, 'ownerUserId'>;
}

/** 'YYYY-MM-DD' → local Date (never UTC parsing — the day must not shift). */
function parseIsoDate(iso: string): Date | null {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

interface QuickAddSplitModalProps {
  visible: boolean;
  onHide: () => void;
  onSaved?: () => void;
  initial?: QuickAddSplitInitial;
}

/**
 * The fast "add a shared expense" path. Defaults to: your default group, you
 * paid, split equally, today — so a title + amount + Save is enough. The split
 * UI (presets + custom amounts/percentages + live preview) is the shared
 * <SplitEditor>, identical to the in-group add/edit dialogs.
 */
export function QuickAddSplitModal({ visible, onHide, onSaved, initial }: QuickAddSplitModalProps) {
  const isMobile = useIsMobile();
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const toast = useToast();
  const { celebrate } = useCelebration();
  const amountRef = useRef<HTMLInputElement>(null);

  const [groups, setGroups] = useState<SplitGroup[]>([]);
  const [groupId, setGroupId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [draft, setDraft] = useState<SplitDraft>(() => emptyDraft(myId));
  const [date, setDate] = useState<Date>(new Date());
  const [category, setCategory] = useState<string>('');
  const [bankLink, setBankLink] = useState<QuickAddSplitInitial['bankLink']>(undefined);
  const [defaultGroupId, setDefaultGroupId] = useState<string | undefined>(undefined);
  const [showMore, setShowMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load groups + default-group preference when opened.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    (async () => {
      const [g, prefs] = await Promise.all([getMySplitGroups(), getUserPreferences()]);
      if (!active) return;
      const list = g.success && g.data ? g.data : [];
      setGroups(list);
      const preferred = prefs.success ? prefs.data?.defaultSplitGroupId : undefined;
      setDefaultGroupId(preferred);
      setGroupId((cur) => cur || (preferred && list.some((x) => x.id === preferred) ? preferred : list[0]?.id ?? ''));
    })();
    return () => {
      active = false;
    };
  }, [visible]);

  // Reset transient fields each time the dialog opens (applying the optional
  // prefill, which is only read at open time — hence excluded from the deps).
  useEffect(() => {
    if (visible) {
      setTitle(initial?.title ?? '');
      setAmount(initial?.amount ?? null);
      setDraft(emptyDraft(myId));
      setDate(initial?.date ? parseIsoDate(initial.date) ?? new Date() : new Date());
      setCategory(initial?.category ?? '');
      setBankLink(initial?.bankLink);
      // Surface the prefilled date/category so the user sees what came along.
      setShowMore(!!(initial?.date || initial?.category));
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, myId]);

  // Switching groups can change the member set, so reset the split to the default.
  useEffect(() => {
    setDraft(emptyDraft(myId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  const group = useMemo(() => groups.find((g) => g.id === groupId), [groups, groupId]);
  const effectiveCategory = category || (title ? guessCategory(title) : 'General');

  const reset = () => {
    setTitle('');
    setAmount(null);
    setDraft(emptyDraft(myId));
    // A bank link is one-shot — "add another" starts a fresh, unlinked expense
    // rather than pointing a second row at the same source transaction.
    setBankLink(undefined);
    setError('');
    setTimeout(() => amountRef.current?.focus(), 60);
  };

  const save = async (addAnother: boolean) => {
    if (!group) {
      setError('Pick a group');
      return;
    }
    if (!title.trim()) {
      setError('Add a description');
      return;
    }
    if (!amount || amount <= 0) {
      setError('Add an amount');
      return;
    }
    const { spec, error: splitError } = resolveDraftSpec(draft, group.members, toCents(amount), myId);
    if (!spec) {
      setError(splitError ?? 'Check the split');
      return;
    }
    setSaving(true);
    setError('');
    const res = await createSplitExpense(group.id, {
      title: title.trim(),
      category: effectiveCategory,
      amountCents: toCents(amount),
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      split: spec,
      ...(bankLink ? { bankLink } : {}),
    });
    setSaving(false);
    if (!res.success) {
      setError(res.error ?? 'Failed to add');
      return;
    }
    // Preselect this group next time the modal opens; fire-and-forget so it
    // never delays the success toast below.
    if (group.id !== defaultGroupId) void setDefaultSplitGroup(group.id).catch(() => {});
    // Checkmark pop works for both Save and Save & add another (the dialog can
    // stay open); the toast is the reduced-motion feedback. No row flash here —
    // the created row isn't on this screen.
    celebrate('checkmark');
    onSaved?.();
    toast.success('Added', title.trim());
    if (addAnother) reset();
    else onHide();
  };

  const noGroups = visible && groups.length === 0;

  return (
    <>
      <Dialog
        header="Add expense"
        visible={visible}
        onHide={onHide}
        maximized={isMobile}
        modal
        dismissableMask
        style={{ width: '32rem' }}
        contentClassName="pt-2"
      >
        {noGroups ? (
          <div className="py-6 text-center text-gray-600 dark:text-gray-300">
            <p className="mb-3">You don&apos;t have a split group yet.</p>
            <Button label="Create a group" icon={<MdAdd />} onClick={onHide} link />
            <p className="text-sm text-gray-400 mt-1">Head to the Split tab to create one.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Group selector */}
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <span className="shrink-0">With you and:</span>
              <Dropdown
                value={groupId}
                onChange={(e) => setGroupId(e.value)}
                options={groups.map((g) => ({ label: `${g.emoji ? g.emoji + ' ' : ''}${g.name}`, value: g.id }))}
                className="flex-1 min-w-0"
              />
            </div>

            {/* Amount + description — the two essentials, amount first so the
                keyboard opens straight onto the number people care about most. */}
            <InputNumber
              inputRef={amountRef}
              value={amount}
              onValueChange={(e) => setAmount(e.value ?? null)}
              mode="currency"
              currency={group?.currency ?? 'EUR'}
              locale="fi-FI"
              placeholder="0,00"
              inputClassName="w-full text-2xl font-semibold"
              className="w-full"
              autoFocus
              inputMode="decimal"
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(false);
              }}
            />
            <InputText
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What was it for?"
              className="w-full text-lg"
            />

            {/* Split editor (presets + custom + live preview) */}
            {group && (
              <SplitEditor
                members={group.members}
                myId={myId}
                currency={group.currency}
                amountCents={amount != null ? toCents(amount) : null}
                value={draft}
                onChange={setDraft}
              />
            )}

            {/* More options */}
            {showMore ? (
              <div className="animate-fade-in flex flex-col gap-3 border-t pt-3 border-gray-100 dark:border-gray-800">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500 w-20 shrink-0">Date</span>
                  <Calendar value={date} onChange={(e) => e.value && setDate(e.value as Date)} dateFormat="dd.mm.yy" className="flex-1 min-w-0" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500 w-20 shrink-0">Category</span>
                  <Dropdown
                    value={effectiveCategory}
                    onChange={(e) => setCategory(e.value)}
                    options={SPLIT_CATEGORIES.filter((c) => c !== 'Payment')}
                    filter
                    className="flex-1 min-w-0"
                  />
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowMore(true)} className="text-sm text-gray-500 hover:underline self-start">
                More options (date, category)
              </button>
            )}

            {error && <Message severity="error" text={error} />}

            <div className="flex gap-2 pt-1">
              <Button label="Save" className="flex-1" loading={saving} onClick={() => save(false)} severity="success" />
              <Button label="Save & add another" outlined onClick={() => save(true)} disabled={saving} />
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
