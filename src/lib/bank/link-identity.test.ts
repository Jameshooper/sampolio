import { describe, it, expect } from 'vitest';
import {
  linkIdentityKey,
  linkIdentityHashes,
  linksShareIdentity,
  isLinkFresh,
} from './link-identity';

describe('linkIdentityKey', () => {
  it('prefers identificationHash over iban and id', () => {
    expect(linkIdentityKey({ id: 'link-1', iban: 'FI0001', identificationHash: 'hash-1' })).toBe('hash-1');
  });

  it('falls back to iban when there is no hash', () => {
    expect(linkIdentityKey({ id: 'link-1', iban: 'FI0001', identificationHash: undefined })).toBe('FI0001');
  });

  it('falls back to the link id as a last resort', () => {
    expect(linkIdentityKey({ id: 'link-1', iban: undefined, identificationHash: undefined })).toBe('link-1');
  });

  it('is unchanged by the hash ARRAY (the scheduler budget key must stay stable)', () => {
    // Widening *matching* must never widen the key: existing budget buckets keep
    // the exact same identity they had before identificationHashes existed.
    const link = {
      id: 'link-1',
      iban: 'FI0001',
      identificationHash: 'hash-primary',
      identificationHashes: ['hash-primary', 'hash-secondary'],
    };
    expect(linkIdentityKey(link)).toBe('hash-primary');
    expect(linkIdentityKey({ id: 'link-2', iban: 'FI0002', identificationHash: undefined })).toBe('FI0002');
  });
});

describe('linkIdentityHashes', () => {
  it('returns the deduped union of the array and the singular hash', () => {
    expect(
      linkIdentityHashes({
        identificationHash: 'hash-b',
        identificationHashes: ['hash-a', 'hash-b'],
      })
    ).toEqual(['hash-a', 'hash-b']);
  });

  it('appends a singular hash that is missing from the array', () => {
    expect(
      linkIdentityHashes({ identificationHash: 'hash-c', identificationHashes: ['hash-a'] })
    ).toEqual(['hash-a', 'hash-c']);
  });

  it('handles a legacy link with only the singular hash', () => {
    expect(linkIdentityHashes({ identificationHash: 'hash-a' })).toEqual(['hash-a']);
  });

  it('is empty when the link has no hashes at all', () => {
    expect(linkIdentityHashes({})).toEqual([]);
    expect(linkIdentityHashes({ identificationHashes: [] })).toEqual([]);
  });
});

describe('linksShareIdentity', () => {
  const link = (o: Partial<Parameters<typeof linksShareIdentity>[0]> = {}) => ({
    id: 'link-1',
    iban: undefined,
    identificationHash: undefined,
    identificationHashes: undefined,
    ...o,
  });

  it('matches when the hash sets intersect on a SECONDARY hash', () => {
    // The point of multi-hash matching: EB moved the primary basis, but both
    // sessions still list the same IBAN-derived hash.
    const a = link({ identificationHash: 'hash-iban', identificationHashes: ['hash-iban', 'hash-bban'] });
    const b = link({ id: 'link-2', identificationHash: 'hash-bban', identificationHashes: ['hash-bban', 'hash-iban'] });
    expect(linksShareIdentity(a, b)).toBe(true);
  });

  it('does not match two non-empty but disjoint hash sets', () => {
    const a = link({ identificationHash: 'hash-a1', identificationHashes: ['hash-a1', 'hash-a2'] });
    const b = link({ id: 'link-2', identificationHash: 'hash-b1', identificationHashes: ['hash-b1'] });
    expect(linksShareIdentity(a, b)).toBe(false);
  });

  it('falls back to key equality when one side has no hashes (IBAN match)', () => {
    const a = link({ iban: 'FI0001' });
    const b = link({ id: 'link-2', iban: 'FI0001' });
    expect(linksShareIdentity(a, b)).toBe(true);
  });

  it('falls back to key equality when one side has no hashes (no key survives)', () => {
    const a = link({ id: 'link-1', identificationHashes: ['hash-a'] });
    const b = link({ id: 'link-2' }); // no hash, no iban → keyed by its own id
    expect(linksShareIdentity(a, b)).toBe(false);
  });

  it('behaves exactly as today for legacy singular-hash links', () => {
    const a = link({ identificationHash: 'hash-shared', iban: 'FI0001' });
    const b = link({ id: 'link-2', identificationHash: 'hash-shared', iban: 'FI0002' });
    expect(linksShareIdentity(a, b)).toBe(true);
    expect(linksShareIdentity(a, link({ id: 'link-3', identificationHash: 'hash-other' }))).toBe(false);
  });

  it('does not treat a hash-only link and an iban-only link as siblings', () => {
    const a = link({ identificationHash: 'hash-a', iban: 'FI0001' });
    const b = link({ id: 'link-2', iban: 'FI0001' });
    // b's key is its IBAN, a's is its hash → no key equality, and only one side
    // has hashes, so the intersection path never runs.
    expect(linksShareIdentity(a, b)).toBe(false);
  });
});

describe('isLinkFresh', () => {
  const nowMs = Date.parse('2026-07-10T12:00:00.000Z');
  const intervalMs = 60 * 60 * 1000; // 1h
  const tickMs = 5 * 60 * 1000; // 5m

  it('is false when lastSyncedAt is undefined', () => {
    expect(isLinkFresh(undefined, nowMs, intervalMs, tickMs)).toBe(false);
  });

  it('is false for an unparseable date', () => {
    expect(isLinkFresh('not-a-date', nowMs, intervalMs, tickMs)).toBe(false);
  });

  it('is true when synced well within the interval', () => {
    const lastSyncedAt = new Date(nowMs - 10 * 60 * 1000).toISOString(); // 10m ago
    expect(isLinkFresh(lastSyncedAt, nowMs, intervalMs, tickMs)).toBe(true);
  });

  it('is false once past interval - tick', () => {
    // exactly at the boundary (age === intervalMs - tickMs) → not < → false
    const boundaryAgo = intervalMs - tickMs;
    const lastSyncedAt = new Date(nowMs - boundaryAgo).toISOString();
    expect(isLinkFresh(lastSyncedAt, nowMs, intervalMs, tickMs)).toBe(false);
  });

  it('is true just inside the interval - tick boundary', () => {
    const justInsideAgo = intervalMs - tickMs - 1;
    const lastSyncedAt = new Date(nowMs - justInsideAgo).toISOString();
    expect(isLinkFresh(lastSyncedAt, nowMs, intervalMs, tickMs)).toBe(true);
  });
});
