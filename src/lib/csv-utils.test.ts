import { describe, it, expect } from 'vitest';
import { toCsv, formatCsvNumber, slugifyFilename } from './csv-utils';

describe('formatCsvNumber', () => {
  it('uses comma decimals with two digits and no thousands separator', () => {
    expect(formatCsvNumber(1234.5)).toBe('1234,50');
    expect(formatCsvNumber(-7.125)).toBe('-7,13');
    expect(formatCsvNumber(0)).toBe('0,00');
  });
});

describe('toCsv', () => {
  it('joins with semicolons, CRLF endings and a UTF-8 BOM', () => {
    const csv = toCsv([
      ['Date', 'Amount'],
      ['2026-03-14', 240],
    ]);
    expect(csv).toBe('﻿Date;Amount\r\n2026-03-14;240,00\r\n');
  });

  it('quotes cells containing the delimiter, quotes or newlines', () => {
    const csv = toCsv([['a;b', 'say "hi"', 'two\nlines', 'plain']]);
    expect(csv).toBe('﻿"a;b";"say ""hi""";"two\nlines";plain\r\n');
  });

  it('supports a custom delimiter', () => {
    const csv = toCsv([['a', 'b,c']], { delimiter: ',' });
    expect(csv).toBe('﻿a;"b,c"\r\n'.replace(';', ','));
  });

  it('keeps Finnish characters intact', () => {
    expect(toCsv([['Ähtäri', 'mökki']])).toContain('Ähtäri;mökki');
  });
});

describe('slugifyFilename', () => {
  it('lowercases, strips accents and collapses separators', () => {
    expect(slugifyFilename('Research trip abroad')).toBe('research-trip-abroad');
    expect(slugifyFilename('Mökki – Ähtäri 2026!')).toBe('mokki-ahtari-2026');
  });

  it('falls back when nothing survives', () => {
    expect(slugifyFilename('···')).toBe('budget');
  });
});
