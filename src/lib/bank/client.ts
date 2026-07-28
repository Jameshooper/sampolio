/**
 * Enable Banking — REST client (native fetch, typed errors).
 *
 * Thin transport: mints the app token, calls the API, and maps failures to a
 * typed `BankApiError`. It returns RAW JSON — shaping/validation lives in the
 * pure mappers + Zod parsers, so this stays a single place for auth + error
 * handling. Never logs request bodies, tokens, IBANs, codes, or amounts.
 */

import { getAppToken } from './jwt';
import { getBankConfig } from './constants';

export type BankErrorCode =
  | 'NOT_CONFIGURED'
  | 'EXPIRED_SESSION'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'TRANSIENT'
  | 'BAD_RESPONSE'
  | 'UNKNOWN';

export class BankApiError extends Error {
  code: BankErrorCode;
  status?: number;
  apiCode?: string; // the bank's machine code, e.g. ASPSP_RATE_LIMIT_EXCEEDED
  detail?: string; // the API error message/body (may be PII-ish — verbose logs only)
  constructor(
    code: BankErrorCode,
    message: string,
    opts?: { status?: number; apiCode?: string; detail?: string }
  ) {
    super(message);
    this.name = 'BankApiError';
    this.code = code;
    this.status = opts?.status;
    this.apiCode = opts?.apiCode;
    this.detail = opts?.detail;
  }
}

/**
 * Produce a PII-free, log-safe description of a bank error. This is the DEFAULT
 * for anything persisted or logged without the verbose flag — it never includes
 * the API `detail` body.
 */
export function redactBankError(err: unknown): string {
  if (err instanceof BankApiError) {
    return [err.code, err.apiCode && `(${err.apiCode})`, err.status && `[${err.status}]`]
      .filter(Boolean)
      .join(' ');
  }
  if (err instanceof Error) return err.name; // name only — message may carry PII
  return 'UNKNOWN';
}

/**
 * Like `redactBankError` but also appends the API `detail` body (truncated).
 * The detail can carry richer/PII-ish text, so ONLY use this for verbose logs
 * (gated by `isBankSyncVerbose`), never for persisted fields or default logs.
 */
export function describeBankError(err: unknown): string {
  const base = redactBankError(err);
  if (err instanceof BankApiError && err.detail) {
    return `${base} detail=${JSON.stringify(err.detail.slice(0, 300))}`;
  }
  return base;
}

function mapStatusToCode(status: number, apiCode?: string): BankErrorCode {
  if (status === 401) return 'EXPIRED_SESSION';
  if (status === 403) return 'AUTH_FAILED';
  if (status === 429 || apiCode === 'ASPSP_RATE_LIMIT_EXCEEDED') return 'RATE_LIMITED';
  if (status >= 500) return 'TRANSIENT';
  if (apiCode === 'EXPIRED_SESSION') return 'EXPIRED_SESSION';
  return 'UNKNOWN';
}

interface FetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  psuIp?: string; // when present, sent as PSU-IP-Address (higher rate allowance)
}

async function ebFetch<T>(pathAndQuery: string, opts: FetchOptions = {}): Promise<T> {
  const config = getBankConfig();
  if (!config) {
    throw new BankApiError('NOT_CONFIGURED', 'Enable Banking is not configured');
  }

  let token: string;
  try {
    token = await getAppToken();
  } catch {
    throw new BankApiError('NOT_CONFIGURED', 'Failed to mint app token');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.psuIp) headers['PSU-IP-Address'] = opts.psuIp;

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${pathAndQuery}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    // Network failure — transient, no detail (could carry the URL).
    throw new BankApiError('TRANSIENT', 'Network error contacting Enable Banking');
  }

  if (!res.ok) {
    let apiCode: string | undefined;
    let detail: string | undefined;
    try {
      const raw = await res.text();
      try {
        const errBody = JSON.parse(raw) as {
          code?: string;
          error?: string;
          message?: string;
          error_description?: string;
          detail?: string;
        };
        apiCode = errBody.code ?? errBody.error;
        // The human-readable reason (e.g. why a 400 was rejected). Kept off the
        // default logs; surfaced only via describeBankError under the verbose flag.
        detail =
          errBody.message ?? errBody.error_description ?? errBody.detail ?? (raw || undefined);
      } catch {
        // non-JSON error body — keep the raw text as the detail
        detail = raw || undefined;
      }
    } catch {
      // body unreadable — ignore
    }
    throw new BankApiError(mapStatusToCode(res.status, apiCode), `HTTP ${res.status}`, {
      status: res.status,
      apiCode,
      detail,
    });
  }

  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new BankApiError('BAD_RESPONSE', 'Malformed JSON from Enable Banking');
  }
}

// ============================================================
// Endpoints
// ============================================================

export async function getAspsps(country: string): Promise<unknown> {
  return ebFetch(`/aspsps?country=${encodeURIComponent(country)}`);
}

export interface StartAuthorizationInput {
  aspspName: string;
  aspspCountry: string;
  state: string;
  redirectUrl: string;
  validUntilIso: string; // access.valid_until
  language?: string; // e.g. 'en'
}

export async function startAuthorization(
  input: StartAuthorizationInput
): Promise<{ url: string; authorization_id: string }> {
  const body = {
    access: { valid_until: input.validUntilIso },
    aspsp: { name: input.aspspName, country: input.aspspCountry },
    psu_type: 'personal',
    state: input.state,
    redirect_url: input.redirectUrl,
    ...(input.language ? { language: input.language } : {}),
  };
  return ebFetch<{ url: string; authorization_id: string }>(`/auth`, { method: 'POST', body });
}

export async function createSession(code: string): Promise<unknown> {
  return ebFetch(`/sessions`, { method: 'POST', body: { code } });
}

export async function getAccountBalances(accountUid: string, psuIp?: string): Promise<unknown> {
  return ebFetch(`/accounts/${encodeURIComponent(accountUid)}/balances`, { psuIp });
}

export interface TransactionsQuery {
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string;
  continuationKey?: string;
  strategy?: 'default' | 'longest';
  // Omitted ⇒ every ASPSP returns booked rows only; 'PDNG' asks for the
  // pending/authorized-not-yet-booked set, which needs its own request.
  transactionStatus?: string;
}

export async function getAccountTransactions(
  accountUid: string,
  query: TransactionsQuery = {},
  psuIp?: string
): Promise<unknown> {
  const params = new URLSearchParams();
  if (query.dateFrom) params.set('date_from', query.dateFrom);
  if (query.dateTo) params.set('date_to', query.dateTo);
  if (query.continuationKey) params.set('continuation_key', query.continuationKey);
  if (query.strategy) params.set('strategy', query.strategy);
  if (query.transactionStatus) params.set('transaction_status', query.transactionStatus);
  const qs = params.toString();
  return ebFetch(
    `/accounts/${encodeURIComponent(accountUid)}/transactions${qs ? `?${qs}` : ''}`,
    { psuIp }
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  await ebFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

/**
 * Session details, including `accounts_data: [{ uid, identification_hash }]` —
 * used to backfill a stored link's stable `identificationHash` (see
 * mapSessionAccountHashes + sync.ts). This is an Enable Banking-side lookup on
 * our own session, not an ASPSP data fetch, so it costs no bank rate allowance.
 */
export async function getSession(sessionId: string): Promise<unknown> {
  return ebFetch(`/sessions/${encodeURIComponent(sessionId)}`);
}
