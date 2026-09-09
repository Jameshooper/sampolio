import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankTransaction } from '@/types';
import { BankApiError, getAccountTransactions } from './client';
import { fetchAllAccountTransactions } from './transaction-pagination';

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, getAccountTransactions: vi.fn() };
});

const getPage = vi.mocked(getAccountTransactions);
const nowIso = '2026-09-09T10:00:00.000Z';
const psu = { ip: '192.0.2.1', userAgent: 'Browser/1.0' };

function rawTransaction(reference: string) {
  return {
    entry_reference: reference,
    booking_date: '2026-09-08',
    transaction_amount: { amount: '12.50', currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
  };
}

async function fetchPages(
  query: Parameters<typeof fetchAllAccountTransactions>[1] = {
    dateFrom: '2026-09-01',
    dateTo: '2026-09-09',
    strategy: 'longest',
  }
): Promise<BankTransaction[]> {
  let id = 0;
  return fetchAllAccountTransactions('bank/uid', query, psu, 'link-1', nowIso, () =>
    `id-${++id}`
  );
}

function expectRedactedBadResponse(error: unknown): void {
  expect(error).toBeInstanceOf(BankApiError);
  expect(error).toMatchObject({
    code: 'BAD_RESPONSE',
    status: undefined,
    apiCode: undefined,
    detail: undefined,
  });
}

describe('fetchAllAccountTransactions', () => {
  beforeEach(() => {
    getPage.mockReset();
  });

  it('maps and concatenates every page while preserving query, PSU, and opaque tokens', async () => {
    const opaqueToken = 'opaque /+=?& token';
    getPage
      .mockResolvedValueOnce({
        transactions: [rawTransaction('first')],
        continuation_key: opaqueToken,
      })
      .mockResolvedValueOnce({ transactions: [rawTransaction('second')] });

    const transactions = await fetchPages({
      dateFrom: '2026-09-01',
      dateTo: '2026-09-09',
      strategy: 'default',
      transactionStatus: 'PDNG',
    });

    expect(transactions.map((transaction) => transaction.dedupKey)).toEqual(['first', 'second']);
    expect(getPage).toHaveBeenNthCalledWith(
      1,
      'bank/uid',
      {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-09',
        strategy: 'default',
        transactionStatus: 'PDNG',
        continuationKey: undefined,
      },
      psu
    );
    expect(getPage).toHaveBeenNthCalledWith(
      2,
      'bank/uid',
      {
        dateFrom: '2026-09-01',
        dateTo: '2026-09-09',
        strategy: 'default',
        transactionStatus: 'PDNG',
        continuationKey: opaqueToken,
      },
      psu
    );
  });

  it.each([
    ['absent', { transactions: [] }],
    ['null', { transactions: [], continuation_key: null }],
    ['empty string', { transactions: [], continuation_key: '' }],
  ])('ends pagination when the continuation key is %s', async (_label, response) => {
    getPage.mockResolvedValue(response);

    await expect(fetchPages()).resolves.toEqual([]);
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null envelope', null],
    ['array envelope', []],
    ['primitive envelope', 'bad'],
    ['missing transactions', {}],
    ['null transactions', { transactions: null }],
    ['object transactions', { transactions: {} }],
    ['undefined continuation key', { transactions: [], continuation_key: undefined }],
    ['numeric continuation key', { transactions: [], continuation_key: 1 }],
    ['object continuation key', { transactions: [], continuation_key: {} }],
  ])('rejects a malformed %s with a redacted BAD_RESPONSE', async (_label, response) => {
    getPage.mockResolvedValue(response);

    const error = await fetchPages().catch((caught) => caught);

    expectRedactedBadResponse(error);
    expect(error.message).not.toContain(JSON.stringify(response));
  });

  it('rejects a continuation key repeated by the next page', async () => {
    getPage
      .mockResolvedValueOnce({ transactions: [], continuation_key: 'secret-token' })
      .mockResolvedValueOnce({ transactions: [], continuation_key: 'secret-token' });

    const error = await fetchPages().catch((caught) => caught);

    expectRedactedBadResponse(error);
    expect(error.message).not.toContain('secret-token');
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('rejects a longer continuation cycle without exposing its keys', async () => {
    getPage
      .mockResolvedValueOnce({ transactions: [], continuation_key: 'token-a' })
      .mockResolvedValueOnce({ transactions: [], continuation_key: 'token-b' })
      .mockResolvedValueOnce({ transactions: [], continuation_key: 'token-a' });

    const error = await fetchPages().catch((caught) => caught);

    expectRedactedBadResponse(error);
    expect(error.message).not.toMatch(/token-[ab]/);
    expect(getPage).toHaveBeenCalledTimes(3);
  });

  it('accepts exactly 50 pages when the final page ends the chain', async () => {
    for (let page = 1; page <= 50; page++) {
      getPage.mockResolvedValueOnce({
        transactions: [rawTransaction(`ref-${page}`)],
        ...(page < 50 ? { continuation_key: `next-${page}` } : {}),
      });
    }

    await expect(fetchPages()).resolves.toHaveLength(50);
    expect(getPage).toHaveBeenCalledTimes(50);
  });

  it('fails after 50 pages when the final page still has a continuation key', async () => {
    for (let page = 1; page <= 50; page++) {
      getPage.mockResolvedValueOnce({
        transactions: [rawTransaction(`ref-${page}`)],
        continuation_key: `next-${page}`,
      });
    }

    const error = await fetchPages().catch((caught) => caught);

    expectRedactedBadResponse(error);
    expect(error.message).not.toContain('next-50');
    expect(getPage).toHaveBeenCalledTimes(50);
  });

  it('propagates a later network failure instead of returning buffered pages', async () => {
    const networkError = new BankApiError('TRANSIENT', 'Network error contacting Enable Banking');
    getPage
      .mockResolvedValueOnce({
        transactions: [rawTransaction('discard-me')],
        continuation_key: 'next',
      })
      .mockRejectedValueOnce(networkError);

    await expect(fetchPages()).rejects.toBe(networkError);
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('detects a response that repeats the caller-provided starting key', async () => {
    getPage.mockResolvedValueOnce({ transactions: [], continuation_key: 'starting-key' });

    const error = await fetchPages({ continuationKey: 'starting-key' }).catch(
      (caught) => caught
    );

    expectRedactedBadResponse(error);
    expect(getPage).toHaveBeenCalledTimes(1);
  });
});
