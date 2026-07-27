'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { SelectButton } from 'primereact/selectbutton';
import { Calendar } from 'primereact/calendar';
import { Checkbox } from 'primereact/checkbox';
import { MdSave, MdClose } from 'react-icons/md';
import { useToast } from '@/components/providers/toast-provider';
import { CURRENCIES } from '@/lib/constants';
import { createGoal, updateGoal } from '@/lib/actions/goals';
import { goalSchema, type GoalFormData } from '@/lib/schemas/goal.schema';
import type { FinancialAccount, Goal } from '@/types';

const TRACKING_OPTIONS = [
  { label: 'Account balance', value: 'account-balance' },
  { label: 'Net worth', value: 'net-worth' },
  { label: 'Manual', value: 'manual' },
];

const GOAL_TYPE_OPTIONS = [
  { label: 'Keep as reserve', value: 'reserve' },
  { label: 'Spend at target', value: 'spend' },
];

const yearMonthToDate = (ym: string | undefined): Date | null =>
  ym && /^\d{4}-\d{2}$/.test(ym) ? new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(5, 7)) - 1, 1) : null;
const dateToYearMonth = (d: Date | null | undefined): string =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';

export function GoalDialog({
  visible,
  goal,
  accounts,
  onHide,
  onSaved,
}: {
  visible: boolean;
  // null → create; set → edit.
  goal: Goal | null;
  accounts: FinancialAccount[];
  onHide: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [isSaving, setIsSaving] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<GoalFormData>({
    resolver: zodResolver(goalSchema),
    defaultValues: {
      name: '',
      description: '',
      targetAmount: 0,
      currency: 'EUR',
      targetDate: '',
      trackingMethod: 'account-balance',
      linkedAccountId: '',
      currentManualAmount: 0,
      goalType: 'reserve',
      priority: null,
      injectIntoCashflow: false,
    },
  });

  const trackingMethod = watch('trackingMethod');
  const goalType = watch('goalType');
  const targetDate = watch('targetDate');

  useEffect(() => {
    if (visible) {
      reset({
        name: goal?.name ?? '',
        description: goal?.description ?? '',
        targetAmount: goal?.targetAmount ?? 0,
        currency: goal?.currency ?? accounts.find((a) => !a.isArchived)?.currency ?? 'EUR',
        targetDate: goal?.targetDate ?? '',
        trackingMethod: goal?.trackingMethod ?? 'account-balance',
        linkedAccountId: goal?.linkedAccountId ?? '',
        currentManualAmount: goal?.currentManualAmount ?? 0,
        goalType: goal?.goalType ?? 'reserve',
        priority: goal?.priority ?? null,
        injectIntoCashflow: goal?.injectIntoCashflow ?? false,
      });
    }
  }, [visible, goal, accounts, reset]);

  // The inject checkbox only applies to a spend goal, tracked against an
  // account balance, with a target date set — hide it otherwise so the form
  // never shows a control the schema would reject.
  const canInject = goalType === 'spend' && trackingMethod === 'account-balance' && !!targetDate;

  const accountOptions = accounts
    .filter((a) => !a.isArchived || a.id === goal?.linkedAccountId)
    .map((a) => ({ label: a.isArchived ? `${a.name} (archived)` : a.name, value: a.id }));

  const handleSave = async (data: GoalFormData) => {
    setIsSaving(true);
    try {
      const payload = {
        name: data.name,
        description: data.description || undefined,
        targetAmount: data.targetAmount,
        currency: data.currency,
        targetDate: data.targetDate || undefined,
        trackingMethod: data.trackingMethod,
        linkedAccountId: data.trackingMethod === 'account-balance' ? data.linkedAccountId || undefined : undefined,
        currentManualAmount: data.trackingMethod === 'manual' ? data.currentManualAmount ?? 0 : undefined,
        goalType: data.goalType,
        // Explicit null (never undefined) so a cleared priority actually clears
        // the stored value — undefined is dropped by server-action serialization.
        priority: data.priority ?? null,
        injectIntoCashflow: data.goalType === 'spend' && data.trackingMethod === 'account-balance' && !!data.targetDate
          ? !!data.injectIntoCashflow
          : false,
      };
      const result = goal ? await updateGoal(goal.id, payload) : await createGoal(payload);
      if (result.success) {
        toast.success(goal ? 'Goal updated' : 'Goal created', data.name);
        onSaved();
        onHide();
      } else {
        toast.error('Error', result.error || 'Failed to save goal');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button label="Cancel" icon={<MdClose />} severity="secondary" text onClick={onHide} disabled={isSaving} />
      <Button label={goal ? 'Save' : 'Create goal'} icon={<MdSave />} onClick={handleSubmit(handleSave)} loading={isSaving} />
    </div>
  );

  return (
    <Dialog
      header={goal ? 'Edit goal' : 'New goal'}
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: '30rem' }}
      modal
      closable
      draggable={false}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="goal-name" className="block text-sm font-medium mb-1">Name</label>
          <Controller
            name="name"
            control={control}
            render={({ field }) => (
              <InputText id="goal-name" value={field.value} onChange={(e) => field.onChange(e.target.value)} className="w-full" placeholder="e.g. Emergency fund" />
            )}
          />
          {errors.name && <small className="text-red-500">{errors.name.message}</small>}
        </div>

        <div>
          <label htmlFor="goal-description" className="block text-sm font-medium mb-1">Description <span className="opacity-50">(optional)</span></label>
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <InputText id="goal-description" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} className="w-full" />
            )}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="goal-target" className="block text-sm font-medium mb-1">Target amount</label>
            <Controller
              name="targetAmount"
              control={control}
              render={({ field }) => (
                <InputNumber
                  inputId="goal-target"
                  value={field.value}
                  onValueChange={(e) => field.onChange(e.value ?? 0)}
                  mode="decimal"
                  locale="fi-FI"
                  minFractionDigits={0}
                  maxFractionDigits={2}
                  className="w-full"
                />
              )}
            />
            {errors.targetAmount && <small className="text-red-500">{errors.targetAmount.message}</small>}
          </div>
          <div>
            <label htmlFor="goal-currency" className="block text-sm font-medium mb-1">Currency</label>
            <Controller
              name="currency"
              control={control}
              render={({ field }) => (
                <Dropdown
                  inputId="goal-currency"
                  value={field.value}
                  onChange={(e) => field.onChange(e.value)}
                  options={CURRENCIES.map((c) => ({ label: `${c.value} — ${c.label}`, value: c.value }))}
                  className="w-full"
                />
              )}
            />
          </div>
        </div>

        <div>
          <label htmlFor="goal-target-date" className="block text-sm font-medium mb-1">Target date <span className="opacity-50">(optional)</span></label>
          <Controller
            name="targetDate"
            control={control}
            render={({ field }) => (
              <Calendar
                inputId="goal-target-date"
                value={yearMonthToDate(field.value)}
                onChange={(e) => field.onChange(dateToYearMonth(e.value as Date | null))}
                view="month"
                dateFormat="mm/yy"
                className="w-full"
                showButtonBar
              />
            )}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Track against</label>
          <Controller
            name="trackingMethod"
            control={control}
            render={({ field }) => (
              <SelectButton
                value={field.value}
                onChange={(e) => { if (e.value) field.onChange(e.value); }}
                options={TRACKING_OPTIONS}
                className="w-full"
              />
            )}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Goal type</label>
          <Controller
            name="goalType"
            control={control}
            render={({ field }) => (
              <SelectButton
                value={field.value ?? 'reserve'}
                onChange={(e) => { if (e.value) field.onChange(e.value); }}
                options={GOAL_TYPE_OPTIONS}
                className="w-full"
              />
            )}
          />
          <p className="text-xs opacity-50 mt-1">
            A reserve is money you set aside and keep; a spend goal is an amount you plan to actually spend at the target date.
          </p>
        </div>

        {trackingMethod === 'account-balance' && (
          <div>
            <label htmlFor="goal-account" className="block text-sm font-medium mb-1">Account</label>
            <Controller
              name="linkedAccountId"
              control={control}
              render={({ field }) => (
                <Dropdown
                  inputId="goal-account"
                  value={field.value || null}
                  onChange={(e) => field.onChange(e.value ?? '')}
                  options={accountOptions}
                  placeholder="Select an account"
                  className="w-full"
                />
              )}
            />
            {errors.linkedAccountId && <small className="text-red-500">{errors.linkedAccountId.message}</small>}
          </div>
        )}

        {canInject && (
          <div className="flex items-start gap-2">
            <Controller
              name="injectIntoCashflow"
              control={control}
              render={({ field }) => (
                <Checkbox inputId="goal-inject" checked={!!field.value} onChange={(e) => field.onChange(!!e.checked)} />
              )}
            />
            <label htmlFor="goal-inject" className="text-sm">
              Add the target amount as a read-only expense in the linked account&apos;s cashflow at the target month.
            </label>
          </div>
        )}

        <div>
          <label htmlFor="goal-priority" className="block text-sm font-medium mb-1">Priority <span className="opacity-50">(optional)</span></label>
          <Controller
            name="priority"
            control={control}
            render={({ field }) => (
              <InputNumber
                inputId="goal-priority"
                value={field.value ?? null}
                onValueChange={(e) => field.onChange(e.value ?? null)}
                mode="decimal"
                min={1}
                max={999}
                showButtons
                className="w-full"
              />
            )}
          />
          <p className="text-xs opacity-50 mt-1">Lower = funded first; leave empty to order by target date.</p>
          {errors.priority && <small className="text-red-500">{errors.priority.message}</small>}
        </div>

        {trackingMethod === 'manual' && (
          <div>
            <label htmlFor="goal-manual" className="block text-sm font-medium mb-1">Current amount</label>
            <Controller
              name="currentManualAmount"
              control={control}
              render={({ field }) => (
                <InputNumber
                  inputId="goal-manual"
                  value={field.value ?? 0}
                  onValueChange={(e) => field.onChange(e.value ?? 0)}
                  mode="decimal"
                  locale="fi-FI"
                  minFractionDigits={0}
                  maxFractionDigits={2}
                  className="w-full"
                />
              )}
            />
          </div>
        )}

        <p className="text-xs opacity-50">
          Progress is shown in the goal&apos;s currency; amounts from accounts in other currencies are not converted.
        </p>
      </div>
    </Dialog>
  );
}
