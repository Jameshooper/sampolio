/**
 * Enable Banking — pure computation of the `access.valid_until` we request when
 * starting a consent (no I/O).
 *
 * Each ASPSP publishes a `maximum_consent_validity` (seconds) in `GET /aspsps`;
 * asking for the bank's own maximum means the user re-consents as rarely as that
 * bank allows. Two guards keep it sane: a hard ceiling of
 * `CONSENT_MAX_REQUESTED_VALIDITY_DAYS` (we never ask for more than we'd want to
 * hold a consent), and a `CONSENT_REQUESTED_VALIDITY_DAYS` fallback whenever the
 * bank's figure is unknown or unusable — the ASPSP lookup is best-effort, so a
 * network failure or an unparseable value must degrade to today's behavior rather
 * than break the connect flow. The bank may still shorten what it grants; the
 * returned `access.valid_until` is what's authoritative afterwards.
 */

import {
  CONSENT_MAX_REQUESTED_VALIDITY_DAYS,
  CONSENT_REQUESTED_VALIDITY_DAYS,
} from './constants';

const SECONDS_PER_DAY = 24 * 60 * 60;

export function computeConsentValidUntil(
  nowMs: number,
  maxConsentValiditySeconds: number | undefined
): { validUntilIso: string; source: 'aspsp' | 'fallback' } {
  const ceilingSeconds = CONSENT_MAX_REQUESTED_VALIDITY_DAYS * SECONDS_PER_DAY;
  const usable =
    typeof maxConsentValiditySeconds === 'number' &&
    Number.isFinite(maxConsentValiditySeconds) &&
    maxConsentValiditySeconds > 0;
  const seconds = usable
    ? Math.min(maxConsentValiditySeconds, ceilingSeconds)
    : CONSENT_REQUESTED_VALIDITY_DAYS * SECONDS_PER_DAY;
  return {
    validUntilIso: new Date(nowMs + seconds * 1000).toISOString(),
    source: usable ? 'aspsp' : 'fallback',
  };
}
