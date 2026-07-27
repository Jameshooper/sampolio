import type { Trip, TripDay, TripRateSnapshot } from '@/types';
import { DOMESTIC_COUNTRY_CODE } from './per-diem-rates';

/**
 * Pure engine implementing the Vero.fi (Finnish Tax Administration) 2026
 * per-diem rules (decision VH/6575/00.01.00/2025) for a trip's day list. No
 * I/O — `src/lib/per-diem-rates.ts` holds the euro amounts, this module holds
 * the logic that applies them.
 */

// ============================================================
// Date/time parsing
// ============================================================

function parseLocalDateTime(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  return Number.isNaN(date.getTime()) ? null : date;
}

function addCalendarDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

// ============================================================
// Trip hours / slice count
// ============================================================

export interface TripHours {
  totalHours: number;
  fullDays: number;
  remainderHours: number;
}

/**
 * Parses both timestamps as LOCAL date/times and diffs their epoch
 * milliseconds at minute precision. Because `Date` construction from
 * calendar components already resolves each moment through the host's
 * local-timezone/DST rules, a trip that spans a DST transition measures a
 * true elapsed span of 23h or 25h for what per-diem accounting treats as a
 * flat 24h travel day — an accepted ±1h simplification (Vero's own worked
 * examples reason in plain 24h slices too; no bank-style DST bookkeeping).
 * Invalid input or a non-positive span returns all zeros.
 */
export function computeTripHours(start: string, end: string): TripHours {
  const startDate = parseLocalDateTime(start);
  const endDate = parseLocalDateTime(end);
  if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) {
    return { totalHours: 0, fullDays: 0, remainderHours: 0 };
  }

  const totalMinutes = Math.round((endDate.getTime() - startDate.getTime()) / (60 * 1000));
  const fullDays = Math.floor(totalMinutes / (24 * 60));
  const remainderMinutes = totalMinutes - fullDays * 24 * 60;

  return {
    totalHours: totalMinutes / 60,
    fullDays,
    remainderHours: remainderMinutes / 60,
  };
}

/** Number of per-diem "slices" a trip breaks into: one per full 24h from
 * departure, plus one more if anything is left over. */
export function computeSliceCount(start: string, end: string): number {
  const { fullDays, remainderHours } = computeTripHours(start, end);
  return fullDays + (remainderHours > 0 ? 1 : 0);
}

// ============================================================
// Day-list generation
// ============================================================

/** Finds the day to carry edits forward from when regenerating the day list
 * after a start/end/destination change. Matches by calendar date first (the
 * common case — only the trailing slice count changed); falls back to the
 * same slice index so edits on a shifted trip aren't silently dropped. This
 * is a deliberately simple, deterministic rule — not a diff/merge. */
function matchExistingDay(existing: TripDay[] | undefined, date: string, index: number): TripDay | undefined {
  if (!existing || existing.length === 0) return undefined;
  return existing.find((d) => d.date === date) ?? existing[index];
}

/**
 * Builds the day list for a trip's current start/end/destination. Each full
 * 24h slice (dated from the departure day) defaults to `destinationCountry`;
 * the trailing remainder slice (if any) defaults to the LAST full slice's
 * (possibly user-edited) country, or `destinationCountry` when the trip has
 * no full day at all. Existing per-day edits (country/meals/override) are
 * preserved across regeneration via `matchExistingDay`.
 */
export function generateTripDays(
  start: string,
  end: string,
  destinationCountry: string,
  existing?: TripDay[]
): TripDay[] {
  const { fullDays, remainderHours } = computeTripHours(start, end);
  const startDate = parseLocalDateTime(start);
  const sliceCount = fullDays + (remainderHours > 0 ? 1 : 0);
  if (!startDate || sliceCount === 0) return [];

  const days: TripDay[] = [];

  for (let i = 0; i < fullDays; i++) {
    const dateStr = formatDateYMD(addCalendarDays(startDate, i));
    const matched = matchExistingDay(existing, dateStr, i);
    days.push({
      date: dateStr,
      countryCode: matched?.countryCode ?? destinationCountry,
      freeMeals: matched?.freeMeals ?? 0,
      overrideAmount: matched?.overrideAmount,
    });
  }

  if (remainderHours > 0) {
    const dateStr = formatDateYMD(addCalendarDays(startDate, fullDays));
    const matched = matchExistingDay(existing, dateStr, fullDays);
    const lastFullCountry = fullDays > 0 ? days[fullDays - 1].countryCode : destinationCountry;
    days.push({
      date: dateStr,
      countryCode: matched?.countryCode ?? lastFullCountry,
      freeMeals: matched?.freeMeals ?? 0,
      overrideAmount: matched?.overrideAmount,
    });
  }

  return days;
}

// ============================================================
// Rate resolution
// ============================================================

/** Base per-diem rate for a single day's country: domestic full for 'FI',
 * else that country's listed rate, falling back to the snapshot's default
 * foreign rate for an unlisted/unknown code. */
export function resolveDayRate(countryCode: string, rates: TripRateSnapshot): number {
  if (countryCode === DOMESTIC_COUNTRY_CODE) return rates.domesticFull;
  return rates.countryRates[countryCode] ?? rates.defaultForeign;
}

// ============================================================
// Per-diem calculation
// ============================================================

export interface TravelDayBreakdown {
  index: number;
  date: string;
  countryCode: string;
  hours: number;
  kind: 'full' | 'partial' | 'half-foreign' | 'none';
  baseRate: number;
  mealReduced: boolean;
  isOverridden: boolean;
  amount: number;
}

export interface PerDiemResult {
  days: TravelDayBreakdown[];
  total: number;
}

/**
 * Applies the Vero 2026 per-diem rules to a trip's day list:
 *
 * - Each full 24h slice from departure earns a FULL per diem at that slice's
 *   country rate.
 * - The trailing remainder slice (R hours left over):
 *   - No full days at all (whole trip < 24h), domestic: R > 10h → full;
 *     R > 6h → partial; else nothing.
 *   - No full days at all, foreign: R ≥ 10h → the country's full per diem
 *     (§13: "lasting a minimum of 10 hours"); under 10h the DOMESTIC
 *     provisions and amounts apply instead (R > 6h → domestic partial €25).
 *   - ≥1 full day, remainder back in Finland: R ≥ 2h → extra partial (€25);
 *     R > 6h → extra full (€54) — checked full-first since R > 6h implies
 *     R ≥ 2h.
 *   - ≥1 full day, remainder abroad: R > 10h → full country rate; R > 2h →
 *     half the country rate (`half-foreign`); else nothing.
 * - Free meals: a FULL or HALF-FOREIGN day is halved at 2+ free meals (§13
 *   defines foreign "free meals" as two meals); a domestic PARTIAL day is
 *   halved at 1+ free meal (§12). Reduction is applied before any per-day
 *   manual override, which always wins outright.
 * - If the stored day list doesn't match the trip's actual slice count (e.g.
 *   a stale record after a date edit), defaults are regenerated defensively
 *   rather than mis-indexing days against slices.
 */
export function calculatePerDiem(
  trip: Pick<Trip, 'startDateTime' | 'endDateTime' | 'days'> & { rates: TripRateSnapshot }
): PerDiemResult {
  const { startDateTime, endDateTime, rates } = trip;
  const { fullDays, remainderHours } = computeTripHours(startDateTime, endDateTime);
  const sliceCount = computeSliceCount(startDateTime, endDateTime);

  let days = trip.days;
  if (days.length !== sliceCount) {
    const destinationCountry = days[0]?.countryCode ?? DOMESTIC_COUNTRY_CODE;
    days = generateTripDays(startDateTime, endDateTime, destinationCountry, days);
  }

  const breakdown: TravelDayBreakdown[] = days.map((day, index) => {
    const isFullDaySlice = index < fullDays;
    let hours: number;
    let kind: TravelDayBreakdown['kind'];
    let baseRate: number;

    if (isFullDaySlice) {
      hours = 24;
      kind = 'full';
      baseRate = resolveDayRate(day.countryCode, rates);
    } else {
      hours = remainderHours;
      const isForeign = day.countryCode !== DOMESTIC_COUNTRY_CODE;
      const countryFullRate = resolveDayRate(day.countryCode, rates);

      if (fullDays === 0) {
        if (isForeign) {
          // §13: a foreign business trip lasting a minimum of 10 hours earns
          // the country's full per diem; SHORTER foreign trips fall back to
          // the domestic provisions and amounts (so >6h pays the domestic
          // partial €25, never a share of the foreign rate).
          if (remainderHours >= 10) {
            kind = 'full';
            baseRate = countryFullRate;
          } else if (remainderHours > 6) {
            kind = 'partial';
            baseRate = rates.domesticPartial;
          } else {
            kind = 'none';
            baseRate = 0;
          }
        } else if (remainderHours > 10) {
          kind = 'full';
          baseRate = countryFullRate;
        } else if (remainderHours > 6) {
          kind = 'partial';
          baseRate = rates.domesticPartial;
        } else {
          kind = 'none';
          baseRate = 0;
        }
      } else if (!isForeign) {
        if (remainderHours > 6) {
          kind = 'full';
          baseRate = rates.domesticFull;
        } else if (remainderHours >= 2) {
          kind = 'partial';
          baseRate = rates.domesticPartial;
        } else {
          kind = 'none';
          baseRate = 0;
        }
      } else {
        if (remainderHours > 10) {
          kind = 'full';
          baseRate = countryFullRate;
        } else if (remainderHours > 2) {
          kind = 'half-foreign';
          baseRate = countryFullRate / 2;
        } else {
          kind = 'none';
          baseRate = 0;
        }
      }
    }

    // Meal reduction thresholds: a domestic PARTIAL per diem is halved by a
    // single free meal (§12), but for FOREIGN per diems the decision defines
    // "free meals" as TWO free meals (§13) — so full days (domestic or
    // foreign) and half-foreign days all require 2+ meals to halve. The
    // 'partial' kind always carries the domestic partial amount, so the
    // 1-meal rule keys off the kind alone.
    let mealReduced = false;
    let amount = baseRate;
    if ((kind === 'full' || kind === 'half-foreign') && day.freeMeals >= 2) {
      amount = baseRate / 2;
      mealReduced = true;
    } else if (kind === 'partial' && day.freeMeals >= 1) {
      amount = baseRate / 2;
      mealReduced = true;
    }

    const isOverridden = day.overrideAmount !== undefined;
    if (isOverridden) {
      amount = day.overrideAmount as number;
    }

    return {
      index,
      date: day.date,
      countryCode: day.countryCode,
      hours,
      kind,
      baseRate,
      mealReduced,
      isOverridden,
      amount: round2(amount),
    };
  });

  const total = round2(breakdown.reduce((sum, d) => sum + d.amount, 0));
  return { days: breakdown, total };
}
