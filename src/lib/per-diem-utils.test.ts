import { describe, it, expect } from 'vitest';
import {
  computeTripHours,
  computeSliceCount,
  generateTripDays,
  resolveDayRate,
  calculatePerDiem,
} from './per-diem-utils';
import { buildDefaultRateSnapshot } from './per-diem-rates';
import type { TripDay } from '@/types';

const START = '2026-06-01T08:00';

function addHours(dateTime: string, hours: number): string {
  const [datePart, timePart] = dateTime.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  const date = new Date(y, m - 1, d, hh, mm);
  date.setMinutes(date.getMinutes() + Math.round(hours * 60));
  const y2 = date.getFullYear();
  const m2 = String(date.getMonth() + 1).padStart(2, '0');
  const d2 = String(date.getDate()).padStart(2, '0');
  const hh2 = String(date.getHours()).padStart(2, '0');
  const mm2 = String(date.getMinutes()).padStart(2, '0');
  return `${y2}-${m2}-${d2}T${hh2}:${mm2}`;
}

function endFor(hours: number): string {
  return addHours(START, hours);
}

function day(date: string, countryCode: string, overrides?: Partial<TripDay>): TripDay {
  return { date, countryCode, freeMeals: 0, ...overrides };
}

describe('computeTripHours', () => {
  it('returns zeros for an invalid or non-positive span', () => {
    expect(computeTripHours('bad', START)).toEqual({ totalHours: 0, fullDays: 0, remainderHours: 0 });
    expect(computeTripHours(START, START)).toEqual({ totalHours: 0, fullDays: 0, remainderHours: 0 });
    expect(computeTripHours(endFor(5), START)).toEqual({ totalHours: 0, fullDays: 0, remainderHours: 0 });
  });

  it('splits into full 24h days plus a remainder', () => {
    expect(computeTripHours(START, endFor(73))).toEqual({ totalHours: 73, fullDays: 3, remainderHours: 1 });
  });
});

describe('computeSliceCount', () => {
  it('counts a remainder as one extra slice', () => {
    expect(computeSliceCount(START, endFor(5))).toBe(1);
    expect(computeSliceCount(START, endFor(24))).toBe(1);
    expect(computeSliceCount(START, endFor(73))).toBe(4);
  });
});

describe('resolveDayRate', () => {
  const rates = buildDefaultRateSnapshot();

  it('resolves FI to the domestic full rate', () => {
    expect(resolveDayRate('FI', rates)).toBe(rates.domesticFull);
  });

  it('resolves a listed country to its rate', () => {
    expect(resolveDayRate('germany', rates)).toBe(78);
  });

  it('falls back to the default foreign rate for an unlisted code', () => {
    expect(resolveDayRate('nowhereland', rates)).toBe(rates.defaultForeign);
  });
});

describe('calculatePerDiem — domestic remainder-only trips (no full day)', () => {
  const rates = buildDefaultRateSnapshot();

  it('5h earns nothing', () => {
    const days = [day('2026-06-01', 'FI')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(5), days, rates }).total).toBe(0);
  });

  it('exactly 6h earns nothing (strictly > 6h required)', () => {
    const days = [day('2026-06-01', 'FI')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(6), days, rates }).total).toBe(0);
  });

  it('7h earns a partial', () => {
    const days = [day('2026-06-01', 'FI')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(7), days, rates }).total).toBe(25);
  });

  it('exactly 10h earns a partial, not a full (strictly > 10h required)', () => {
    const days = [day('2026-06-01', 'FI')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(10), days, rates }).total).toBe(25);
  });

  it('11h earns a full', () => {
    const days = [day('2026-06-01', 'FI')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(11), days, rates }).total).toBe(54);
  });
});

describe('calculatePerDiem — domestic multi-day trips', () => {
  const rates = buildDefaultRateSnapshot();

  it('73h = 3 full days + a 1h remainder that earns nothing', () => {
    const days = [
      day('2026-06-01', 'FI'), day('2026-06-02', 'FI'), day('2026-06-03', 'FI'), day('2026-06-04', 'FI'),
    ];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(73), days, rates });
    expect(result.total).toBe(162);
    expect(result.days[3].kind).toBe('none');
  });

  it('72h + 2h30 = 3 full days + an extra partial', () => {
    const days = [
      day('2026-06-01', 'FI'), day('2026-06-02', 'FI'), day('2026-06-03', 'FI'), day('2026-06-04', 'FI'),
    ];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(74.5), days, rates });
    expect(result.total).toBe(187);
  });

  it('72h + 7h = 3 full days + an extra full (4 full-equivalent days)', () => {
    const days = [
      day('2026-06-01', 'FI'), day('2026-06-02', 'FI'), day('2026-06-03', 'FI'), day('2026-06-04', 'FI'),
    ];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(79), days, rates });
    expect(result.total).toBe(216);
  });
});

describe('calculatePerDiem — free meal reductions', () => {
  const rates = buildDefaultRateSnapshot();

  it('halves a full day with 2+ free meals', () => {
    const days = [day('2026-06-01', 'FI', { freeMeals: 2 })];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(24), days, rates }).total).toBe(27);
  });

  it('halves a partial day with 1+ free meal', () => {
    const days = [day('2026-06-01', 'FI', { freeMeals: 1 })];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(7), days, rates }).total).toBe(12.5);
  });

  it('does not reduce a full day with only 1 free meal', () => {
    const days = [day('2026-06-01', 'FI', { freeMeals: 1 })];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(24), days, rates }).total).toBe(54);
  });

  it('does NOT halve a half-foreign day with 1 free meal (§13: foreign "free meals" = two meals)', () => {
    const days = [day('2026-06-01', 'germany'), day('2026-06-02', 'germany', { freeMeals: 1 })];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(29), days, rates });
    expect(result.days[1].kind).toBe('half-foreign');
    expect(result.days[1].amount).toBe(39);
  });

  it('halves a half-foreign day with 2 free meals', () => {
    const days = [day('2026-06-01', 'germany'), day('2026-06-02', 'germany', { freeMeals: 2 })];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(29), days, rates });
    expect(result.days[1].mealReduced).toBe(true);
    expect(result.days[1].amount).toBe(19.5);
  });
});

describe('calculatePerDiem — foreign trips', () => {
  const rates = buildDefaultRateSnapshot();

  it('2 full Germany days + a 5h Germany remainder = 2 full + half-foreign', () => {
    const days = [day('2026-06-01', 'germany'), day('2026-06-02', 'germany'), day('2026-06-03', 'germany')];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(53), days, rates });
    expect(result.total).toBe(195);
    expect(result.days[2].kind).toBe('half-foreign');
  });

  it('2 full Germany days + a 5h remainder back in Finland = 2 full + domestic partial', () => {
    const days = [day('2026-06-01', 'germany'), day('2026-06-02', 'germany'), day('2026-06-03', 'FI')];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(53), days, rates });
    expect(result.total).toBe(181);
    expect(result.days[2].kind).toBe('partial');
  });

  it('a foreign trip of exactly 10h gets the full country rate (§13: "minimum of 10 hours")', () => {
    const days = [day('2026-06-01', 'germany')];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(10), days, rates });
    expect(result.days[0].kind).toBe('full');
    expect(result.total).toBe(78);
  });

  it('a foreign trip under 10h falls back to DOMESTIC amounts (>6h → €25 partial)', () => {
    const days = [day('2026-06-01', 'germany')];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(8), days, rates });
    expect(result.days[0].kind).toBe('partial');
    expect(result.total).toBe(25);
  });

  it('a foreign trip of 6h or less earns nothing', () => {
    const days = [day('2026-06-01', 'germany')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(6), days, rates }).total).toBe(0);
  });

  it('falls back to the default foreign rate for an unlisted country', () => {
    const days = [day('2026-06-01', 'nowhereland')];
    expect(calculatePerDiem({ startDateTime: START, endDateTime: endFor(24), days, rates }).total).toBe(52);
  });

  it('attributes each full day to its own country', () => {
    const days = [day('2026-06-01', 'FI'), day('2026-06-02', 'germany')];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(48), days, rates });
    expect(result.total).toBe(132);
    expect(result.days[0].amount).toBe(54);
    expect(result.days[1].amount).toBe(78);
  });
});

describe('calculatePerDiem — manual override', () => {
  const rates = buildDefaultRateSnapshot();

  it('a per-day override wins over the computed amount, including meal reduction', () => {
    const days = [day('2026-06-01', 'FI', { freeMeals: 2, overrideAmount: 999 })];
    const result = calculatePerDiem({ startDateTime: START, endDateTime: endFor(24), days, rates });
    expect(result.total).toBe(999);
    expect(result.days[0].isOverridden).toBe(true);
  });
});

describe('generateTripDays', () => {
  it('defaults full-day slices to the destination country and the remainder to the last full day', () => {
    const days = generateTripDays(START, endFor(53), 'FI');
    expect(days).toHaveLength(3);
    expect(days.every((d) => d.countryCode === 'FI')).toBe(true);
  });

  it('remainder defaults to the last full day\'s (possibly edited) country, not the destination', () => {
    // Only day0 has a stored edit — day1 (the remainder slice) has no
    // matching existing entry at all, forcing the default-computation path.
    const day0Date = generateTripDays(START, endFor(29), 'FI')[0].date;
    const existing: TripDay[] = [day(day0Date, 'germany')];
    const regenerated = generateTripDays(START, endFor(29), 'FI', existing);
    expect(regenerated).toHaveLength(2);
    expect(regenerated[0].countryCode).toBe('germany');
    // Remainder defaults to day0's actual (edited) country, not 'FI'.
    expect(regenerated[1].countryCode).toBe('germany');
  });

  it('preserves per-day edits by index when the trip dates shift', () => {
    const original = generateTripDays(START, endFor(30), 'FI');
    const edited: TripDay[] = [
      { ...original[0], countryCode: 'germany', freeMeals: 2 },
      { ...original[1], overrideAmount: 99 },
    ];

    // Shift far enough that no new slice date coincidentally matches a
    // *different* original slice's date (which would cross-match by date).
    const shiftedStart = addHours(START, 24 * 10);
    const shiftedEnd = addHours(shiftedStart, 30);
    const regenerated = generateTripDays(shiftedStart, shiftedEnd, 'FI', edited);

    expect(regenerated).toHaveLength(2);
    expect(regenerated[0].date).not.toBe(edited[0].date); // dates really did shift
    expect(regenerated[0].countryCode).toBe('germany');
    expect(regenerated[0].freeMeals).toBe(2);
    expect(regenerated[1].overrideAmount).toBe(99);
  });
});
