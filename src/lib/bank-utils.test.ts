import { describe, it, expect } from 'vitest';
import {
  getConsentExpiryInfo,
  isConsentExpiringSoon,
  maskIban,
  nextConsecutiveSyncFailures,
  isSyncFailing,
  sortConnectionsByAccountOrder,
  effectiveCardNumbers,
  txDisplayDate,
} from './bank-utils';
import { SYNC_FAILURE_ALERT_THRESHOLD } from './bank/constants';
import type { BankAccountLink, BankConnection } from '@/types';

const now = new Date('2026-06-24T12:00:00.000Z');

function conn(overrides: Partial<BankConnection>): Pick<BankConnection, 'status' | 'consentExpiresAt'> {
  return { status: 'active', ...overrides } as BankConnection;
}

describe('getConsentExpiryInfo', () => {
  it('flags an active consent far from expiry as fine', () => {
    const info = getConsentExpiryInfo(conn({ consentExpiresAt: '2026-12-01T00:00:00.000Z' }), now);
    expect(info.expired).toBe(false);
    expect(info.expiringSoon).toBe(false);
    expect(info.daysUntilExpiry).toBeGreaterThan(14);
  });

  it('flags a consent within the warning window as expiring soon', () => {
    const info = getConsentExpiryInfo(conn({ consentExpiresAt: '2026-07-01T00:00:00.000Z' }), now);
    expect(info.expired).toBe(false);
    expect(info.expiringSoon).toBe(true);
    expect(info.daysUntilExpiry).toBeLessThanOrEqual(14);
  });

  it('flags a past expiry as expired', () => {
    const info = getConsentExpiryInfo(conn({ consentExpiresAt: '2026-06-01T00:00:00.000Z' }), now);
    expect(info.expired).toBe(true);
    expect(info.expiringSoon).toBe(false);
  });

  it('treats an expired status as expired even without a date', () => {
    const info = getConsentExpiryInfo(conn({ status: 'expired', consentExpiresAt: undefined }), now);
    expect(info.expired).toBe(true);
    expect(info.daysUntilExpiry).toBeNull();
  });
});

describe('isConsentExpiringSoon', () => {
  it('is true for expired and expiring-soon, false otherwise', () => {
    expect(isConsentExpiringSoon(conn({ consentExpiresAt: '2026-06-01T00:00:00.000Z' }), now)).toBe(true);
    expect(isConsentExpiringSoon(conn({ consentExpiresAt: '2026-07-01T00:00:00.000Z' }), now)).toBe(true);
    expect(isConsentExpiringSoon(conn({ consentExpiresAt: '2026-12-01T00:00:00.000Z' }), now)).toBe(false);
  });
});

describe('nextConsecutiveSyncFailures', () => {
  it('resets to 0 on a clean (ok) run', () => {
    expect(nextConsecutiveSyncFailures(5, 'ok')).toBe(0);
    expect(nextConsecutiveSyncFailures(undefined, 'ok')).toBe(0);
  });

  it('increments on a failing run, treating undefined as 0', () => {
    expect(nextConsecutiveSyncFailures(undefined, 'error')).toBe(1);
    expect(nextConsecutiveSyncFailures(2, 'error')).toBe(3);
    expect(nextConsecutiveSyncFailures(1, 'partial')).toBe(2);
  });

  it('a transient blip that recovers next cycle never reaches the alert threshold', () => {
    // one failure, then a clean sync → back to 0 (e.g. a transient card-endpoint 400)
    const afterBlip = nextConsecutiveSyncFailures(0, 'partial'); // 1
    expect(afterBlip).toBeLessThan(SYNC_FAILURE_ALERT_THRESHOLD);
    expect(nextConsecutiveSyncFailures(afterBlip, 'ok')).toBe(0);
  });
});

describe('isSyncFailing', () => {
  it('is false below the threshold and when unset', () => {
    expect(isSyncFailing({ consecutiveSyncFailures: undefined })).toBe(false);
    expect(isSyncFailing({ consecutiveSyncFailures: SYNC_FAILURE_ALERT_THRESHOLD - 1 })).toBe(false);
  });

  it('is true at or above the threshold', () => {
    expect(isSyncFailing({ consecutiveSyncFailures: SYNC_FAILURE_ALERT_THRESHOLD })).toBe(true);
    expect(isSyncFailing({ consecutiveSyncFailures: SYNC_FAILURE_ALERT_THRESHOLD + 2 })).toBe(true);
  });
});

describe('effectiveCardNumbers', () => {
  it('passthrough: all three reported by the bank', () => {
    expect(
      effectiveCardNumbers({ outstanding: 1800, availableCredit: 8200, creditLimit: 10000 })
    ).toEqual({ outstanding: 1800, availableCredit: 8200, creditLimit: 10000 });
  });

  it('no limit reported: outstanding only, available/limit unknown', () => {
    expect(effectiveCardNumbers({ outstanding: 1500 })).toEqual({
      outstanding: 1500,
      availableCredit: undefined,
      creditLimit: undefined,
    });
  });

  it('manual limit set: derives available credit', () => {
    const eff = effectiveCardNumbers({ outstanding: 1500, manualCreditLimit: 5000 });
    expect(eff.outstanding).toBe(1500);
    expect(eff.creditLimit).toBe(5000);
    expect(eff.availableCredit).toBeCloseTo(3500, 2);
  });

  it('falls back to a negative lastBalance for outstanding', () => {
    expect(effectiveCardNumbers({ lastBalance: -1500 })).toEqual({
      outstanding: 1500,
      availableCredit: undefined,
      creditLimit: undefined,
    });
  });

  it('never returns negative available credit (limit below outstanding)', () => {
    expect(effectiveCardNumbers({ outstanding: 6000, manualCreditLimit: 5000 }).availableCredit).toBe(0);
  });

  it('treats a stale negative stored availableCredit as unknown (pre-fix artifact)', () => {
    expect(effectiveCardNumbers({ availableCredit: -1500, lastBalance: -1500 })).toEqual({
      outstanding: 1500,
      availableCredit: undefined,
      creditLimit: undefined,
    });
  });

  it('empty link → all undefined', () => {
    expect(effectiveCardNumbers({})).toEqual({
      outstanding: undefined,
      availableCredit: undefined,
      creditLimit: undefined,
    });
  });
});

describe('txDisplayDate', () => {
  it('prefers transactionDate over bookingDate', () => {
    expect(txDisplayDate({ transactionDate: '2026-07-01', bookingDate: '2026-07-04' })).toBe('2026-07-01');
  });

  it('falls back to bookingDate when transactionDate is absent', () => {
    expect(txDisplayDate({ bookingDate: '2026-07-04' })).toBe('2026-07-04');
  });

  it('truncates an ISO-datetime value to YYYY-MM-DD', () => {
    expect(txDisplayDate({ transactionDate: '2026-07-01T09:30:00', bookingDate: '2026-07-04' })).toBe('2026-07-01');
    expect(txDisplayDate({ bookingDate: '2026-07-04T00:00:00.000Z' })).toBe('2026-07-04');
  });
});

describe('maskIban', () => {
  it('masks all but the country prefix and last 4', () => {
    expect(maskIban('FI2112345600000785')).toBe('FI••••0785');
    expect(maskIban('FI21 1234 5600 0007 85')).toBe('FI••••0785');
  });
  it('returns a generic mask for short/empty input', () => {
    expect(maskIban('')).toBe('');
    expect(maskIban('FI12')).toBe('••••');
  });
});

describe('sortConnectionsByAccountOrder', () => {
  const link = (id: string): BankAccountLink =>
    ({ id, connectionId: 'c', accountUid: id, currency: 'EUR', accountRole: 'cash' } as BankAccountLink);
  const connection = (id: string, linkIds: string[]): BankConnection =>
    ({ id, linkedAccounts: linkIds.map(link) } as BankConnection);

  const linkIds = (conns: BankConnection[]): string[][] =>
    conns.map((c) => c.linkedAccounts.map((l) => l.id));
  const connIds = (conns: BankConnection[]): string[] => conns.map((c) => c.id);

  it('is identity when order is undefined', () => {
    const conns = [connection('bankA', ['a1', 'a2'])];
    expect(sortConnectionsByAccountOrder(conns, undefined)).toBe(conns);
  });

  it('is identity when order is empty', () => {
    const conns = [connection('bankA', ['a1', 'a2'])];
    expect(sortConnectionsByAccountOrder(conns, [])).toBe(conns);
  });

  it('reorders accounts within a bank by the given order', () => {
    const conns = [connection('bankA', ['a1', 'a2', 'a3'])];
    const sorted = sortConnectionsByAccountOrder(conns, ['a3', 'a1']);
    // a3, a1 ordered first; a2 (unordered) keeps its insertion order after.
    expect(linkIds(sorted)).toEqual([['a3', 'a1', 'a2']]);
  });

  it('reorders banks by their minimum link order index', () => {
    const conns = [connection('bankA', ['a1']), connection('bankB', ['b1'])];
    const sorted = sortConnectionsByAccountOrder(conns, ['b1', 'a1']);
    expect(connIds(sorted)).toEqual(['bankB', 'bankA']);
    expect(linkIds(sorted)).toEqual([['b1'], ['a1']]);
  });

  it('ignores stale ids in the order', () => {
    const conns = [connection('bankA', ['a1', 'a2'])];
    const sorted = sortConnectionsByAccountOrder(conns, ['stale', 'a2', 'gone', 'a1']);
    expect(linkIds(sorted)).toEqual([['a2', 'a1']]);
  });

  it('appends unknown/new accounts after ordered ones, banks with none stay at the end', () => {
    const conns = [
      connection('bankA', ['a1', 'a2']),
      connection('bankB', ['b1']), // fully unordered → stays at end in place
    ];
    const sorted = sortConnectionsByAccountOrder(conns, ['a2']);
    // Within bankA: a2 (ordered) then a1 (new/unknown, insertion order).
    expect(linkIds(sorted)).toEqual([['a2', 'a1'], ['b1']]);
    expect(connIds(sorted)).toEqual(['bankA', 'bankB']);
  });

  it('does not mutate the input connections', () => {
    const conns = [connection('bankA', ['a1', 'a2'])];
    const before = linkIds(conns);
    sortConnectionsByAccountOrder(conns, ['a2', 'a1']);
    expect(linkIds(conns)).toEqual(before);
  });
});
