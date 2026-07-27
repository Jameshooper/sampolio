/**
 * Enable Banking — configuration + tunable constants.
 *
 * Secrets follow the app convention: ids/URLs in ~/sampolio/.env (baked into the
 * launchd plist), the RSA private key in a 0600 PEM file *outside* the repo,
 * referenced by path. A missing required secret HARD-DISABLES the feature — we
 * never default a secret. `getBankConfig()` returns null in that case and every
 * caller bails out gracefully.
 */

/** Enable Banking API base (override with ENABLE_BANKING_BASE_URL for sandbox). */
export const DEFAULT_API_BASE_URL = 'https://api.enablebanking.com';

/** JWT (Layer A) — app token claims. RS256, header kid = application id. */
export const JWT_ISSUER = 'enablebanking.com';
export const JWT_AUDIENCE = 'api.enablebanking.com';
/** Token lifetime; the API allows max 24h. */
export const JWT_TTL_SECONDS = 23 * 60 * 60; // 23h, a margin under the 24h cap
/** Re-mint this long before expiry so a request never races the boundary. */
export const JWT_REMINT_SKEW_SECONDS = 5 * 60;

/** Consent (Layer B) — how long an access we request (bank may shorten it). */
export const CONSENT_REQUESTED_VALIDITY_DAYS = 180;
/** Warn the user this many days before the consent expires. */
export const CONSENT_EXPIRY_WARNING_DAYS = 14;

/**
 * Transaction windows. The cashflow page now models the past (the bank-actuals
 * retrospective — see the root "Projection Engine" docs), so we backfill as much
 * history as we can: ~24 months. The initial backfill is requested with
 * `strategy: 'longest'` and runs right after consent — i.e. inside the ~1h
 * "fresh session" window where ASPSPs allow deep history (afterwards most cap at
 * ~90 days). There is no fixed API maximum; `longest` fetches from the earliest
 * available transaction without erroring on unavailable periods, so this value is
 * a generous floor (most banks hold 1–3+ years). Note: raising it only deepens
 * *future* backfills — an already-backfilled connection (`syncCursor.backfilledThrough`
 * set) must be reconnected to re-backfill deeper. Incremental syncs use
 * `strategy: 'default'` + INCREMENTAL_OVERLAP_DAYS and are unaffected.
 */
export const BACKFILL_DAYS = 730;
/** Incremental fetches re-pull a small overlap; the dedup upsert absorbs it. */
export const INCREMENTAL_OVERLAP_DAYS = 3;
/**
 * How far back an incremental fetch is stretched to re-cover stored PENDING rows
 * so they get reconciled (confirmed or pruned) even when they take longer than
 * INCREMENTAL_OVERLAP_DAYS to settle. Sized above a credit card's ~30-day
 * authorization hold so a slow pending→booked transition (where the bank rewrites
 * the row's id/counterparty, stranding the old pending) is always re-fetched and
 * the stale pending pruned. Bounds the reach so one stuck pending can't push the
 * window past what a bank serves outside the fresh-consent window (~90 days).
 */
export const PENDING_RECONCILE_LOOKBACK_DAYS = 45;

/**
 * Typical grace period between a card's statement close and its payment-due
 * date. Used only to *suggest* the statement-close day from the due day (the
 * real grace is issuer-specific; the user can override). ~18 days matches a
 * common Finnish setup (e.g. closes ~13th, due ~1st of the next month).
 */
export const STATEMENT_GRACE_DAYS = 18;

/**
 * Rate budget — the documented ASPSP limit is ~4 fetches per day PER ACCOUNT,
 * but that ceiling applies only to *unattended* fetches: a background
 * scheduled sync carries no PSU identity. A manual "Refresh now" is attended —
 * it sends the requester's IP as `PSU-IP-Address` — and is exempt from this
 * limit entirely, so it never draws from this budget. We schedule
 * `MAX_SCHEDULED_FETCHES_PER_DAY` unattended fetches/day and reserve
 * `RESERVED_RETRY_FETCHES` as headroom for an unattended *retry* re-run (e.g.
 * the 1h `TRANSIENT_BACKOFF_MS` backoff can burn a slot before the next
 * regularly-scheduled fetch), so a flaky run never crowds out the rest of the
 * day's scheduled cadence.
 */
export const PER_ACCOUNT_DAILY_LIMIT = 4;
/** Retry headroom — not reserved for manual refreshes, which are exempt above. */
export const RESERVED_RETRY_FETCHES = 1;
export const MAX_SCHEDULED_FETCHES_PER_DAY = 3;
/**
 * Target spacing between scheduled fetches of one underlying account (≈8h at
 * 3/day). Drives `nextSyncDueAt` after a clean run and, via `isLinkFresh`
 * (`link-identity.ts`), lets a scheduled sync skip re-fetching an account
 * another user's sync (or our own) already refreshed within this window —
 * the mechanism that keeps two users sharing one joint account to one fetch
 * per underlying account per cycle instead of one each.
 */
export const SCHEDULED_SYNC_INTERVAL_MS = Math.floor((24 * 60 * 60 * 1000) / MAX_SCHEDULED_FETCHES_PER_DAY);
/** Soft floor between two manual refreshes of the same connection. */
export const MIN_MANUAL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** How often the in-process scheduler wakes to check `nextSyncDueAt`. */
export const SCHEDULER_TICK_MS = 30 * 60 * 1000;
/** Backoff applied after a 429 / rate-limit response. */
export const RATE_LIMIT_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h
/** Backoff applied after a transient (5xx/network) failure. */
export const TRANSIENT_BACKOFF_MS = 60 * 60 * 1000; // 1h

/**
 * Raise the Overview "needs attention" banner once a connection has failed this
 * many syncs in a row. At the 3-per-day scheduled cadence that's ≈1 day, so a
 * one-off transient blip that self-recovers on the next cycle never alarms.
 */
export const SYNC_FAILURE_ALERT_THRESHOLD = 3;

export interface BankConfig {
  appId: string; // the JWT `kid`
  redirectUrl: string; // must match what's registered in the control panel
  baseUrl: string;
  privateKeyFile: string; // path to a 0600 PKCS#8 PEM, outside the repo
}

/**
 * Resolve the Enable Banking configuration from the environment. Returns null
 * (feature disabled) when any required secret is missing — callers must treat
 * null as "feature off", never substitute a default.
 */
export function getBankConfig(): BankConfig | null {
  const appId = process.env.ENABLE_BANKING_APP_ID?.trim();
  const redirectUrl = process.env.ENABLE_BANKING_REDIRECT_URL?.trim();
  const privateKeyFile = process.env.ENABLE_BANKING_PRIVATE_KEY_FILE?.trim();
  const baseUrl = process.env.ENABLE_BANKING_BASE_URL?.trim() || DEFAULT_API_BASE_URL;

  if (!appId || !redirectUrl || !privateKeyFile) {
    return null;
  }
  return { appId, redirectUrl, baseUrl, privateKeyFile };
}

/** True when the feature has all required secrets and is therefore enabled. */
export function isBankFeatureConfigured(): boolean {
  return getBankConfig() !== null;
}

/**
 * Verbose bank-sync logging. When on, the scheduler logs per-tick decisions and
 * the sync logs per-account detail + raw (sanitized) API error bodies — useful
 * when diagnosing "why didn't it sync / why did a fetch fail". Off by default;
 * a concise one-line summary per run is always logged regardless. Enable with
 * BANK_SYNC_VERBOSE=1 (in prod, add it to the launchd plist EnvironmentVariables).
 */
export function isBankSyncVerbose(): boolean {
  const v = process.env.BANK_SYNC_VERBOSE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
