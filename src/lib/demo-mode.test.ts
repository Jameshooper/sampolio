import { describe, it, expect, afterEach } from 'vitest';
import { maskMoney, isDemoExemptPath, isDemoMasked, setDemoMask } from './demo-mode';
import { formatCurrency, formatCents } from './constants';

// The placeholder mask: currency symbol + three/two U+2731 HEAVY ASTERISKs
// around a fi-FI decimal comma, with a U+2212 MINUS SIGN prefix for negatives.
const MASK_EUR = '€✱✱✱,✱✱';
const MASK_EUR_NEG = '−€✱✱✱,✱✱';

// The mask is a process-wide flag; always leave it OFF for other test files.
afterEach(() => setDemoMask(false));

describe('maskMoney', () => {
  it('renders the euro placeholder for a positive value', () => {
    expect(maskMoney('€', false)).toBe(MASK_EUR);
    expect(maskMoney('€', false)).toBe('€✱✱✱,✱✱');
  });

  it('prefixes a U+2212 minus for a negative value', () => {
    expect(maskMoney('€', true)).toBe(MASK_EUR_NEG);
    expect(maskMoney('€', true)).toBe('−€✱✱✱,✱✱');
  });

  it('reuses whatever currency symbol it is given', () => {
    expect(maskMoney('$', false)).toBe('$✱✱✱,✱✱');
    expect(maskMoney('R$', true)).toBe('−R$✱✱✱,✱✱');
  });
});

describe('isDemoExemptPath', () => {
  it('exempts /mortgage and /split and their sub-paths', () => {
    expect(isDemoExemptPath('/mortgage')).toBe(true);
    expect(isDemoExemptPath('/mortgage/x')).toBe(true);
    expect(isDemoExemptPath('/split')).toBe(true);
    expect(isDemoExemptPath('/split/abc')).toBe(true);
  });

  it('does not exempt other pages or mere prefix collisions', () => {
    expect(isDemoExemptPath('/')).toBe(false);
    expect(isDemoExemptPath('/overview')).toBe(false);
    expect(isDemoExemptPath('/splitters')).toBe(false);
    expect(isDemoExemptPath('/mortgages-fake')).toBe(false);
  });
});

describe('formatCurrency / formatCents integration with the demo mask', () => {
  it('formats real values when the mask is off', () => {
    expect(isDemoMasked()).toBe(false);
    expect(formatCurrency(1234.5, 'EUR')).not.toBe(MASK_EUR);
    expect(formatCents(123450, 'EUR')).not.toBe(MASK_EUR);
  });

  it('masks both formatCurrency and (its wrapper) formatCents when on', () => {
    setDemoMask(true);
    expect(formatCurrency(1234.5, 'EUR')).toBe(MASK_EUR);
    expect(formatCurrency(-9.99, 'EUR')).toBe(MASK_EUR_NEG);
    expect(formatCents(123450, 'EUR')).toBe(MASK_EUR);
    expect(formatCents(-999, 'EUR')).toBe(MASK_EUR_NEG);
  });
});
