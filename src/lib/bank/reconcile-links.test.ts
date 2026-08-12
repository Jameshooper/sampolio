import { describe, it, expect } from 'vitest';
import { reconcileLinks } from './reconcile-links';
import type { BankAccountLink } from '@/types';
import type { MappedBankAccount } from './mappers';

function priorLink(overrides: Partial<BankAccountLink> = {}): BankAccountLink {
  return {
    id: 'stable-link-1',
    connectionId: 'conn-old',
    accountUid: 'uid-1',
    iban: 'FI0000000001',
    name: 'Bank name',
    customName: 'My checking',
    currency: 'EUR',
    accountRole: 'cash',
    linkedFinancialAccountId: 'acc-1',
    statementDay: 13,
    paymentDueDay: 1,
    syncCursor: {
      lastBookingDate: '2026-06-15',
      lastSeenEntryRefs: ['a', 'b'],
      backfilledThrough: '2026-06-30',
    },
    ...overrides,
  };
}

const mapped = (overrides: Partial<MappedBankAccount> = {}): MappedBankAccount => ({
  accountUid: 'uid-1',
  iban: 'FI0000000001',
  name: 'Bank name refreshed',
  currency: 'EUR',
  accountRole: 'cash',
  ...overrides,
});

describe('reconcileLinks', () => {
  it('preserves the stable id + user config on re-consent (matched by accountUid)', () => {
    const [link] = reconcileLinks([priorLink()], [mapped()], 'conn-new');
    expect(link.id).toBe('stable-link-1'); // stable id kept
    expect(link.connectionId).toBe('conn-new'); // re-pointed at the (same) connection
    expect(link.customName).toBe('My checking'); // user config preserved
    expect(link.linkedFinancialAccountId).toBe('acc-1');
    expect(link.accountRole).toBe('cash');
    expect(link.statementDay).toBe(13);
    expect(link.paymentDueDay).toBe(1);
  });

  it('clears backfilledThrough on re-consent so the next sync re-runs a deep backfill', () => {
    const [link] = reconcileLinks([priorLink()], [mapped()], 'conn-new');
    expect(link.syncCursor?.backfilledThrough).toBeUndefined();
    // the incremental cursor fields are otherwise preserved
    expect(link.syncCursor?.lastBookingDate).toBe('2026-06-15');
    // sanity: this is exactly what the sync engine treats as "needs backfill"
    expect(!link.syncCursor?.backfilledThrough).toBe(true);
  });

  it('re-matches by IBAN when the accountUid changed across re-consent', () => {
    const prior = priorLink({ accountUid: 'old-uid' });
    const [link] = reconcileLinks([prior], [mapped({ accountUid: 'new-uid' })], 'conn-new');
    expect(link.id).toBe('stable-link-1'); // matched via IBAN, kept its id
    expect(link.accountUid).toBe('new-uid'); // updated to the fresh uid
  });

  it('creates a fresh link with no cursor for a newly-seen account', () => {
    const [link] = reconcileLinks([], [mapped({ accountUid: 'brand-new', iban: 'FI9999' })], 'conn-new');
    expect(link.id).not.toBe('stable-link-1');
    expect(link.id).toBeTruthy();
    expect(link.syncCursor).toBeUndefined(); // → first sync is a backfill
    expect(link.accountRole).toBe('cash');
  });

  it('does not crash when a prior link has no syncCursor', () => {
    const [link] = reconcileLinks([priorLink({ syncCursor: undefined })], [mapped()], 'conn-new');
    expect(link.syncCursor).toBeUndefined();
    expect(link.id).toBe('stable-link-1');
  });

  it('re-matches by identificationHash when the uid rotated and there is no IBAN (the card case)', () => {
    const prior = priorLink({ accountUid: 'old-uid', iban: undefined, identificationHash: 'hash-stable-1' });
    const [link] = reconcileLinks(
      [prior],
      [mapped({ accountUid: 'new-uid', iban: undefined, identificationHash: 'hash-stable-1' })],
      'conn-new'
    );
    expect(link.id).toBe('stable-link-1'); // matched via hash, kept its id + user config
    expect(link.accountUid).toBe('new-uid');
    expect(link.customName).toBe('My checking');
    expect(link.linkedFinancialAccountId).toBe('acc-1');
    expect(link.statementDay).toBe(13);
    expect(link.syncCursor?.backfilledThrough).toBeUndefined(); // still a re-consent
    expect(link.identificationHash).toBe('hash-stable-1'); // hash retained
  });

  it('stores a freshly-observed hash on a prior link that had none', () => {
    const prior = priorLink({ identificationHash: undefined });
    const [link] = reconcileLinks([prior], [mapped({ identificationHash: 'hash-new' })], 'conn-new');
    expect(link.identificationHash).toBe('hash-new');
  });

  it('still creates a new link when a prior hash-less link has no IBAN and the uid rotates (pre-backfill limitation)', () => {
    const prior = priorLink({ accountUid: 'old-uid', iban: undefined, identificationHash: undefined });
    const [link] = reconcileLinks(
      [prior],
      [mapped({ accountUid: 'new-uid', iban: undefined, identificationHash: undefined })],
      'conn-new'
    );
    expect(link.id).not.toBe('stable-link-1'); // no key survived re-consent → orphaned history
  });

  it('re-matches on a SECONDARY hash when the primary rotated (multi-basis account)', () => {
    // EB hashes every identification basis; across re-consent the singular
    // `identification_hash` moved from the IBAN- to the BBAN-derived one. The set
    // intersection still ties the two together, so the link id + card config live.
    const prior = priorLink({
      accountUid: 'old-uid',
      iban: undefined,
      identificationHash: 'hash-iban',
      identificationHashes: ['hash-iban', 'hash-bban'],
    });
    const [link] = reconcileLinks(
      [prior],
      [
        mapped({
          accountUid: 'new-uid',
          iban: undefined,
          identificationHash: 'hash-bban',
          identificationHashes: ['hash-bban', 'hash-new-basis'],
        }),
      ],
      'conn-new'
    );
    expect(link.id).toBe('stable-link-1');
    expect(link.accountUid).toBe('new-uid');
    expect(link.customName).toBe('My checking');
    expect(link.statementDay).toBe(13);
    expect(link.linkedFinancialAccountId).toBe('acc-1');
    expect(link.identificationHash).toBe('hash-bban'); // fresh primary wins
    expect(link.syncCursor?.backfilledThrough).toBeUndefined(); // still a re-consent
    // Union merge: the set only grows, so a future re-consent has more to match on.
    expect(link.identificationHashes).toEqual(['hash-iban', 'hash-bban', 'hash-new-basis']);
  });

  it('matches a legacy singular-hash link against an incoming array containing it', () => {
    const prior = priorLink({ accountUid: 'old-uid', iban: undefined, identificationHash: 'hash-legacy' });
    const [link] = reconcileLinks(
      [prior],
      [
        mapped({
          accountUid: 'new-uid',
          iban: undefined,
          identificationHash: 'hash-other-basis',
          identificationHashes: ['hash-other-basis', 'hash-legacy'],
        }),
      ],
      'conn-new'
    );
    expect(link.id).toBe('stable-link-1');
    expect(link.identificationHashes).toEqual(['hash-legacy', 'hash-other-basis']);
  });

  it('treats an empty incoming hash array as absent (falls through to uid/IBAN)', () => {
    const prior = priorLink({ identificationHash: undefined, identificationHashes: [] });
    const [link] = reconcileLinks(
      [prior],
      [mapped({ identificationHash: undefined, identificationHashes: [] })],
      'conn-new'
    );
    expect(link.id).toBe('stable-link-1'); // matched by uid/IBAN as before
    expect(link.identificationHashes).toBeUndefined(); // never stored as an empty array
  });

  it('does not match two accounts whose non-empty hash sets are disjoint', () => {
    const prior = priorLink({
      accountUid: 'old-uid',
      iban: undefined,
      identificationHash: 'hash-a1',
      identificationHashes: ['hash-a1', 'hash-a2'],
    });
    const [link] = reconcileLinks(
      [prior],
      [
        mapped({
          accountUid: 'new-uid',
          iban: undefined,
          identificationHash: 'hash-b1',
          identificationHashes: ['hash-b1'],
        }),
      ],
      'conn-new'
    );
    expect(link.id).not.toBe('stable-link-1'); // a different account
  });

  it('copies the mapped hash array onto a brand-new link', () => {
    const [link] = reconcileLinks(
      [],
      [
        mapped({
          accountUid: 'brand-new',
          iban: 'FI9999',
          identificationHash: 'hash-x',
          identificationHashes: ['hash-x', 'hash-y'],
        }),
      ],
      'conn-new'
    );
    expect(link.identificationHashes).toEqual(['hash-x', 'hash-y']);
    expect(link.identificationHash).toBe('hash-x');
  });

  it('prefers a hash match over an IBAN match on a different link', () => {
    const hashLink = priorLink({
      id: 'link-by-hash',
      accountUid: 'old-uid-hash',
      iban: 'FI0000000009',
      identificationHash: 'hash-shared',
    });
    const ibanLink = priorLink({
      id: 'link-by-iban',
      accountUid: 'old-uid-iban',
      iban: 'FI0000000001', // matches mapped().iban
      identificationHash: undefined,
    });
    const [link] = reconcileLinks(
      [ibanLink, hashLink],
      [mapped({ accountUid: 'new-uid', identificationHash: 'hash-shared' })],
      'conn-new'
    );
    expect(link.id).toBe('link-by-hash');
  });
});
