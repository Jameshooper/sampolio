'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { MultiSelect } from 'primereact/multiselect';
import { SelectButton } from 'primereact/selectbutton';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { MdAdd } from 'react-icons/md';
import { MonthPicker, HelpTip } from '@/components/ui/form-primitives';
import { TripDialog } from '@/components/trips/trip-dialog';
import { BUDGET_CATEGORIES, CURRENCIES, formatCurrency } from '@/lib/constants';
import { getMonthsBetween } from '@/lib/projection';
import { calcPerDiemTotal, getBudgetPeriodDays } from '@/lib/budget-utils';
import { calculatePerDiem } from '@/lib/per-diem-utils';
import { budgetDetailsSchema, budgetLineSchema, budgetFundingSchema } from '@/lib/schemas/budget.schema';
import type { TripFormData } from '@/lib/schemas/trip.schema';
import {
  addBudgetLine,
  updateBudgetLine,
  addBudgetFundingSource,
  updateBudgetFundingSource,
  updateBudget,
} from '@/lib/actions/budgets';
import { getMySplitGroups } from '@/lib/actions/split-groups';
import { getTrips } from '@/lib/actions/trips';
import type { Budget, BudgetLine, BudgetFundingSource, BudgetFundingType, BudgetFundingTiming, Currency, FinancialAccount, SplitGroup, Trip } from '@/types';

const PER_DIEM_SOURCE_OPTIONS = [
  { label: 'From a trip', value: 'trip' },
  { label: 'Manual rate × days', value: 'manual' },
];

const KIND_OPTIONS = [
  { label: 'Every month', value: 'monthly' },
  { label: 'Just once', value: 'one-off' },
];

const TIMING_OPTIONS = [
  { label: 'At the start of the trip', value: 'upfront' },
  { label: 'A bit every month', value: 'monthly' },
  { label: 'In a specific month', value: 'specific-month' },
];

const FUNDING_TYPE_OPTIONS = [
  { label: 'Grant or stipend', value: 'grant' },
  { label: 'Daily allowance', value: 'per-diem' },
  { label: 'Something else', value: 'other' },
];

// ── Cost line ────────────────────────────────────────────────────────────────

export function BudgetLineDialog({
  visible,
  budget,
  line,
  prefill,
  onHide,
  onSaved,
}: {
  visible: boolean;
  budget: Budget;
  line: BudgetLine | null; // null = create
  prefill?: { name: string; category: string; kind: 'monthly' | 'one-off' } | null; // template defaults when creating
  onHide: () => void;
  onSaved: (b: Budget) => void;
}) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Other');
  const [amount, setAmount] = useState<number | null>(null);
  const [kind, setKind] = useState<'monthly' | 'one-off'>('monthly');
  const [month, setMonth] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Re-seed the form when the dialog opens. Derive-during-render (not an
  // effect) so there's no cascading render — same pattern as the mortgage
  // reconcile dialog.
  if (visible && !seeded) {
    setSeeded(true);
    setName(line?.name ?? prefill?.name ?? '');
    setCategory(line?.category ?? prefill?.category ?? 'Other');
    setAmount(line?.amount ?? null);
    setKind(line?.kind ?? prefill?.kind ?? 'monthly');
    setMonth(line?.month ?? budget.startMonth);
    setError('');
  }
  if (!visible && seeded) setSeeded(false);

  const monthCount = getMonthsBetween(budget.startMonth, budget.endMonth) + 1;

  const submit = async () => {
    setError('');
    const parsed = budgetLineSchema.safeParse({
      name,
      category,
      amount: amount ?? undefined,
      kind,
      month: kind === 'one-off' ? month || undefined : undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }
    setSaving(true);
    const res = line
      ? await updateBudgetLine(budget.id, line.id, parsed.data)
      : await addBudgetLine(budget.id, parsed.data);
    setSaving(false);
    if (res.success && res.data) {
      onSaved(res.data);
      onHide();
    } else {
      setError(res.error ?? 'Something went wrong');
    }
  };

  return (
    <Dialog header={line ? 'Edit cost' : 'Add a cost'} visible={visible} onHide={onHide} style={{ width: '26rem' }}>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">What is it?</label>
          <InputText value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent" className="w-full" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Amount</label>
            <InputNumber value={amount} onValueChange={(e) => setAmount(e.value ?? null)} mode="currency" currency={budget.currency} locale="fi-FI" className="w-full" />
          </div>
          <div>
            <label className="text-sm font-medium">Category</label>
            <Dropdown value={category} options={BUDGET_CATEGORIES} onChange={(e) => setCategory(e.value)} className="w-full" />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">How often?</label>
          <SelectButton value={kind} options={KIND_OPTIONS} onChange={(e) => e.value && setKind(e.value)} allowEmpty={false} className="w-full" />
          {kind === 'monthly' && (amount ?? 0) > 0 && (
            <HelpTip text={`${formatCurrency(amount!, budget.currency)} × ${monthCount} months = ${formatCurrency(amount! * monthCount, budget.currency)}`} />
          )}
        </div>
        {kind === 'one-off' && (
          <div>
            <label className="text-sm font-medium">Which month?</label>
            <MonthPicker value={month} onChange={setMonth} />
          </div>
        )}
        {error && <Message severity="error" text={error} className="w-full" />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text severity="secondary" onClick={onHide} disabled={saving} />
          <Button label={line ? 'Save' : 'Add cost'} loading={saving} onClick={submit} />
        </div>
      </div>
    </Dialog>
  );
}

// ── Funding source ───────────────────────────────────────────────────────────

export function BudgetFundingDialog({
  visible,
  budget,
  source,
  initialType,
  isSimple,
  accounts,
  tripToBudgetName,
  onHide,
  onSaved,
  onTripsChanged,
}: {
  visible: boolean;
  budget: Budget;
  source: BudgetFundingSource | null; // null = create
  initialType?: BudgetFundingType;
  isSimple: boolean;
  // Accounts for the inline "New trip" dialog's "reimburse to" picker.
  accounts: FinancialAccount[];
  // tripId → name of ANOTHER budget already funded by that trip (current
  // budget excluded). Those trips are shown disabled in the picker.
  tripToBudgetName?: Record<string, string>;
  onHide: () => void;
  onSaved: (b: Budget) => void;
  // Fired after a trip is created inline, so the page can refresh its own trip
  // list (used for the funding row's linked-trip label after saving).
  onTripsChanged?: () => void;
}) {
  const [type, setType] = useState<BudgetFundingType>('grant');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [restricted, setRestricted] = useState<string[]>([]);
  const [timing, setTiming] = useState<BudgetFundingTiming>('upfront');
  const [receivedMonth, setReceivedMonth] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [perDiemMode, setPerDiemMode] = useState<'trip' | 'manual'>('manual');
  const [tripId, setTripId] = useState<string | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);
  const [tripDialogOpen, setTripDialogOpen] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Per diems are EUR by definition — a trip can only fund a EUR budget.
  const eurBudget = budget.currency === 'EUR';

  // Prefill for a trip created inline from this budget. Memoized so its identity
  // is stable across renders (TripDialog resets its form when this changes).
  const tripInitial = useMemo<Partial<TripFormData>>(
    () => ({
      name: budget.name,
      linkedAccountId: budget.linkedAccountId || undefined,
      // Default the reimbursement inside the budget period; the user can still
      // change it in the trip form.
      expectedReimbursementMonth: budget.endMonth,
    }),
    [budget.name, budget.linkedAccountId, budget.endMonth]
  );

  // Re-seed on open, derive-during-render (see BudgetLineDialog).
  if (visible && !seeded) {
    setSeeded(true);
    setType(source?.type ?? initialType ?? 'grant');
    setName(source?.name ?? '');
    setAmount(source?.amount ?? null);
    setRestricted(source?.restrictedToCategories ?? []);
    setTiming(source?.timing ?? 'upfront');
    setReceivedMonth(source?.receivedMonth ?? budget.startMonth);
    setRate(source?.perDiemRate ?? null);
    setDays(source?.perDiemDays ?? getBudgetPeriodDays(budget));
    setPerDiemMode(source?.linkedTripId ? 'trip' : 'manual');
    setTripId(source?.linkedTripId ?? null);
    setTripsLoaded(false);
    setError('');
  }
  if (!visible && seeded) setSeeded(false);

  // Load the user's trips when the dialog opens (for the trip picker).
  useEffect(() => {
    if (!visible) return;
    let active = true;
    (async () => {
      const res = await getTrips();
      if (!active) return;
      if (res.success && res.data) setTrips(res.data);
      setTripsLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, [visible]);

  // Effective per-diem mode: a non-EUR budget can never use trip mode.
  const effectiveMode = eurBudget ? perDiemMode : 'manual';
  const isTripLinked = type === 'per-diem' && effectiveMode === 'trip';

  const perDiemTotal = calcPerDiemTotal(rate ?? 0, days ?? 0);
  const selectedTrip = tripId ? trips.find((t) => t.id === tripId) ?? null : null;
  const selectedTripTotal = selectedTrip ? calculatePerDiem(selectedTrip).total : null;

  const tripOptions = trips.map((t) => {
    const takenBy = tripToBudgetName?.[t.id]; // another budget already funded by it
    return {
      label: `${t.name} — ${formatCurrency(calculatePerDiem(t).total, 'EUR')}${takenBy ? ` (funds ${takenBy})` : ''}`,
      value: t.id,
      disabled: !!takenBy,
    };
  });

  const onSelectTrip = (id: string) => {
    setTripId(id);
    const trip = trips.find((t) => t.id === id);
    if (!trip) return;
    if (!name.trim()) setName(`Per diem: ${trip.name}`);
    setTiming('specific-month');
    setReceivedMonth(trip.expectedReimbursementMonth);
  };

  // A trip was just created inline: add it to the local list, auto-select it
  // (same side effects as picking it in the dropdown), close the trip dialog,
  // and let the page refresh its own trip list.
  const handleTripCreated = (trip: Trip) => {
    setTrips((prev) => (prev.some((t) => t.id === trip.id) ? prev : [...prev, trip]));
    setTripId(trip.id);
    if (!name.trim()) setName(`Per diem: ${trip.name}`);
    setTiming('specific-month');
    setReceivedMonth(trip.expectedReimbursementMonth);
    setTripDialogOpen(false);
    onTripsChanged?.();
  };

  const submit = async () => {
    setError('');
    if (isTripLinked && !tripId) {
      setError('Pick a trip to fund this allowance');
      return;
    }
    const parsed = budgetFundingSchema.safeParse({
      name,
      type,
      amount: type === 'per-diem' ? undefined : amount ?? undefined,
      restrictedToCategories: type === 'grant' && restricted.length > 0 ? restricted : undefined,
      timing,
      receivedMonth: timing === 'specific-month' ? receivedMonth || undefined : undefined,
      perDiemRate: type === 'per-diem' && !isTripLinked ? rate ?? undefined : undefined,
      perDiemDays: type === 'per-diem' && !isTripLinked ? days ?? undefined : undefined,
      linkedTripId: isTripLinked ? tripId ?? undefined : undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }
    setSaving(true);
    const res = source
      ? await updateBudgetFundingSource(budget.id, source.id, parsed.data)
      : await addBudgetFundingSource(budget.id, parsed.data);
    setSaving(false);
    if (res.success && res.data) {
      onSaved(res.data);
      onHide();
    } else {
      setError(res.error ?? 'Something went wrong');
    }
  };

  return (
    <>
    <Dialog header={source ? 'Edit funding' : 'Add funding'} visible={visible} onHide={onHide} style={{ width: '28rem' }}>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">What kind of money is it?</label>
          <Dropdown value={type} options={FUNDING_TYPE_OPTIONS} onChange={(e) => setType(e.value)} className="w-full" />
        </div>
        <div>
          <label className="text-sm font-medium">Name</label>
          <InputText
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'per-diem' ? 'e.g. Per diem allowance' : type === 'grant' ? 'e.g. Research foundation grant' : 'e.g. Savings I’ll use'}
            className="w-full"
          />
        </div>

        {type === 'per-diem' ? (
          <div className="space-y-3">
            {eurBudget ? (
              <SelectButton
                value={effectiveMode}
                options={PER_DIEM_SOURCE_OPTIONS}
                onChange={(e) => e.value && setPerDiemMode(e.value)}
                allowEmpty={false}
                className="w-full"
              />
            ) : (
              <p className="text-xs opacity-60">Per-diem trips are in euros — this budget uses {budget.currency}.</p>
            )}

            {isTripLinked ? (
              <div>
                <label className="text-sm font-medium">Which trip?</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Dropdown
                    value={tripId}
                    options={tripOptions}
                    optionDisabled="disabled"
                    onChange={(e) => e.value && onSelectTrip(e.value)}
                    placeholder={tripsLoaded ? 'Pick a trip' : 'Loading trips…'}
                    filter={trips.length > 6}
                    emptyMessage={tripsLoaded ? 'No trips yet — tap “New trip” to add one' : 'Loading…'}
                    className="w-full sm:flex-1"
                  />
                  <Button
                    type="button"
                    label="New trip"
                    icon={<MdAdd />}
                    outlined
                    size="small"
                    className="shrink-0 !min-h-[44px] whitespace-nowrap"
                    onClick={() => setTripDialogOpen(true)}
                  />
                </div>
                {selectedTripTotal !== null && (
                  <p className="text-sm font-semibold mt-2">Per diem: {formatCurrency(selectedTripTotal, 'EUR')}</p>
                )}
                <HelpTip text="The amount comes straight from the trip’s per-diem calculation and updates automatically if the trip changes. Need a trip? Tap “New trip” to create one without leaving this budget." />
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm font-medium">Per day</label>
                    <InputNumber value={rate} onValueChange={(e) => setRate(e.value ?? null)} mode="currency" currency={budget.currency} locale="fi-FI" className="w-full" />
                  </div>
                  <div>
                    <label className="text-sm font-medium">Days</label>
                    <InputNumber value={days} onValueChange={(e) => setDays(e.value ?? null)} className="w-full" />
                  </div>
                </div>
                {perDiemTotal > 0 && (
                  <p className="text-sm font-semibold mt-2">
                    {formatCurrency(rate ?? 0, budget.currency)} × {days} days = {formatCurrency(perDiemTotal, budget.currency)}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="text-sm font-medium">Total amount</label>
            <InputNumber value={amount} onValueChange={(e) => setAmount(e.value ?? null)} mode="currency" currency={budget.currency} locale="fi-FI" className="w-full" />
          </div>
        )}

        {type === 'grant' && (
          <div>
            <label className="text-sm font-medium">What is it allowed to pay for?</label>
            <MultiSelect
              value={restricted}
              options={BUDGET_CATEGORIES}
              onChange={(e) => setRestricted(e.value)}
              placeholder="Anything"
              display="chip"
              className="w-full"
            />
            <HelpTip text="Leave empty if the grant can pay for anything. If the foundation says “travel and accommodation only”, pick just those." />
          </div>
        )}

        {!isSimple && (
          <div>
            <label className="text-sm font-medium">When does the money arrive?</label>
            <Dropdown value={timing} options={TIMING_OPTIONS} onChange={(e) => setTiming(e.value)} className="w-full" />
            {timing === 'specific-month' && (
              <div className="mt-2">
                <MonthPicker value={receivedMonth} onChange={setReceivedMonth} />
              </div>
            )}
          </div>
        )}

        {error && <Message severity="error" text={error} className="w-full" />}
        <div className="flex justify-end gap-2 pt-1">
          <Button label="Cancel" text severity="secondary" onClick={onHide} disabled={saving} />
          <Button label={source ? 'Save' : 'Add funding'} loading={saving} onClick={submit} />
        </div>
      </div>
    </Dialog>

    {/* Create a trip without leaving the budget. Only mounted for EUR budgets
        (the only ones that can link a trip); stacks above this dialog. */}
    {eurBudget && (
      <TripDialog
        visible={tripDialogOpen}
        trip={null}
        accounts={accounts}
        initial={tripInitial}
        onHide={() => setTripDialogOpen(false)}
        onSaved={handleTripCreated}
      />
    )}
    </>
  );
}

// ── Budget details ───────────────────────────────────────────────────────────

export function BudgetDetailsDialog({
  visible,
  budget,
  onHide,
  onSaved,
}: {
  visible: boolean;
  budget: Budget;
  onHide: () => void;
  onSaved: (b: Budget) => void;
}) {
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [startMonth, setStartMonth] = useState('');
  const [endMonth, setEndMonth] = useState('');
  const [splitGroupId, setSplitGroupId] = useState(''); // '' = none
  const [splitGroups, setSplitGroups] = useState<SplitGroup[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Re-seed on open, derive-during-render (see BudgetLineDialog).
  if (visible && !seeded) {
    setSeeded(true);
    setName(budget.name);
    setDestination(budget.destination ?? '');
    setCurrency(budget.currency);
    setStartMonth(budget.startMonth);
    setEndMonth(budget.endMonth);
    setSplitGroupId(budget.linkedSplitGroupId ?? '');
    setError('');
  }
  if (!visible && seeded) setSeeded(false);

  // Load the user's split groups when the dialog opens (for the link dropdown).
  useEffect(() => {
    if (!visible) return;
    let active = true;
    (async () => {
      const res = await getMySplitGroups();
      if (active && res.success && res.data) setSplitGroups(res.data);
    })();
    return () => {
      active = false;
    };
  }, [visible]);

  // Only same-currency groups are linkable (share amounts are shown as-is).
  const splitGroupOptions = [
    { label: 'None', value: '' },
    ...splitGroups
      .filter(g => g.currency === currency)
      .map(g => ({ label: `${g.emoji ? g.emoji + ' ' : ''}${g.name}`, value: g.id })),
  ];
  // A currency change can invalidate the current pick — treat it as cleared.
  const effectiveSplitGroupId = splitGroupOptions.some(o => o.value === splitGroupId) ? splitGroupId : '';

  const submit = async () => {
    setError('');
    const parsed = budgetDetailsSchema.safeParse({
      name,
      destination,
      currency,
      startMonth,
      endMonth,
      linkedSplitGroupId: effectiveSplitGroupId,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the form');
      return;
    }
    setSaving(true);
    const res = await updateBudget(budget.id, parsed.data);
    setSaving(false);
    if (res.success && res.data) {
      onSaved(res.data);
      onHide();
    } else {
      setError(res.error ?? 'Something went wrong');
    }
  };

  return (
    <Dialog header="Edit details" visible={visible} onHide={onHide} style={{ width: '26rem' }}>
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Name</label>
          <InputText value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
        </div>
        <div>
          <label className="text-sm font-medium">Where? <span className="opacity-50 font-normal">(optional)</span></label>
          <InputText value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Stockholm" className="w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">From</label>
            <MonthPicker value={startMonth} onChange={setStartMonth} />
          </div>
          <div>
            <label className="text-sm font-medium">Until</label>
            <MonthPicker value={endMonth} onChange={setEndMonth} />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Currency</label>
          <Dropdown
            value={currency}
            options={CURRENCIES.map((c) => ({ label: `${c.symbol} ${c.label}`, value: c.value }))}
            onChange={(e) => setCurrency(e.value)}
            className="w-full"
          />
          <HelpTip text="The currency you’ll mostly spend in." />
        </div>
        <div>
          <label className="text-sm font-medium">Split group <span className="opacity-50 font-normal">(optional)</span></label>
          <Dropdown
            value={effectiveSplitGroupId}
            options={splitGroupOptions}
            onChange={(e) => setSplitGroupId(e.value ?? '')}
            className="w-full"
          />
          <HelpTip text="Show your share of a split group’s expenses next to the spending log — read-only, it never changes the budget math. Only groups in the budget’s currency can be linked." />
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
