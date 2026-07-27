'use client';

import { Tag } from 'primereact/tag';
import { formatCurrency } from '@/lib/constants';
import { PER_DIEM_COUNTRIES_2026, DOMESTIC_COUNTRY_CODE } from '@/lib/per-diem-rates';
import type { PerDiemResult, TravelDayBreakdown } from '@/lib/per-diem-utils';

const KIND_LABELS: Record<TravelDayBreakdown['kind'], string> = {
  full: 'Full',
  partial: 'Partial',
  'half-foreign': 'Half',
  none: '–',
};

const KIND_SEVERITY: Record<TravelDayBreakdown['kind'], 'success' | 'info' | 'warning' | 'secondary'> = {
  full: 'success',
  partial: 'info',
  'half-foreign': 'info',
  none: 'secondary',
};

function countryName(code: string): string {
  if (code === DOMESTIC_COUNTRY_CODE) return 'Finland (domestic)';
  return PER_DIEM_COUNTRIES_2026.find((c) => c.code === code)?.name ?? code;
}

/** Read-only per-day breakdown of a trip's per-diem calculation, plus a total. */
export function PerDiemBreakdown({ result }: { result: PerDiemResult }) {
  if (result.days.length === 0) {
    return <p className="text-sm opacity-60">Set the start and end date/time to see the per-diem breakdown.</p>;
  }

  return (
    <div className="space-y-1">
      {result.days.map((d) => (
        <div
          key={d.index}
          className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5 rounded text-sm bg-black/5 dark:bg-white/5"
        >
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="font-medium whitespace-nowrap">{d.date}</span>
            <span className="opacity-60 truncate">{countryName(d.countryCode)}</span>
            <span className="opacity-50 text-xs whitespace-nowrap">{Math.round(d.hours * 10) / 10}h</span>
            <Tag value={KIND_LABELS[d.kind]} severity={KIND_SEVERITY[d.kind]} className="text-xs !py-0 !px-1.5" />
            {d.mealReduced && <Tag value="meals −50%" severity="warning" className="text-xs !py-0 !px-1.5" />}
            {d.isOverridden && <Tag value="edited" severity="contrast" className="text-xs !py-0 !px-1.5" />}
          </div>
          <span className="font-medium whitespace-nowrap">{formatCurrency(d.amount, 'EUR')}</span>
        </div>
      ))}
      <div className="flex items-center justify-between px-2 py-2 border-t border-black/10 dark:border-white/10 mt-2 pt-2">
        <span className="font-semibold">Total per diem</span>
        <span className="font-bold text-lg">{formatCurrency(result.total, 'EUR')}</span>
      </div>
    </div>
  );
}
