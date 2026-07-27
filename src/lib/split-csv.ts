// Splitwise CSV import — parsing only (pure, unit-tested in split-csv.test.ts).
//
// Splitwise export shape:
//   Date,Description,Category,Cost,Currency,<Member1 name>,<Member2 name>,...
// The member columns are SIGNED net balances per row (− = owes, + = is owed),
// summing to ~0. "Payment"-category rows are settle-ups. A trailing
// "Total balance" row and blank separator rows must be skipped. Descriptions
// may contain quoted commas, so a real RFC4180 parser is required.
//
// Money is parsed to INTEGER CENTS to match the rest of the Split feature.

import type { SplitwiseImportRow } from '@/types';

/**
 * RFC4180-ish CSV parser: quote-aware (handles quoted commas, "" escapes, and
 * CR / LF / CRLF line endings). Returns every row as an array of raw string
 * cells (the caller filters blanks/footers).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // strip UTF-8 BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      // consume the \n of a \r\n pair
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // flush trailing field/row
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * Lenient amount → integer cents. Handles "1234.56", "98,90", "1.234,56" and
 * "1,234.56" (the last separator is the decimal), strips currency symbols and
 * the Unicode minus. Returns null when not a number.
 */
export function parseAmountToCents(raw: string): number | null {
  let s = (raw ?? '').trim().replace(/\s/g, '').replace(/[€$£]/g, '').replace(/−/g, '-');
  if (!s || s === '-') return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // ',' is the decimal
    } else {
      s = s.replace(/,/g, ''); // ',' is the thousands sep
    }
  } else if (hasComma) {
    s = s.replace(',', '.');
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

const isBlankRow = (cells: string[]): boolean => cells.every((c) => (c ?? '').trim() === '');

export interface SplitwiseParseResult {
  memberNames: string[]; // header columns after "Currency", in order
  rows: SplitwiseImportRow[];
  errors: string[]; // per-line problems (row skipped)
  warnings: string[]; // non-fatal notes (row kept)
}

/**
 * Parse a Splitwise CSV export into member column names + normalized rows.
 * Skips the header, blank separator rows, and the trailing "Total balance" row.
 */
export function parseSplitwiseCsv(text: string): SplitwiseParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const all = parseCsv(text);
  const result: SplitwiseParseResult = { memberNames: [], rows: [], errors, warnings };

  // First non-blank row is the header.
  const headerIdx = all.findIndex((r) => !isBlankRow(r));
  if (headerIdx === -1) {
    errors.push('Empty file');
    return result;
  }
  const header = all[headerIdx].map((c) => c.trim());
  if (header.length < 6 || !/date/i.test(header[0])) {
    errors.push('Unexpected header — expected "Date,Description,Category,Cost,Currency,<member>,…"');
    return result;
  }
  result.memberNames = header.slice(5);
  const memberCount = result.memberNames.length;

  for (let r = headerIdx + 1; r < all.length; r++) {
    const cells = all[r];
    if (isBlankRow(cells)) continue;
    const lineNo = r + 1;
    const description = (cells[1] ?? '').trim();
    if (/^total balance$/i.test(description)) continue; // footer

    const date = (cells[0] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`Line ${lineNo}: bad date "${date}" (expected YYYY-MM-DD)`);
      continue;
    }
    const category = (cells[2] ?? '').trim() || 'General';
    const amountCents = parseAmountToCents(cells[3] ?? '');
    if (amountCents == null) {
      errors.push(`Line ${lineNo}: non-numeric cost "${cells[3] ?? ''}"`);
      continue;
    }
    const currency = (cells[4] ?? '').trim();
    if (!currency) {
      errors.push(`Line ${lineNo}: missing currency`);
      continue;
    }
    const netByColumn: number[] = [];
    let bad = false;
    for (let m = 0; m < memberCount; m++) {
      const raw = (cells[5 + m] ?? '').trim();
      const c = raw === '' ? 0 : parseAmountToCents(raw);
      if (c == null) {
        errors.push(`Line ${lineNo}: non-numeric balance "${raw}" for ${result.memberNames[m]}`);
        bad = true;
        break;
      }
      netByColumn.push(c);
    }
    if (bad) continue;

    const sum = netByColumn.reduce((a, b) => a + b, 0);
    if (Math.abs(sum) > 1) {
      warnings.push(`Line ${lineNo}: member balances sum to ${sum} cents (expected 0)`);
    }
    result.rows.push({
      date,
      description,
      category,
      amountCents: Math.abs(amountCents),
      currency,
      netByColumn,
      isPayment: /^payment$/i.test(category),
    });
  }

  // The group currency is stamped on every imported row, so a mixed-currency
  // export would import with wrong amounts — reject it outright.
  const currencies = [...new Set(result.rows.map((row) => row.currency))];
  if (currencies.length > 1) {
    errors.push(`Mixed currencies in file (${currencies.join(', ')}) — a single currency is required`);
    result.rows = [];
  }

  return result;
}

/** Map signed per-column net cents → netByUserId using the column→userId mapping. */
export function buildNetByUserId(netByColumn: number[], columnUserIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  netByColumn.forEach((c, i) => {
    const uid = columnUserIds[i];
    if (uid && c !== 0) out[uid] = (out[uid] ?? 0) + c;
  });
  return out;
}

/**
 * For a settle-up row, derive payer/payee from the column signs:
 * the member whose net is POSITIVE paid (their balance rose), the NEGATIVE one
 * received. Returns null if the signs aren't a clean pairwise transfer.
 */
export function paymentParties(
  netByColumn: number[],
  columnUserIds: string[],
): { fromUserId: string; toUserId: string; amountCents: number } | null {
  let from = -1;
  let to = -1;
  netByColumn.forEach((c, i) => {
    if (c > 0) from = from === -1 || c > netByColumn[from] ? i : from;
    if (c < 0) to = to === -1 || c < netByColumn[to] ? i : to;
  });
  if (from === -1 || to === -1 || !columnUserIds[from] || !columnUserIds[to]) return null;
  return {
    fromUserId: columnUserIds[from],
    toUserId: columnUserIds[to],
    amountCents: netByColumn[from],
  };
}
