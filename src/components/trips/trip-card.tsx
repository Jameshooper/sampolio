'use client';

import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { MdFlightTakeoff, MdEdit, MdDelete, MdCheckCircle, MdPaid } from 'react-icons/md';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { PER_DIEM_COUNTRIES_2026, DOMESTIC_COUNTRY_CODE } from '@/lib/per-diem-rates';
import { calculatePerDiem } from '@/lib/per-diem-utils';
import { useTheme } from '@/components/providers/theme-provider';
import type { Trip, TripStatus } from '@/types';

const STATUS_TAG: Record<TripStatus, { value: string; severity: 'info' | 'warning' | 'success' }> = {
  planned: { value: 'Planned', severity: 'info' },
  completed: { value: 'Completed', severity: 'warning' },
  reimbursed: { value: 'Reimbursed', severity: 'success' },
};

function countryName(code: string): string {
  if (code === DOMESTIC_COUNTRY_CODE) return 'Finland (domestic)';
  return PER_DIEM_COUNTRIES_2026.find((c) => c.code === code)?.name ?? code;
}

function formatDateTime(value: string): string {
  const [datePart, timePart] = value.split('T');
  const [y, m, d] = datePart.split('-');
  return `${d}.${m}.${y} ${timePart}`;
}

function formatDuration(startDateTime: string, endDateTime: string): string {
  const start = new Date(startDateTime);
  const end = new Date(endDateTime);
  const totalMinutes = Math.round((end.getTime() - start.getTime()) / (60 * 1000));
  if (totalMinutes <= 0) return '–';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.round((totalMinutes - days * 24 * 60) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} h`);
  return parts.length > 0 ? parts.join(' ') : '< 1 h';
}

export function TripCard({
  trip,
  linkedAccountName,
  fundedByBudgetName,
  onEdit,
  onDelete,
  onAdvanceStatus,
}: {
  trip: Trip;
  linkedAccountName?: string;
  /** Set when this trip's per diem funds a budget — shown as a "Funds: …" tag. */
  fundedByBudgetName?: string;
  onEdit: () => void;
  onDelete: () => void;
  onAdvanceStatus: (nextStatus: TripStatus) => void;
}) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const tag = STATUS_TAG[trip.status];
  const total = calculatePerDiem(trip).total;

  return (
    <div
      className={`rounded-xl border p-4 transition-colors ${
        isDark ? 'border-neutral-700 bg-neutral-800/50' : 'border-neutral-200 bg-white'
      } ${trip.status === 'reimbursed' ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MdFlightTakeoff size={20} className="opacity-50 shrink-0" />
          <h3 className="text-base font-semibold truncate">{trip.name}</h3>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Tag value={tag.value} severity={tag.severity} />
          {fundedByBudgetName && (
            <Tag
              severity="info"
              value={`Funds: ${fundedByBudgetName}`}
              className="!max-w-[10rem] [&_.p-tag-value]:truncate"
            />
          )}
        </div>
      </div>

      <p className="text-sm opacity-60 mt-1.5">{countryName(trip.destinationCountry)}</p>
      <p className="text-sm opacity-70 mt-1">
        {formatDateTime(trip.startDateTime)} &rarr; {formatDateTime(trip.endDateTime)}
      </p>
      <p className="text-xs opacity-50 mt-0.5">{formatDuration(trip.startDateTime, trip.endDateTime)}</p>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-sm opacity-60">Per diem total</span>
        <span className="text-xl font-bold">{formatCurrency(total, 'EUR')}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-xs opacity-60">
        {linkedAccountName && <span>To: {linkedAccountName}</span>}
        <span>Reimbursed: {formatYearMonth(trip.expectedReimbursementMonth)}</span>
      </div>

      {trip.notes && <p className="text-sm opacity-70 mt-2 line-clamp-2">{trip.notes}</p>}

      <div className="flex items-center justify-between gap-2 mt-3">
        <div>
          {trip.status === 'planned' && (
            <Button
              label="Mark completed"
              icon={<MdCheckCircle />}
              text
              size="small"
              onClick={() => onAdvanceStatus('completed')}
            />
          )}
          {trip.status === 'completed' && (
            <Button
              label="Mark reimbursed"
              icon={<MdPaid />}
              text
              size="small"
              severity="success"
              onClick={() => onAdvanceStatus('reimbursed')}
            />
          )}
        </div>
        <div className="flex gap-1">
          <Button icon={<MdEdit />} text rounded size="small" severity="secondary" aria-label="Edit trip" onClick={onEdit} />
          <Button icon={<MdDelete />} text rounded size="small" severity="danger" aria-label="Delete trip" onClick={onDelete} />
        </div>
      </div>

      {trip.status === 'completed' && (
        <p className="text-xs opacity-50 mt-2">
          Marking this reimbursed stops it from showing up as expected income on Cashflow.
        </p>
      )}
    </div>
  );
}
