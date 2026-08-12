/**
 * Enable Banking — pure mappers from API JSON to Sampolio types (no I/O).
 *
 * Tolerant by design: missing/odd fields degrade gracefully rather than throw,
 * since real bank responses vary. The action/sync layer assigns stable ids to
 * mapped accounts (re-matching by accountUid/iban across re-consent), so the
 * mappers deliberately produce id-less `MappedBankAccount` records.
 */

import type {
  BankAccountRole,
  BankTransaction,
  BankTransactionStatus,
  Currency,
} from '@/types';
import { CURRENCY_VALUES } from '@/lib/constants';
import { syntheticDedupKey } from './dedup';

// ---------- Raw API shapes (loose) ----------
export interface RawAspsp {
  name?: string;
  country?: string;
  maximum_consent_validity?: number | string | null; // seconds
  required_psu_headers?: string[] | null;
}

export interface RawSessionAccount {
  uid?: string;
  account_id?: { iban?: string } | null;
  identification_hash?: string;
  identification_hashes?: string[];
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
  cash_account_type?: string; // ISO: CACC, CARD, SVGS, TRAN…
  usage?: string; // PRIV / ORGA
}

export interface RawBalance {
  name?: string;
  balance_amount?: { amount?: string | number; currency?: string } | null;
  balance_type?: string; // ISO: CLBD, XPCD, ITAV, OPBD…
}

export interface RawTransaction {
  entry_reference?: string | null;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  transaction_amount?: { amount?: string | number; currency?: string } | null;
  credit_debit_indicator?: string; // CRDT | DBIT
  status?: string; // BOOK | PDNG
  creditor?: { name?: string } | null;
  debtor?: { name?: string } | null;
  creditor_name?: string;
  debtor_name?: string;
  creditor_account?: { iban?: string } | null;
  debtor_account?: { iban?: string } | null;
  remittance_information?: string[] | string | null;
  reference_number?: string | null;
  reference_number_schema?: string | null;
  bank_transaction_code?: { description?: string; code?: string } | string | null;
  merchant_category_code?: string | null;
  balance_after_transaction?: { amount?: string | number; currency?: string } | null;
  note?: string | null;
}

export interface MappedBankAccount {
  accountUid: string;
  identificationHash?: string;
  // Every hash the bank exposed for the account (superset of the singular one).
  identificationHashes?: string[];
  iban?: string;
  name?: string;
  currency: Currency;
  accountRole: BankAccountRole;
}

/** One bank from `GET /aspsps`, with the connect-relevant capability fields. */
export interface AspspDetails {
  name: string;
  country: string;
  /** `maximum_consent_validity` in seconds; absent when missing or nonsensical. */
  maximumConsentValiditySeconds?: number;
  /** PSU headers this bank requires on attended calls; absent when not stated. */
  requiredPsuHeaders?: string[];
}

export interface MappedBalance {
  type: string;
  amount: number;
  currency: Currency;
}

// ---------- Helpers ----------
export function toCurrency(code?: string | null): Currency {
  if (code && (CURRENCY_VALUES as readonly string[]).includes(code)) {
    return code as Currency;
  }
  return 'EUR';
}

function toNumber(v?: string | number | null): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Deduped list of identification hashes for one raw account: the bank's
 * `identification_hashes` array plus the singular `identification_hash` folded in
 * (EB's primary is always one of them, but be defensive). Garbage — a non-array,
 * non-string entries, an empty result — degrades to `undefined`, i.e. "unknown",
 * which every consumer treats the same as a legacy link with no hashes.
 */
function toHashList(
  hashes: unknown,
  singular: string | undefined
): string[] | undefined {
  const out: string[] = [];
  const push = (h: unknown) => {
    if (typeof h === 'string' && h.trim() && !out.includes(h)) out.push(h);
  };
  if (Array.isArray(hashes)) for (const h of hashes) push(h);
  push(singular);
  return out.length ? out : undefined;
}

/** Map a bank's account-type/usage hints to our coarse role. */
export function inferAccountRole(acct: RawSessionAccount): BankAccountRole {
  const t = (acct.cash_account_type ?? '').toUpperCase();
  const product = (acct.product ?? '').toLowerCase();
  if (t === 'CARD' || product.includes('card') || product.includes('credit')) return 'credit-card';
  if (t === 'SVGS' || product.includes('saving')) return 'savings';
  if (t === 'CACC' || t === 'TRAN' || t === 'CASH') return 'cash';
  return 'other';
}

// ---------- Mappers ----------
/**
 * Every bank in a `GET /aspsps` response, with the fields the connect flow cares
 * about. Tolerant: a nameless entry is dropped; a non-finite or non-positive
 * `maximum_consent_validity` and a non-array `required_psu_headers` degrade to
 * `undefined` so callers fall back to their own defaults.
 */
export function mapAspspDetails(rawInput: unknown): AspspDetails[] {
  const raw = (rawInput ?? {}) as { aspsps?: RawAspsp[] };
  const list = raw?.aspsps ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .filter((a): a is RawAspsp => !!a && typeof a.name === 'string' && !!a.name)
    .map((a) => {
      const validity = toNumber(
        typeof a.maximum_consent_validity === 'number' || typeof a.maximum_consent_validity === 'string'
          ? a.maximum_consent_validity
          : null
      );
      const headers = Array.isArray(a.required_psu_headers)
        ? a.required_psu_headers.filter((h): h is string => typeof h === 'string' && !!h.trim())
        : [];
      return {
        name: a.name!,
        country: (a.country ?? '').toUpperCase(),
        maximumConsentValiditySeconds: Number.isFinite(validity) && validity > 0 ? validity : undefined,
        requiredPsuHeaders: headers.length ? headers : undefined,
      } satisfies AspspDetails;
    });
}

/** The bank picker's slim shape (name + country only). */
export function mapAspsps(rawInput: unknown): { name: string; country: string }[] {
  return mapAspspDetails(rawInput).map((a) => ({ name: a.name, country: a.country }));
}

export function mapSessionAccounts(rawInput: unknown): MappedBankAccount[] {
  const raw = (rawInput ?? {}) as { accounts?: RawSessionAccount[] };
  const list = raw?.accounts ?? [];
  return list
    .filter((a): a is RawSessionAccount => !!a && !!a.uid)
    .map((a) => ({
      accountUid: a.uid!,
      identificationHash: a.identification_hash ?? undefined,
      identificationHashes: toHashList(a.identification_hashes, a.identification_hash),
      iban: a.account_id?.iban ?? undefined,
      name: a.name ?? a.product ?? undefined,
      currency: toCurrency(a.currency),
      accountRole: inferAccountRole(a),
    }));
}

/**
 * The parts of a `GET /sessions/{id}` response we act on: the session's own
 * `status` (see `terminalSessionStatus`) and each account's uid ↔ identification
 * hash(es), used to backfill the stable identity onto links created before we
 * started capturing it (see reconcile-links.ts). Tolerant: entries missing a uid
 * or any hash, and a missing/malformed `accounts_data`, are dropped rather than
 * throw.
 */
export function mapSessionDetails(rawInput: unknown): {
  status?: string;
  accounts: { uid: string; identificationHash: string; identificationHashes?: string[] }[];
} {
  const raw = (rawInput ?? {}) as {
    status?: unknown;
    accounts_data?: { uid?: string; identification_hash?: string; identification_hashes?: string[] }[];
  };
  const status = typeof raw?.status === 'string' && raw.status ? raw.status : undefined;
  const list = raw?.accounts_data ?? [];
  if (!Array.isArray(list)) return { status, accounts: [] };
  const accounts = list
    .filter(
      (a): a is { uid: string; identification_hash: string; identification_hashes?: string[] } =>
        !!a && typeof a.uid === 'string' && typeof a.identification_hash === 'string'
    )
    .map((a) => ({
      uid: a.uid,
      identificationHash: a.identification_hash,
      identificationHashes: toHashList(a.identification_hashes, a.identification_hash),
    }));
  return { status, accounts };
}

/**
 * Whether a session `status` means the consent is dead and no further data calls
 * can succeed — `'revoked'` when the PSU pulled consent, `'expired'` for the
 * lifecycle ends (expiry/close/cancel). Anything else, including a status enum
 * value we don't know, returns null (never act on an unrecognized state).
 */
export function terminalSessionStatus(status?: string): 'expired' | 'revoked' | null {
  const s = (status ?? '').trim().toUpperCase();
  if (s === 'REVOKED') return 'revoked';
  if (s === 'EXPIRED' || s === 'CLOSED' || s === 'CANCELLED') return 'expired';
  return null;
}

export function mapBalances(rawInput: unknown): MappedBalance[] {
  const raw = (rawInput ?? {}) as { balances?: RawBalance[] };
  const list = raw?.balances ?? [];
  return list
    .filter((b): b is RawBalance => !!b && !!b.balance_amount)
    .map((b) => ({
      type: (b.balance_type ?? '').toUpperCase(),
      amount: toNumber(b.balance_amount?.amount),
      currency: toCurrency(b.balance_amount?.currency),
    }));
}

/** Preference order for the "real" balance we anchor on / display (deposits):
 * booked/closing first, available last. */
const ANCHOR_BALANCE_PRIORITY = ['CLBD', 'ITBD', 'XPCD', 'OPBD', 'PRCD', 'ITAV'];

/** Pick the most authoritative balance (booked/closing preferred). */
export function pickAnchorBalance(balances: MappedBalance[]): MappedBalance | null {
  for (const type of ANCHOR_BALANCE_PRIORITY) {
    const found = balances.find((b) => b.type === type);
    if (found) return found;
  }
  return balances[0] ?? null;
}

/** Booked/owed balance types for a card, most-authoritative first. */
const CARD_BOOKED_PRIORITY = ['ITBD', 'CLBD', 'OPBD', 'PRCD'];
/** Available-to-spend balance types for a card, most-authoritative first. */
const CARD_AVAILABLE_PRIORITY = ['ITAV', 'XPCD', 'CLAV', 'FWAV'];

/**
 * Split a credit card's balances into the booked amount owed and the available
 * credit. Most banks (e.g. Nordea) return `ITBD` (booked, negative = owed) +
 * `ITAV` (available to spend); both update in real time as the card is used, so
 * the outstanding is accurate without waiting for transactions to post.
 *
 * OP is the exception: it returns EXACTLY ONE balance, a NEGATIVE `ITAV`, which
 * is semantically the used/owed (booked) balance mislabeled as "interim
 * available". So when no real booked balance is present but the available one is
 * negative, reinterpret it as the booked/owed balance (and report no available).
 */
export function pickCardBalances(balances: MappedBalance[]): {
  booked: MappedBalance | null;
  available: MappedBalance | null;
} {
  const firstOf = (priority: string[]): MappedBalance | null => {
    for (const type of priority) {
      const found = balances.find((b) => b.type === type);
      if (found) return found;
    }
    return null;
  };
  const booked = firstOf(CARD_BOOKED_PRIORITY);
  const available = firstOf(CARD_AVAILABLE_PRIORITY);

  if (!booked && available && available.amount < 0) {
    return { booked: available, available: null };
  }
  return { booked, available };
}

function counterpartyOf(t: RawTransaction, signedAmount: number): string | undefined {
  // Money out → the creditor is the counterparty; money in → the debtor.
  const creditor = t.creditor?.name ?? t.creditor_name;
  const debtor = t.debtor?.name ?? t.debtor_name;
  if (signedAmount < 0) return creditor ?? debtor ?? undefined;
  return debtor ?? creditor ?? undefined;
}

function remittanceOf(t: RawTransaction): string | undefined {
  const r = t.remittance_information;
  if (!r) return undefined;
  if (Array.isArray(r)) {
    // Preserve the bank's separate lines (joined with newlines for display);
    // the synthetic dedup key normalizes whitespace so this stays stable.
    const joined = r.map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
    return joined || undefined;
  }
  return r.trim() || undefined;
}

function ibanOf(acct: { iban?: string } | null | undefined): string | undefined {
  return acct?.iban || undefined;
}

function bankCodeOf(t: RawTransaction): string | undefined {
  const c = t.bank_transaction_code;
  if (!c) return undefined;
  if (typeof c === 'string') return c;
  return c.description ?? c.code ?? undefined;
}

function mapStatus(raw?: string): BankTransactionStatus {
  const s = (raw ?? '').toUpperCase();
  if (s === 'BOOK' || s === 'BOOKED') return 'booked';
  if (s === 'PDNG' || s === 'PENDING') return 'pending';
  return 'other';
}

export function mapTransactions(
  rawInput: unknown,
  linkedAccountId: string,
  nowIso: string,
  idFactory: () => string
): { transactions: BankTransaction[]; continuationKey?: string } {
  const raw = (rawInput ?? {}) as { transactions?: RawTransaction[]; continuation_key?: string };
  const list = raw?.transactions ?? [];
  const transactions: BankTransaction[] = list
    .filter((t): t is RawTransaction => !!t)
    .map((t) => {
      const magnitude = Math.abs(toNumber(t.transaction_amount?.amount));
      const indicator = (t.credit_debit_indicator ?? '').toUpperCase();
      const signedAmount = indicator === 'DBIT' ? -magnitude : magnitude;
      const currency = toCurrency(t.transaction_amount?.currency);
      const status = mapStatus(t.status);
      const valueDate = t.value_date || undefined;
      const transactionDate = t.transaction_date || undefined;
      // Prefer the real transaction date over "today" when the bank gives neither
      // a booking nor a value date (OP returns only `transaction_date` for cards),
      // so history doesn't collapse onto the sync day.
      const bookingDate = t.booking_date || valueDate || transactionDate || nowIso.slice(0, 10);
      const counterpartyName = counterpartyOf(t, signedAmount);
      // Counterparty account is the creditor's for money out, debtor's for money in.
      const counterpartyAccount =
        signedAmount < 0 ? ibanOf(t.creditor_account) ?? ibanOf(t.debtor_account) : ibanOf(t.debtor_account) ?? ibanOf(t.creditor_account);
      const remittanceInfo = remittanceOf(t);
      const entryReference = t.entry_reference ?? undefined;
      const balanceAfterRaw = t.balance_after_transaction?.amount;
      const balanceAfter = balanceAfterRaw != null ? toNumber(balanceAfterRaw) : undefined;

      // An `entry_reference` keys both booked AND pending rows: per Enable
      // Banking it is only returned for a pending row when it survives booking
      // unchanged, so it is the strongest pending→booked identity available.
      // `status === 'other'` keeps the synthetic fallback (no such guarantee).
      const dedupKey =
        entryReference && (status === 'booked' || status === 'pending')
          ? entryReference
          : syntheticDedupKey({
              amount: signedAmount,
              currency,
              counterpartyName,
              remittanceInfo,
              valueDate,
            });

      return {
        id: idFactory(),
        linkedAccountId,
        dedupKey,
        entryReference,
        bookingDate,
        valueDate,
        transactionDate,
        amount: signedAmount,
        currency,
        status,
        counterpartyName,
        counterpartyAccount,
        remittanceInfo,
        // Structured creditor reference (viitenumero / RF) — display + search only.
        referenceNumber: t.reference_number?.trim() || undefined,
        referenceNumberSchema: t.reference_number_schema?.trim() || undefined,
        bankTransactionCode: bankCodeOf(t),
        merchantCategoryCode: t.merchant_category_code ?? undefined,
        balanceAfter,
        note: t.note?.trim() || undefined,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      } satisfies BankTransaction;
    });

  return { transactions, continuationKey: raw?.continuation_key };
}
