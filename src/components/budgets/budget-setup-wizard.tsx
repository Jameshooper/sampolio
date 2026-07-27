'use client';

import { useState, useMemo } from 'react';
import { Dialog } from 'primereact/dialog';
import { Steps } from 'primereact/steps';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { MultiSelect } from 'primereact/multiselect';
import { SelectButton } from 'primereact/selectbutton';
import { Checkbox } from 'primereact/checkbox';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { MdDelete } from 'react-icons/md';
import { MonthPicker, HelpTip } from '@/components/ui/form-primitives';
import { BUDGET_CATEGORIES, CURRENCIES, formatCurrency } from '@/lib/constants';
import { addMonths, getCurrentYearMonth, getMonthsBetween } from '@/lib/projection';
import { computeFeasibility, calcPerDiemTotal, getBudgetPeriodDays } from '@/lib/budget-utils';
import { getVerdict } from './budget-verdict-card';
import { BUDGET_TEMPLATES } from './budget-templates';
import { createBudget, addBudgetLine, addBudgetFundingSource } from '@/lib/actions/budgets';
import type { Budget, BudgetFundingType, Currency } from '@/types';

const STEPS = [
  { label: 'The plan' },
  { label: 'What it costs' },
  { label: "Who's paying" },
  { label: 'Does it add up?' },
];

const KIND_OPTIONS = [
  { label: 'Every month', value: 'monthly' },
  { label: 'Just once', value: 'one-off' },
];

interface LineDraft {
  name: string;
  category: string;
  amount: number;
  kind: 'monthly' | 'one-off';
}

interface FundingDraft {
  type: BudgetFundingType;
  name: string;
  amount: number;
  restricted: string[];
  rate: number;
  days: number;
}

export function BudgetSetupWizard({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (b: Budget) => void;
}) {
  const defaultStart = addMonths(getCurrentYearMonth(), 1);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [startMonth, setStartMonth] = useState(defaultStart);
  const [endMonth, setEndMonth] = useState(addMonths(defaultStart, 1));
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [funding, setFunding] = useState<FundingDraft[]>([]);
  const [includeIncome, setIncludeIncome] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const monthCount = Math.max(1, getMonthsBetween(startMonth, endMonth) + 1);

  // The drafts that actually count (empty rows are fine to leave behind).
  const realLines = lines.filter(l => l.name && l.amount > 0);
  const realFunding = funding.filter(f => (f.type === 'per-diem' ? f.rate > 0 && f.days > 0 : f.name && f.amount > 0));

  // Run the real engine on a synthetic budget for the live preview.
  const preview = useMemo(() => {
    const budget: Budget = {
      id: 'preview',
      userId: '',
      name: name || 'Preview',
      currency,
      startMonth,
      endMonth: endMonth >= startMonth ? endMonth : startMonth,
      status: 'draft',
      isArchived: false,
      includeRegularIncome: includeIncome,
      lines: realLines.map((l, i) => ({ id: String(i), ...l })),
      fundingSources: realFunding.map((f, i) => ({
        id: String(i),
        name: f.name || (f.type === 'per-diem' ? 'Daily allowance' : 'Funding'),
        type: f.type,
        amount: f.type === 'per-diem' ? calcPerDiemTotal(f.rate, f.days) : f.amount,
        restrictedToCategories: f.type === 'grant' && f.restricted.length > 0 ? f.restricted : undefined,
        timing: f.type === 'per-diem' ? 'monthly' : 'upfront',
        perDiemRate: f.type === 'per-diem' ? f.rate : undefined,
        perDiemDays: f.type === 'per-diem' ? f.days : undefined,
      })),
      expenseEntries: [],
      createdAt: '',
      updatedAt: '',
    };
    return { budget, feasibility: computeFeasibility(budget) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, currency, startMonth, endMonth, includeIncome, JSON.stringify(realLines), JSON.stringify(realFunding)]);

  const periodDays = useMemo(
    () => getBudgetPeriodDays(preview.budget),
    [preview.budget]
  );

  const addTemplate = (t: { name: string; category: string; kind: 'monthly' | 'one-off' }) =>
    setLines(prev => [...prev, { ...t, amount: 0 }]);

  const addFundingDraft = (type: BudgetFundingType) =>
    setFunding(prev => [...prev, { type, name: '', amount: 0, restricted: [], rate: 0, days: periodDays }]);

  const updateLine = (i: number, patch: Partial<LineDraft>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const updateFunding = (i: number, patch: Partial<FundingDraft>) =>
    setFunding(prev => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  const usedTemplates = new Set(lines.map(l => l.name));

  const reset = () => {
    setStep(0); setName(''); setDestination(''); setCurrency('EUR');
    setStartMonth(defaultStart); setEndMonth(addMonths(defaultStart, 1));
    setLines([]); setFunding([]); setIncludeIncome(true); setError('');
  };

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      const created = await createBudget({
        name, destination: destination || undefined, currency, startMonth, endMonth,
        includeRegularIncome: includeIncome,
      });
      if (!created.success || !created.data) {
        setError(created.error ?? 'Failed to create the budget');
        setSaving(false);
        return;
      }
      const budgetId = created.data.id;
      let latest: Budget = created.data;
      for (const l of realLines) {
        const res = await addBudgetLine(budgetId, { name: l.name, category: l.category, amount: l.amount, kind: l.kind, month: l.kind === 'one-off' ? startMonth : undefined });
        if (res.success && res.data) latest = res.data;
      }
      for (const f of realFunding) {
        const res = await addBudgetFundingSource(budgetId, {
          name: f.name || (f.type === 'per-diem' ? 'Daily allowance' : 'Funding'),
          type: f.type,
          amount: f.type === 'per-diem' ? undefined : f.amount,
          restrictedToCategories: f.type === 'grant' && f.restricted.length > 0 ? f.restricted : undefined,
          timing: f.type === 'per-diem' ? 'monthly' : 'upfront',
          perDiemRate: f.type === 'per-diem' ? f.rate : undefined,
          perDiemDays: f.type === 'per-diem' ? f.days : undefined,
        });
        if (res.success && res.data) latest = res.data;
      }
      setSaving(false);
      reset();
      onCreated(latest);
    } catch {
      setSaving(false);
      setError('Something went wrong — please try again');
    }
  };

  const canNext = () => {
    if (step === 0) return !!name && endMonth >= startMonth;
    return true;
  };

  const verdict = getVerdict(preview.budget, preview.feasibility);

  return (
    <Dialog header="Plan a budget" visible={visible} onHide={onClose} style={{ width: '40rem' }} maximizable>
      <Steps model={STEPS} activeIndex={step} readOnly className="mb-4" />

      {step === 0 && (
        <div className="space-y-3">
          <Message severity="info" text="A trip, a project, anything with a start and an end. Rough numbers are fine — you can change everything later." />
          <div>
            <label className="text-sm font-medium">What&apos;s the plan?</label>
            <InputText value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Research trip abroad" className="w-full" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium">Where? <span className="opacity-50 font-normal">(optional)</span></label>
            <InputText value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Stockholm" className="w-full" />
            <HelpTip text="Just a label — leave empty if this isn't a trip." />
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
          {endMonth < startMonth && <Message severity="warn" text="The end can't be before the start." />}
          <div>
            <label className="text-sm font-medium">Currency</label>
            <Dropdown
              value={currency}
              options={CURRENCIES.map((c) => ({ label: `${c.symbol} ${c.label}`, value: c.value }))}
              onChange={(e) => setCurrency(e.value)}
              className="w-full"
            />
            <HelpTip text="The currency you'll mostly spend in." />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <Message severity="info" text="What will it cost? Tap a few suggestions and fill in the amounts — or skip this and add costs later." />
          <div className="flex flex-wrap gap-2">
            {BUDGET_TEMPLATES.map(t => (
              <Button
                key={t.name}
                label={`+ ${t.name}`}
                outlined
                size="small"
                className={`!py-1 !px-2 !text-xs ${usedTemplates.has(t.name) ? 'opacity-40' : ''}`}
                onClick={() => addTemplate(t)}
              />
            ))}
          </div>
          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="p-2 rounded-lg surface-ground">
                <div className="flex flex-wrap gap-2 items-center">
                  <InputText value={line.name} onChange={(e) => updateLine(i, { name: e.target.value })} placeholder="What is it?" className="flex-1 min-w-32" />
                  <InputNumber value={line.amount || null} onValueChange={(e) => updateLine(i, { amount: e.value ?? 0 })} mode="currency" currency={currency} locale="fi-FI" placeholder="Amount" inputClassName="w-28" autoFocus={i === lines.length - 1 && !line.amount} />
                  <SelectButton value={line.kind} options={KIND_OPTIONS} onChange={(e) => e.value && updateLine(i, { kind: e.value })} allowEmpty={false} />
                  <Button icon={<MdDelete />} text severity="danger" size="small" onClick={() => setLines(prev => prev.filter((_, idx) => idx !== i))} />
                </div>
                {line.kind === 'monthly' && line.amount > 0 && (
                  <p className="text-xs opacity-60 mt-1">
                    {formatCurrency(line.amount, currency)} × {monthCount} months = {formatCurrency(line.amount * monthCount, currency)}
                  </p>
                )}
              </div>
            ))}
          </div>
          <Button label="+ Add another" text size="small" onClick={() => setLines(prev => [...prev, { name: '', category: 'Other', amount: 0, kind: 'one-off' }])} />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <Message severity="info" text="Who's paying? Add grants or allowances — or skip this and add them later." />
          <div className="flex flex-wrap gap-2">
            <Button label="+ A grant or stipend" outlined size="small" className="!py-1 !px-2 !text-xs" onClick={() => addFundingDraft('grant')} />
            <Button label="+ A daily allowance" outlined size="small" className="!py-1 !px-2 !text-xs" onClick={() => addFundingDraft('per-diem')} />
            <Button label="+ Something else" outlined size="small" className="!py-1 !px-2 !text-xs" onClick={() => addFundingDraft('other')} />
          </div>
          <div className="space-y-2">
            {funding.map((f, i) => (
              <div key={i} className="p-3 rounded-lg surface-ground space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold opacity-60">
                    {f.type === 'grant' ? 'Grant or stipend' : f.type === 'per-diem' ? 'Daily allowance' : 'Other money'}
                  </span>
                  <Button icon={<MdDelete />} text severity="danger" size="small" onClick={() => setFunding(prev => prev.filter((_, idx) => idx !== i))} />
                </div>
                {f.type === 'per-diem' ? (
                  <div>
                    <div className="flex flex-wrap gap-2">
                      <InputNumber value={f.rate || null} onValueChange={(e) => updateFunding(i, { rate: e.value ?? 0 })} mode="currency" currency={currency} locale="fi-FI" placeholder="Per day" inputClassName="w-28" />
                      <span className="self-center text-sm opacity-60">×</span>
                      <InputNumber value={f.days || null} onValueChange={(e) => updateFunding(i, { days: e.value ?? 0 })} placeholder="Days" inputClassName="w-20" />
                      <span className="self-center text-sm opacity-60">days</span>
                    </div>
                    {f.rate > 0 && f.days > 0 && (
                      <p className="text-sm font-semibold mt-1">
                        {formatCurrency(f.rate, currency)} × {f.days} days = {formatCurrency(calcPerDiemTotal(f.rate, f.days), currency)}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <InputText value={f.name} onChange={(e) => updateFunding(i, { name: e.target.value })} placeholder={f.type === 'grant' ? 'e.g. Research foundation grant' : 'e.g. Savings I’ll use'} className="flex-1 min-w-40" />
                    <InputNumber value={f.amount || null} onValueChange={(e) => updateFunding(i, { amount: e.value ?? 0 })} mode="currency" currency={currency} locale="fi-FI" placeholder="Total" inputClassName="w-32" />
                  </div>
                )}
                {f.type === 'grant' && (
                  <div>
                    <label className="text-xs font-medium opacity-70">What is it allowed to pay for?</label>
                    <MultiSelect
                      value={f.restricted}
                      options={BUDGET_CATEGORIES}
                      onChange={(e) => updateFunding(i, { restricted: e.value })}
                      placeholder="Anything"
                      display="chip"
                      className="w-full"
                    />
                    <HelpTip text="Leave empty if the grant can pay for anything." />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-start gap-2 pt-2 border-t surface-border">
            <Checkbox inputId="inc-income" checked={includeIncome} onChange={(e) => setIncludeIncome(!!e.checked)} className="mt-0.5" />
            <div>
              <label htmlFor="inc-income" className="text-sm">Count my normal income during these months</label>
              <HelpTip text="Your salary keeps arriving while you're away. It's shown for context on the budget page — untick to keep the trip and your normal money fully separate." />
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <div className="p-4 rounded-lg surface-ground">
            <p className="text-lg font-semibold">{verdict.sentence}</p>
            {verdict.subline && <p className="text-sm opacity-70 mt-1">{verdict.subline}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg surface-ground space-y-1">
              <p className="text-xs font-semibold opacity-60 mb-1">Costs · {formatCurrency(preview.feasibility.totalCosts, currency)}</p>
              {realLines.length === 0 && <p className="opacity-50">None yet</p>}
              {realLines.map((l, i) => (
                <div key={i} className="flex justify-between">
                  <span className="truncate">{l.name}</span>
                  <span className="whitespace-nowrap ml-2">{formatCurrency(l.amount, currency)}{l.kind === 'monthly' ? '/mo' : ''}</span>
                </div>
              ))}
            </div>
            <div className="p-3 rounded-lg surface-ground space-y-1">
              <p className="text-xs font-semibold opacity-60 mb-1">Money coming in · {formatCurrency(preview.feasibility.usableFunding, currency)}</p>
              {realFunding.length === 0 && <p className="opacity-50">None yet</p>}
              {realFunding.map((f, i) => (
                <div key={i} className="flex justify-between">
                  <span className="truncate">{f.name || (f.type === 'per-diem' ? 'Daily allowance' : 'Funding')}</span>
                  <span className="whitespace-nowrap ml-2">{formatCurrency(f.type === 'per-diem' ? calcPerDiemTotal(f.rate, f.days) : f.amount, currency)}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="text-xs opacity-60">Nothing goes into your cashflow yet — you&apos;ll get a button for that when you&apos;re ready.</p>
        </div>
      )}

      {error && <Message severity="error" text={error} className="mt-3 w-full" />}

      <div className="flex justify-between mt-4">
        <Button label="Back" text onClick={() => setStep(s => Math.max(0, s - 1))} disabled={step === 0 || saving} />
        {step < STEPS.length - 1 ? (
          <Button label="Next" onClick={() => setStep(s => s + 1)} disabled={!canNext()} />
        ) : (
          <Button label="Create budget" loading={saving} onClick={submit} />
        )}
      </div>
    </Dialog>
  );
}
