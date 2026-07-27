import { describe, it, expect } from 'vitest';
import { linkIdentityKey, isLinkFresh } from './link-identity';

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
