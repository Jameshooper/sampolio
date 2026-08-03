import { describe, it, expect } from 'vitest';
import { guessItemCategory } from './category-utils';
import { ITEM_CATEGORIES } from './constants';

describe('guessItemCategory', () => {
  it('maps common merchants and terms to ITEM_CATEGORIES entries', () => {
    expect(guessItemCategory('Netflix')).toBe('Entertainment');
    expect(guessItemCategory('Prisma groceries')).toBe('Food & Groceries');
    expect(guessItemCategory('Monthly salary')).toBe('Salary');
    expect(guessItemCategory('HSL ticket')).toBe('Transportation');
    expect(guessItemCategory('Home insurance')).toBe('Insurance');
    expect(guessItemCategory('Sähkö bill')).toBe('Utilities');
  });

  it('maps common Finnish merchant names (bank counterparties) to categories', () => {
    expect(guessItemCategory('NESTE TAMPERE')).toBe('Transportation');
    expect(guessItemCategory('HESBURGER HERVANTA')).toBe('Food & Groceries');
    expect(guessItemCategory('ALKO TAMPERE')).toBe('Food & Groceries');
    expect(guessItemCategory('TOKMANNI OY')).toBe('Shopping');
    expect(guessItemCategory('PUUILO TURTOLA')).toBe('Shopping');
    expect(guessItemCategory('Osto Kirpputori Swap & Vintage')).toBe('Shopping');
    expect(guessItemCategory('HELEN OY')).toBe('Utilities');
    expect(guessItemCategory('Mehiläinen Oy')).toBe('Healthcare');
    expect(guessItemCategory('K-CITYMARKET TAMPERE')).toBe('Food & Groceries');
  });

  it('only ever returns valid ITEM_CATEGORIES values', () => {
    const names = ['Netflix', 'salary', 'rent', 'vero', 'random 123', 'lento Helsinki'];
    for (const n of names) {
      const c = guessItemCategory(n);
      if (c !== null) expect(ITEM_CATEGORIES).toContain(c);
    }
  });

  it('returns null for short or unrecognized names', () => {
    expect(guessItemCategory('ab')).toBeNull();
    expect(guessItemCategory('xyzzy plugh')).toBeNull();
  });
});
