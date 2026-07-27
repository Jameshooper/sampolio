import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseAmountToCents,
  parseSplitwiseCsv,
  buildNetByUserId,
  paymentParties,
} from './split-csv';

describe('parseCsv (RFC4180)', () => {
  it('handles quoted commas and "" escapes', () => {
    const rows = parseCsv('a,"b, still b","say ""hi""",d\n1,2,3,4');
    expect(rows[0]).toEqual(['a', 'b, still b', 'say "hi"', 'd']);
    expect(rows[1]).toEqual(['1', '2', '3', '4']);
  });

  it('handles CRLF and a trailing newline', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual(['1', '2']);
  });
});

describe('parseAmountToCents', () => {
  it('parses dot-decimal, comma-decimal and thousands forms', () => {
    expect(parseAmountToCents('197.80')).toBe(19780);
    expect(parseAmountToCents('-98.90')).toBe(-9890);
    expect(parseAmountToCents('98,90')).toBe(9890);
    expect(parseAmountToCents('1.234,56')).toBe(123456);
    expect(parseAmountToCents('1,234.56')).toBe(123456);
    expect(parseAmountToCents('54321.07')).toBe(5432107);
    expect(parseAmountToCents('')).toBeNull();
    expect(parseAmountToCents('  ')).toBeNull();
  });
});

describe('parseSplitwiseCsv', () => {
  const csv = [
    'Date,Description,Category,Cost,Currency,Alex Rivera,Sam Chen',
    '',
    '2022-11-25,Desk lamp,Furniture,200.00,EUR,-100.00,100.00',
    '2023-12-01,"Gifts, wrapping, and cards",Gifts,50.00,EUR,-25.00,25.00',
    '2022-12-01,Alex R. paid Sam C.,Payment,250.00,EUR,250.00,-250.00',
    '2026-07-01,Total balance, , ,EUR,-1500.00,1500.00',
    '',
  ].join('\n');

  it('extracts member names and skips header/blank/footer rows', () => {
    const res = parseSplitwiseCsv(csv);
    expect(res.memberNames).toEqual(['Alex Rivera', 'Sam Chen']);
    expect(res.errors).toEqual([]);
    expect(res.rows).toHaveLength(3);
  });

  it('keeps quoted-comma descriptions intact and copies signed net cents', () => {
    const res = parseSplitwiseCsv(csv);
    expect(res.rows[0]).toMatchObject({
      description: 'Desk lamp',
      category: 'Furniture',
      amountCents: 20000,
      netByColumn: [-10000, 10000],
      isPayment: false,
    });
    expect(res.rows[1].description).toBe('Gifts, wrapping, and cards');
    expect(res.rows[2]).toMatchObject({ isPayment: true, netByColumn: [25000, -25000] });
  });

  it('rejects a mixed-currency file outright', () => {
    const mixed = [
      'Date,Description,Category,Cost,Currency,Alex Rivera,Sam Chen',
      '2022-11-25,Lamps,Furniture,200.00,EUR,-100.00,100.00',
      '2022-11-26,Dinner,Food,80.00,SEK,-40.00,40.00',
    ].join('\n');
    const res = parseSplitwiseCsv(mixed);
    expect(res.rows).toHaveLength(0);
    expect(res.errors.some((e) => e.includes('EUR') && e.includes('SEK'))).toBe(true);
  });

  it('accepts a single-currency file', () => {
    const res = parseSplitwiseCsv(csv);
    expect(res.errors).toEqual([]);
    expect(res.rows.every((r) => r.currency === 'EUR')).toBe(true);
  });
});

describe('column → member mapping', () => {
  it('builds netByUserId from columns', () => {
    expect(buildNetByUserId([-10000, 10000], ['alex', 'sam'])).toEqual({ alex: -10000, sam: 10000 });
  });

  it('derives payment parties from the column signs', () => {
    expect(paymentParties([25000, -25000], ['alex', 'sam'])).toEqual({
      fromUserId: 'alex',
      toUserId: 'sam',
      amountCents: 25000,
    });
  });
});

// Reconciliation against real Splitwise exports lives in the gitignored
// `split-csv.local.test.ts` — it needs actual export files at the repo root, so
// it is kept out of version control along with the figures it asserts.
