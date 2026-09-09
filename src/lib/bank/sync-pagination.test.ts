import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { BankAccountLink, BankConnection, BankTransaction } from '@/types';
import { runSync } from './sync';
import { BankApiError, getAccountTransactions, getAccountBalances } from './client';
import { getBankConnectionById, getBankConnections, getBankSessionSecret, updateBankConnection } from '@/lib/db/bank-connections';
import { getBankTransactions, writeBankTransactions } from '@/lib/db/bank-transactions';
import { getAllUsers } from '@/lib/db/users';
import { TRANSIENT_BACKOFF_MS } from './constants';

vi.mock('./client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./client')>(),
  getAccountTransactions: vi.fn(), getAccountBalances: vi.fn(), getSession: vi.fn(),
}));
vi.mock('next/cache', () => ({ updateTag: vi.fn() }));
vi.mock('@/lib/db/bank-connections', () => ({
  getBankConnectionById: vi.fn(), getBankConnections: vi.fn(),
  getBankSessionSecret: vi.fn(), updateBankConnection: vi.fn(),
}));
vi.mock('@/lib/db/bank-transactions', () => ({ getBankTransactions: vi.fn(), writeBankTransactions: vi.fn() }));
vi.mock('@/lib/db/bank-sync-runs', () => ({ appendBankSyncRun: vi.fn() }));
vi.mock('@/lib/db/users', () => ({ getAllUsers: vi.fn() }));
// No financial-account anchor is configured; all persistence/network boundaries
// used by these scenarios are mocks, so tests never open a real bank ledger.
vi.mock('@/lib/db/accounts', () => ({ getAccountById: vi.fn() }));
vi.mock('@/lib/db/recurring-items', () => ({ getRecurringItems: vi.fn() }));
vi.mock('@/lib/db/planned-items', () => ({ getPlannedItems: vi.fn() }));
vi.mock('@/lib/db/taxed-income', () => ({ getTaxedIncomes: vi.fn() }));
vi.mock('@/lib/db/reconciliation', () => ({ getLatestSnapshot: vi.fn(), createBalanceSnapshot: vi.fn() }));

const nowIso = '2026-09-09T10:00:00.000Z';
const now = Date.parse(nowIso);
function link(id: string, connectionId: string): BankAccountLink {
  return {
    id, connectionId, accountUid: `uid-${id}`, currency: 'EUR', accountRole: 'cash',
    identificationHash: 'shared-hash', identificationHashes: ['shared-hash'],
    syncCursor: { lastBookingDate: '2026-09-07' },
  };
}
function connection(id: string, userId: string, account: BankAccountLink): BankConnection {
  return { id, userId, aspspName: 'Test Bank', aspspCountry: 'FI', status: 'active',
    psuType: 'personal', linkedAccounts: [account], createdAt: nowIso, updatedAt: nowIso };
}
function storedPending(linkedAccountId: string): BankTransaction {
  return { id: `hold-${linkedAccountId}`, linkedAccountId, dedupKey: 'stored-hold',
    bookingDate: '2026-09-08', amount: -17, currency: 'EUR', status: 'pending',
    firstSeenAt: '2026-09-08T10:00:00Z', lastSeenAt: '2026-09-08T10:00:00Z' };
}
function rawTx(ref: string, status = 'BOOK') {
  return { entry_reference: ref, transaction_amount: { amount: '42', currency: 'EUR' },
    credit_debit_indicator: 'DBIT', status, booking_date: '2026-09-09' };
}
let primary: BankConnection;
let sibling: BankConnection;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  primary = connection('primary', 'alex', link('account-a', 'primary'));
  sibling = connection('sibling', 'sam', link('account-b', 'sibling'));
  vi.mocked(getBankConnectionById).mockResolvedValue(primary);
  vi.mocked(getBankSessionSecret).mockResolvedValue({ connectionId: primary.id, state: 'test', sessionId: 'session', createdAt: nowIso });
  vi.mocked(getAllUsers).mockResolvedValue([]);
  vi.mocked(getBankTransactions).mockImplementation(async (_user, accountId) => [storedPending(accountId)]);
  vi.mocked(getAccountBalances).mockResolvedValue({ balances: [] });
});
afterEach(() => { vi.restoreAllMocks(); });
function enableSibling() {
  // Only the user id is read by fan-out; return complete synthetic user records.
  vi.mocked(getAllUsers).mockResolvedValue([{ id: 'sam', name: 'Sam', email: 'sam@example.com',
    passwordHash: 'unused', role: 'user', isActive: true, createdAt: nowIso, updatedAt: nowIso }]);
  vi.mocked(getBankConnections).mockResolvedValue([sibling]);
}
function writtenRows(accountId: string) {
  return vi.mocked(writeBankTransactions).mock.calls.find((call) => call[1] === accountId)?.[2];
}

describe('runSync pagination persistence', () => {
  it.each(['network', 'cycle', 'limit', 'malformed'] as const)(
    'does not persist or fan out an incomplete booked fetch (%s)', async (failure) => {
      enableSibling();
      let page = 0;
      vi.mocked(getAccountTransactions).mockImplementation(async () => {
        page++;
        if (page === 1) return { transactions: [rawTx('partial-booked')], continuation_key: 'next' };
        if (failure === 'network') throw new BankApiError('TRANSIENT', 'Synthetic network failure');
        if (failure === 'malformed') return {};
        return { transactions: [], continuation_key: failure === 'cycle' ? 'next' : `page-${page}` };
      });
      const run = await runSync('alex', 'primary', 'manual', {}, now);
      expect(run.status).toBe('error');
      expect(run.perAccount[0].error).toBe(failure === 'network' ? 'TRANSIENT' : 'BAD_RESPONSE');
      expect(writeBankTransactions).not.toHaveBeenCalled();
      expect(getAccountBalances).not.toHaveBeenCalled();
      expect(getAllUsers).not.toHaveBeenCalled();
      expect(updateBankConnection).toHaveBeenCalledWith('alex', 'primary', expect.objectContaining({
        linkedAccounts: primary.linkedAccounts,
        nextSyncDueAt: new Date(now + TRANSIENT_BACKOFF_MS).toISOString(),
      }));
      expect(vi.mocked(getAccountTransactions).mock.calls).toHaveLength(failure === 'limit' ? 50 : 2);
    }
  );

  it.each(['network', 'cycle', 'limit', 'malformed'] as const)(
    'discards partial pending pages and preserves holds in primary and fan-out (%s)', async (failure) => {
      enableSibling();
      let pendingPage = 0;
      vi.mocked(getAccountTransactions).mockImplementation(async (_uid, query) => {
        if (query?.transactionStatus !== 'PDNG') return { transactions: [rawTx('complete-booked')] };
        pendingPage++;
        if (pendingPage === 1) return { transactions: [rawTx('partial-pending', 'PDNG')], continuation_key: 'next' };
        if (failure === 'network') throw new BankApiError('TRANSIENT', 'Synthetic network failure');
        if (failure === 'malformed') return { transactions: null };
        return { transactions: [], continuation_key: failure === 'cycle' ? 'next' : `page-${pendingPage}` };
      });
      const run = await runSync('alex', 'primary', 'manual', {}, now);
      expect(run.status).toBe('ok');
      expect(run.perAccount[0]).toMatchObject({ pendingFetchOk: false, txAdded: 1, txRemoved: 0 });
      expect(run.perAccount[0].pendingFetched).toBeUndefined();
      for (const accountId of ['account-a', 'account-b']) {
        const rows = writtenRows(accountId)!;
        expect(rows.map((t) => t.dedupKey).sort()).toEqual(['complete-booked', 'stored-hold']);
        expect(rows.find((t) => t.dedupKey === 'stored-hold')?.id).toBe(`hold-${accountId}`);
      }
      const updates = vi.mocked(updateBankConnection).mock.calls;
      expect(updates.find((c) => c[1] === 'primary')?.[2].linkedAccounts?.[0].syncCursor?.backfilledThrough).toBe('2026-09-09');
      expect(updates.find((c) => c[1] === 'sibling')?.[2].linkedAccounts?.[0].syncCursor?.backfilledThrough).toBeUndefined();
    }
  );

  it('prunes expired holds in primary and fan-out after a complete empty pending fetch', async () => {
    enableSibling();
    vi.mocked(getAccountTransactions).mockImplementation(async (_uid, query) => ({
      transactions: query?.transactionStatus === 'PDNG' ? [] : [rawTx('complete-booked')],
      continuation_key: null,
    }));
    const run = await runSync('alex', 'primary', 'manual', {}, now);
    expect(run.perAccount[0]).toMatchObject({ pendingFetchOk: true, pendingFetched: 0, txRemoved: 1 });
    for (const accountId of ['account-a', 'account-b']) {
      expect(writtenRows(accountId)?.map((t) => t.dedupKey)).toEqual(['complete-booked']);
    }
  });
});
