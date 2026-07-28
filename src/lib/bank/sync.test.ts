import { describe, it, expect } from 'vitest';
import { shouldFetchPending } from './sync';

describe('shouldFetchPending', () => {
  const today = '2026-07-28';

  it('always fetches on an attended run (PSU IP present, rate limit exempt)', () => {
    expect(shouldFetchPending(true, undefined, today)).toBe(true);
    expect(shouldFetchPending(true, '2026-07-28T09:00:00.000Z', today)).toBe(true);
  });

  it('fetches when the account has never synced', () => {
    expect(shouldFetchPending(false, undefined, today)).toBe(true);
  });

  it('fetches on the first unattended sync of the UTC day', () => {
    expect(shouldFetchPending(false, '2026-07-27T23:59:59.999Z', today)).toBe(true);
  });

  it('skips a later unattended sync on the same UTC day', () => {
    expect(shouldFetchPending(false, '2026-07-28T00:00:00.000Z', today)).toBe(false);
    expect(shouldFetchPending(false, '2026-07-28T09:00:00.000Z', today)).toBe(false);
  });
});
