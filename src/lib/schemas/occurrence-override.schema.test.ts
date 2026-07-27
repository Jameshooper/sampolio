import { describe, it, expect } from 'vitest';
import { occurrenceOverrideSchema } from './occurrence-override.schema';

describe('occurrenceOverrideSchema', () => {
  it('passes with valid data', () => {
    const result = occurrenceOverrideSchema.safeParse({
      name: 'Rent',
      amount: 1200,
      category: 'Housing',
      skipOccurrence: false,
    });
    expect(result.success).toBe(true);
  });

  it('fails when amount is negative', () => {
    const result = occurrenceOverrideSchema.safeParse({
      name: 'Rent',
      amount: -50,
      category: 'Housing',
      skipOccurrence: false,
    });
    expect(result.success).toBe(false);
  });

  it('fails when name is empty', () => {
    const result = occurrenceOverrideSchema.safeParse({
      name: '',
      amount: 100,
      category: '',
      skipOccurrence: false,
    });
    expect(result.success).toBe(false);
  });

  it('passes with zero amount', () => {
    const result = occurrenceOverrideSchema.safeParse({
      name: 'Free month',
      amount: 0,
      category: '',
      skipOccurrence: false,
    });
    expect(result.success).toBe(true);
  });

  it('passes with skipOccurrence set to true', () => {
    const result = occurrenceOverrideSchema.safeParse({
      name: 'Skipped',
      amount: 500,
      category: 'Misc',
      skipOccurrence: true,
    });
    expect(result.success).toBe(true);
  });
});
