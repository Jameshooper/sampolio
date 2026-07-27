'use server';

import { auth } from '@/lib/auth';
import type { ApiResponse } from '@/types';

/**
 * Fetch the latest published 12-month Euribor rate for prefilling the
 * Euribor-update dialog. Source: ECB Data Portal (data-api.ecb.europa.eu),
 * series FM.M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA (Euribor 1-year, monthly average
 * of daily historical closes, in percent per annum).
 *
 * Failure is always graceful ({ success: false }) — the dialog's manual entry
 * is the fallback and must never be blocked by this convenience.
 */

export interface EuriborQuote {
  rate: number; // percent, e.g. 2.798
  date: string; // observation period, e.g. "2026-06"
  source: string; // human-readable source label
}

const ECB_ENDPOINT =
  'https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA?lastNObservations=1&format=csvdata';
const SOURCE_LABEL = 'ECB Data Portal';
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — the series updates ~monthly

// Module-level in-memory cache so repeated dialog opens don't refetch.
let cached: { quote: EuriborQuote; fetchedAt: number } | null = null;

/** Split one CSV line into fields, honoring double-quoted fields with commas. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseEcbCsv(csv: string): EuriborQuote | null {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const timeIdx = header.indexOf('TIME_PERIOD');
  const valueIdx = header.indexOf('OBS_VALUE');
  if (timeIdx < 0 || valueIdx < 0) return null;
  // Use the last data row (should be exactly one with lastNObservations=1).
  const row = splitCsvLine(lines[lines.length - 1]);
  const date = row[timeIdx]?.trim();
  const rate = Number.parseFloat(row[valueIdx]);
  if (!date || !Number.isFinite(rate)) return null;
  // The dialog's input shows up to 3 decimals — round to match.
  return { rate: Math.round(rate * 1000) / 1000, date, source: SOURCE_LABEL };
}

export async function fetchCurrentEuribor12m(): Promise<ApiResponse<EuriborQuote>> {
  try {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: 'Not authenticated' };

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { success: true, data: cached.quote };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let csv: string;
    try {
      const res = await fetch(ECB_ENDPOINT, {
        signal: controller.signal,
        headers: { Accept: 'text/csv' },
        cache: 'no-store',
      });
      if (!res.ok) return { success: false, error: `Euribor source returned ${res.status}` };
      csv = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const quote = parseEcbCsv(csv);
    if (!quote) return { success: false, error: 'Could not parse Euribor data' };

    cached = { quote, fetchedAt: Date.now() };
    return { success: true, data: quote };
  } catch {
    // Timeout, network failure, or anything else — the UI falls back to manual entry.
    return { success: false, error: 'Euribor rate unavailable' };
  }
}
