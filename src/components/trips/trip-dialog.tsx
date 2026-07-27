'use client';

import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown } from 'primereact/dropdown';
import { Calendar } from 'primereact/calendar';
import { Panel } from 'primereact/panel';
import { MdSave, MdClose } from 'react-icons/md';
import { useToast } from '@/components/providers/toast-provider';
import { createTrip, updateTrip } from '@/lib/actions/trips';
import { tripSchema, type TripFormData } from '@/lib/schemas/trip.schema';
import { generateTripDays, calculatePerDiem } from '@/lib/per-diem-utils';
import { buildDefaultRateSnapshot, PER_DIEM_COUNTRIES_2026, DOMESTIC_COUNTRY_CODE } from '@/lib/per-diem-rates';
import { PerDiemBreakdown } from './per-diem-breakdown';
import type { FinancialAccount, Trip } from '@/types';

const DESTINATION_OPTIONS = [
  { label: 'Finland (domestic)', value: DOMESTIC_COUNTRY_CODE },
  ...PER_DIEM_COUNTRIES_2026.map((c) => ({ label: c.name, value: c.code })),
];

const STATUS_OPTIONS = [
  { label: 'Planned', value: 'planned' },
  { label: 'Completed', value: 'completed' },
  { label: 'Reimbursed', value: 'reimbursed' },
];

function countryName(code: string): string {
  if (code === DOMESTIC_COUNTRY_CODE) return 'Finland (domestic)';
  return PER_DIEM_COUNTRIES_2026.find((c) => c.code === code)?.name ?? code;
}

// 'YYYY-MM-DDTHH:mm' (local, no timezone) <-> Date, for PrimeReact's Calendar.
function localDateTimeToDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mi] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mi);
}
function dateToLocalDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${hh}:${mi}`;
}

const yearMonthToDate = (ym: string | undefined): Date | null =>
  ym && /^\d{4}-\d{2}$/.test(ym) ? new Date(parseInt(ym.slice(0, 4)), parseInt(ym.slice(5, 7)) - 1, 1) : null;
const dateToYearMonth = (d: Date | null | undefined): string =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '';

export function TripDialog({
  visible,
  trip,
  accounts,
  initial,
  onHide,
  onSaved,
}: {
  visible: boolean;
  // null → create; set → edit.
  trip: Trip | null;
  accounts: FinancialAccount[];
  // Optional prefill applied on CREATE only (ignored when editing an existing
  // trip). Memoize it in the parent — it feeds the reset effect's deps.
  initial?: Partial<TripFormData>;
  onHide: () => void;
  // Receives the created/updated trip so callers can act on it (e.g. the budget
  // funding dialog auto-selects a freshly created trip). Callers that don't need
  // it can pass a zero-arg callback.
  onSaved: (trip: Trip) => void;
}) {
  const toast = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [ratesCollapsed, setRatesCollapsed] = useState(true);
  const [reimbursementMonthTouched, setReimbursementMonthTouched] = useState(false);

  const {
    control,
    handleSubmit,
    reset,
    watch,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<TripFormData>({
    resolver: zodResolver(tripSchema),
    defaultValues: {
      name: '',
      destinationCountry: DOMESTIC_COUNTRY_CODE,
      startDateTime: '',
      endDateTime: '',
      days: [],
      rates: buildDefaultRateSnapshot(),
      expectedReimbursementMonth: '',
      linkedAccountId: '',
      status: 'planned',
      notes: '',
    },
  });

  useEffect(() => {
    if (!visible) return;
    reset({
      name: trip?.name ?? initial?.name ?? '',
      destinationCountry: trip?.destinationCountry ?? initial?.destinationCountry ?? DOMESTIC_COUNTRY_CODE,
      startDateTime: trip?.startDateTime ?? initial?.startDateTime ?? '',
      endDateTime: trip?.endDateTime ?? initial?.endDateTime ?? '',
      days: trip?.days ?? initial?.days ?? [],
      rates: trip?.rates ?? initial?.rates ?? buildDefaultRateSnapshot(),
      expectedReimbursementMonth: trip?.expectedReimbursementMonth ?? initial?.expectedReimbursementMonth ?? '',
      linkedAccountId: trip?.linkedAccountId ?? initial?.linkedAccountId ?? accounts.find((a) => !a.isArchived)?.id ?? '',
      status: trip?.status ?? initial?.status ?? 'planned',
      notes: trip?.notes ?? initial?.notes ?? '',
    });
    setRatesCollapsed(true);
    // An existing trip's reimbursement month is an explicit user choice — never
    // auto-overwrite it. A prefilled month (e.g. from a budget) is likewise
    // intentional. Only a bare new trip defaults it from the end date.
    setReimbursementMonthTouched(!!trip || !!initial?.expectedReimbursementMonth);
  }, [visible, trip, accounts, reset, initial]);

  const startDateTime = watch('startDateTime');
  const endDateTime = watch('endDateTime');
  const destinationCountry = watch('destinationCountry');
  const days = watch('days');
  const rates = watch('rates');
  const linkedAccountId = watch('linkedAccountId');

  // Any start/end/destination change regenerates the day list, preserving
  // per-day edits (country/meals/override) that still apply — see
  // `generateTripDays`. Idempotent when nothing relevant actually changed.
  useEffect(() => {
    if (!visible || !startDateTime || !endDateTime) return;
    const regenerated = generateTripDays(startDateTime, endDateTime, destinationCountry, getValues('days'));
    setValue('days', regenerated, { shouldValidate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, startDateTime, endDateTime, destinationCountry]);

  // Default the reimbursement month to the trip's end month until the user
  // picks one explicitly.
  useEffect(() => {
    if (!visible || reimbursementMonthTouched || !endDateTime) return;
    setValue('expectedReimbursementMonth', endDateTime.slice(0, 7));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, endDateTime, reimbursementMonthTouched]);

  const perDiemResult = useMemo(() => {
    if (!startDateTime || !endDateTime || !days || days.length === 0) return { days: [], total: 0 };
    return calculatePerDiem({ startDateTime, endDateTime, days, rates });
  }, [startDateTime, endDateTime, days, rates]);

  // Foreign countries actually used by the current day list — the rate
  // override section only exposes editors for rates the trip could apply.
  const usedForeignCountries = useMemo(() => {
    const codes = new Set((days ?? []).map((d) => d.countryCode).filter((c) => c !== DOMESTIC_COUNTRY_CODE));
    return Array.from(codes).sort();
  }, [days]);

  const updateDay = (index: number, patch: { countryCode?: string; freeMeals?: number; overrideAmount?: number | null }) => {
    const current = getValues('days');
    const next = current.map((d, i) => {
      if (i !== index) return d;
      const updated = { ...d };
      if (patch.countryCode !== undefined) updated.countryCode = patch.countryCode;
      if (patch.freeMeals !== undefined) updated.freeMeals = patch.freeMeals;
      if (patch.overrideAmount !== undefined) {
        if (patch.overrideAmount === null) delete updated.overrideAmount;
        else updated.overrideAmount = patch.overrideAmount;
      }
      return updated;
    });
    setValue('days', next, { shouldValidate: true });
  };

  const accountOptions = accounts
    .filter((a) => !a.isArchived || a.id === trip?.linkedAccountId)
    .map((a) => ({ label: a.isArchived ? `${a.name} (archived)` : a.name, value: a.id }));

  const handleSave = async (data: TripFormData) => {
    setIsSaving(true);
    try {
      const payload = {
        name: data.name,
        destinationCountry: data.destinationCountry,
        startDateTime: data.startDateTime,
        endDateTime: data.endDateTime,
        days: data.days,
        rates: data.rates,
        linkedAccountId: data.linkedAccountId,
        expectedReimbursementMonth: data.expectedReimbursementMonth,
        status: data.status,
        notes: data.notes || undefined,
      };
      const result = trip ? await updateTrip(trip.id, payload) : await createTrip(payload);
      if (result.success && result.data) {
        toast.success(trip ? 'Trip updated' : 'Trip created', data.name);
        onSaved(result.data);
        onHide();
      } else {
        toast.error('Error', result.error || 'Failed to save trip');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const footer = (
    <div className="flex justify-end gap-2">
      <Button label="Cancel" icon={<MdClose />} severity="secondary" text onClick={onHide} disabled={isSaving} />
      <Button label={trip ? 'Save' : 'Create trip'} icon={<MdSave />} onClick={handleSubmit(handleSave)} loading={isSaving} />
    </div>
  );

  return (
    <Dialog
      header={trip ? 'Edit trip' : 'New trip'}
      visible={visible}
      onHide={onHide}
      footer={footer}
      style={{ width: '44rem' }}
      modal
      closable
      draggable={false}
    >
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <label htmlFor="trip-name" className="block text-sm font-medium mb-1">Name</label>
          <Controller
            name="name"
            control={control}
            render={({ field }) => (
              <InputText id="trip-name" value={field.value} onChange={(e) => field.onChange(e.target.value)} className="w-full" placeholder="e.g. Berlin conference" />
            )}
          />
          {errors.name && <small className="text-red-500">{errors.name.message}</small>}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="trip-destination" className="block text-sm font-medium mb-1">Destination</label>
            <Controller
              name="destinationCountry"
              control={control}
              render={({ field }) => (
                <Dropdown
                  inputId="trip-destination"
                  value={field.value}
                  onChange={(e) => field.onChange(e.value)}
                  options={DESTINATION_OPTIONS}
                  filter
                  className="w-full"
                />
              )}
            />
          </div>
          <div>
            <label htmlFor="trip-account" className="block text-sm font-medium mb-1">Reimburse to account</label>
            <Controller
              name="linkedAccountId"
              control={control}
              render={({ field }) => (
                <Dropdown
                  inputId="trip-account"
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
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="trip-start" className="block text-sm font-medium mb-1">Departure</label>
            <Controller
              name="startDateTime"
              control={control}
              render={({ field }) => (
                <Calendar
                  inputId="trip-start"
                  value={localDateTimeToDate(field.value)}
                  onChange={(e) => field.onChange(dateToLocalDateTime(e.value as Date | null))}
                  showTime
                  hourFormat="24"
                  dateFormat="dd/mm/yy"
                  className="w-full"
                  showButtonBar
                />
              )}
            />
            {errors.startDateTime && <small className="text-red-500">{errors.startDateTime.message}</small>}
          </div>
          <div>
            <label htmlFor="trip-end" className="block text-sm font-medium mb-1">Return</label>
            <Controller
              name="endDateTime"
              control={control}
              render={({ field }) => (
                <Calendar
                  inputId="trip-end"
                  value={localDateTimeToDate(field.value)}
                  onChange={(e) => field.onChange(dateToLocalDateTime(e.value as Date | null))}
                  showTime
                  hourFormat="24"
                  dateFormat="dd/mm/yy"
                  className="w-full"
                  showButtonBar
                />
              )}
            />
            {errors.endDateTime && <small className="text-red-500">{errors.endDateTime.message}</small>}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="trip-reimbursement-month" className="block text-sm font-medium mb-1">Expected reimbursement</label>
            <Controller
              name="expectedReimbursementMonth"
              control={control}
              render={({ field }) => (
                <Calendar
                  inputId="trip-reimbursement-month"
                  value={yearMonthToDate(field.value)}
                  onChange={(e) => { setReimbursementMonthTouched(true); field.onChange(dateToYearMonth(e.value as Date | null)); }}
                  view="month"
                  dateFormat="mm/yy"
                  className="w-full"
                  showButtonBar
                />
              )}
            />
            {errors.expectedReimbursementMonth && <small className="text-red-500">{errors.expectedReimbursementMonth.message}</small>}
          </div>
          <div>
            <label htmlFor="trip-status" className="block text-sm font-medium mb-1">Status</label>
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <Dropdown
                  inputId="trip-status"
                  value={field.value}
                  onChange={(e) => field.onChange(e.value)}
                  options={STATUS_OPTIONS}
                  className="w-full"
                />
              )}
            />
          </div>
        </div>

        <div>
          <label htmlFor="trip-notes" className="block text-sm font-medium mb-1">Notes <span className="opacity-50">(optional)</span></label>
          <Controller
            name="notes"
            control={control}
            render={({ field }) => (
              <InputTextarea id="trip-notes" value={field.value ?? ''} onChange={(e) => field.onChange(e.target.value)} className="w-full" rows={2} autoResize />
            )}
          />
        </div>

        <Panel
          header="Per-diem rates"
          toggleable
          collapsed={ratesCollapsed}
          onToggle={(e) => setRatesCollapsed(e.value)}
        >
          <p className="text-xs opacity-60 mb-3">
            Prefilled from the official 2026 Vero.fi rates. Edit only if this trip should use a different amount.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="rate-domestic-full" className="block text-xs font-medium mb-1">Domestic full</label>
              <InputNumber
                inputId="rate-domestic-full"
                value={rates.domesticFull}
                onValueChange={(e) => setValue('rates', { ...rates, domesticFull: e.value ?? 0 })}
                mode="currency"
                currency="EUR"
                locale="fi-FI"
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="rate-domestic-partial" className="block text-xs font-medium mb-1">Domestic partial</label>
              <InputNumber
                inputId="rate-domestic-partial"
                value={rates.domesticPartial}
                onValueChange={(e) => setValue('rates', { ...rates, domesticPartial: e.value ?? 0 })}
                mode="currency"
                currency="EUR"
                locale="fi-FI"
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="rate-default-foreign" className="block text-xs font-medium mb-1">Default foreign</label>
              <InputNumber
                inputId="rate-default-foreign"
                value={rates.defaultForeign}
                onValueChange={(e) => setValue('rates', { ...rates, defaultForeign: e.value ?? 0 })}
                mode="currency"
                currency="EUR"
                locale="fi-FI"
                className="w-full"
              />
            </div>
          </div>
          {usedForeignCountries.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
              {usedForeignCountries.map((code) => (
                <div key={code}>
                  <label className="block text-xs font-medium mb-1">{countryName(code)}</label>
                  <InputNumber
                    value={rates.countryRates[code] ?? rates.defaultForeign}
                    onValueChange={(e) => setValue('rates', {
                      ...rates,
                      countryRates: { ...rates.countryRates, [code]: e.value ?? 0 },
                    })}
                    mode="currency"
                    currency="EUR"
                    locale="fi-FI"
                    className="w-full"
                  />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div>
          <h4 className="text-sm font-semibold mb-2">Days</h4>
          {(!days || days.length === 0) ? (
            <p className="text-sm opacity-60">Set departure and return date/time to build the day list.</p>
          ) : (
            <div className="space-y-2">
              {days.map((d, index) => (
                <div key={d.date + index} className="rounded-xl border border-black/10 dark:border-white/10 p-3">
                  {/* Row 1: date + country + computed amount. Row 2: meals + override.
                      Grid (not a single flex row) so nothing overflows at any dialog width. */}
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2">
                    <span className="text-sm font-medium tabular-nums">{d.date}</span>
                    <Dropdown
                      value={d.countryCode}
                      onChange={(e) => updateDay(index, { countryCode: e.value })}
                      options={DESTINATION_OPTIONS}
                      filter
                      className="w-full min-w-0"
                      aria-label="Country"
                    />
                    <span className="text-sm font-semibold tabular-nums text-right">
                      {perDiemResult.days[index] ? `€${perDiemResult.days[index].amount.toFixed(2)}` : '–'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <div className="min-w-0">
                      <label className="block text-xs opacity-50 mb-1">Free meals</label>
                      <InputNumber
                        value={d.freeMeals}
                        onValueChange={(e) => updateDay(index, { freeMeals: e.value ?? 0 })}
                        min={0}
                        max={10}
                        showButtons
                        className="w-full"
                        inputClassName="w-full"
                      />
                    </div>
                    <div className="min-w-0">
                      <label className="block text-xs opacity-50 mb-1">Override amount</label>
                      <InputNumber
                        value={d.overrideAmount ?? null}
                        onValueChange={(e) => updateDay(index, { overrideAmount: e.value ?? null })}
                        mode="currency"
                        currency="EUR"
                        locale="fi-FI"
                        placeholder="auto"
                        className="w-full"
                        inputClassName="w-full"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="text-sm font-semibold mb-2">Per-diem breakdown</h4>
          <PerDiemBreakdown result={perDiemResult} />
        </div>

        {!linkedAccountId && (
          <p className="text-xs opacity-50">
            Once an account is selected, the per-diem total is added to that account&apos;s cashflow as expected income in the reimbursement month — until the trip is marked reimbursed.
          </p>
        )}
      </div>
    </Dialog>
  );
}
