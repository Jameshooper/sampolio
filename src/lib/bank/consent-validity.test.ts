import { describe, it, expect } from 'vitest';
import { computeConsentValidUntil } from './consent-validity';
import {
  CONSENT_MAX_REQUESTED_VALIDITY_DAYS,
  CONSENT_REQUESTED_VALIDITY_DAYS,
} from './constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.parse('2026-08-12T09:00:00.000Z');
const at = (days: number) => new Date(nowMs + days * DAY_MS).toISOString();

describe('computeConsentValidUntil', () => {
  it('requests the bank’s own maximum when it is below the ceiling', () => {
    // 15552000s = 180d, which is what Finnish banks commonly report — the
    // requested validity is then identical to the hardcoded fallback.
    const out = computeConsentValidUntil(nowMs, 15552000);
    expect(out.source).toBe('aspsp');
    expect(out.validUntilIso).toBe(at(180));
    expect(out.validUntilIso).toBe(at(CONSENT_REQUESTED_VALIDITY_DAYS));
  });

  it('requests a shorter bank maximum verbatim', () => {
    const out = computeConsentValidUntil(nowMs, 90 * 24 * 60 * 60);
    expect(out).toEqual({ validUntilIso: at(90), source: 'aspsp' });
  });

  it('clamps an over-generous bank maximum to the hard ceiling', () => {
    const out = computeConsentValidUntil(nowMs, 60_000_000); // ~694 days
    expect(out.source).toBe('aspsp');
    expect(out.validUntilIso).toBe(at(CONSENT_MAX_REQUESTED_VALIDITY_DAYS));
    expect(CONSENT_MAX_REQUESTED_VALIDITY_DAYS).toBe(365);
  });

  it('falls back to the default validity when the bank figure is unusable', () => {
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = computeConsentValidUntil(nowMs, bad);
      expect(out.source).toBe('fallback');
      expect(out.validUntilIso).toBe(at(CONSENT_REQUESTED_VALIDITY_DAYS));
    }
  });

  it('returns a parseable ISO timestamp', () => {
    const { validUntilIso } = computeConsentValidUntil(nowMs, undefined);
    expect(validUntilIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(validUntilIso)).toBeGreaterThan(nowMs);
  });
});
