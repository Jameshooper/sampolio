/**
 * Tests for the Home Assistant account summary payload.
 *
 * The feature exists so numbers can reach Home Assistant *without* anything
 * about individual spending going with them, so most of this file is about
 * what must NOT be in the payload. `BankAccountLink` in particular carries an
 * IBAN that is masked in the UI and never logged; it must not escape here
 * either.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildHaSummary,
  sendHaSummary,
  summaryContainsOnlyAllowedKeys,
  type HaSummaryInput,
} from '@/lib/ha-summary';
import type { BankAccountLink, FinancialAccount, MonthlyProjection } from '@/types';

function account(over: Partial<FinancialAccount> = {}): FinancialAccount {
  return {
    id: 'acc-1',
    userId: 'u1',
    name: 'Joint account',
    currency: 'EUR',
    startingBalance: 0,
    startingDate: '2026-01',
    planningHorizonMonths: 12,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function month(over: Partial<MonthlyProjection> = {}): MonthlyProjection {
  return {
    yearMonth: '2026-11',
    year: 2026,
    month: 11,
    startingBalance: 100000,
    totalIncome: 300000,
    totalExpenses: 250000,
    netChange: 50000,
    endingBalance: 150000,
    incomeBreakdown: [],
    expenseBreakdown: [],
    ...over,
  };
}

/** A card link populated with everything the real record can carry. */
function cardLink(over: Partial<BankAccountLink> = {}): BankAccountLink {
  return {
    id: 'link-1',
    connectionId: 'conn-1',
    accountUid: 'eb-account-uid-abc',
    identificationHash: 'hash-abc',
    identificationHashes: ['hash-abc', 'hash-def'],
    iban: 'FI2112345600000785',
    name: 'OP Visa',
    currency: 'EUR',
    accountRole: 'credit-card',
    outstanding: 42000,
    availableCredit: 158000,
    lastBalance: -42000,
    syncCursor: { lastBookingDate: '2026-11-10' },
    ...over,
  };
}

const base = (over: Partial<HaSummaryInput> = {}): HaSummaryInput => ({
  accounts: [{ account: account(), currentMonth: month() }],
  cards: [cardLink()],
  currency: 'EUR',
  now: new Date('2026-11-14T12:00:00.000Z'),
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('buildHaSummary — what it must not leak', () => {
  it('emits only allowlisted keys, at every depth', () => {
    expect(summaryContainsOnlyAllowedKeys(buildHaSummary(base()))).toBe(true);
  });

  it('never carries the IBAN or any bank identifier', () => {
    const json = JSON.stringify(buildHaSummary(base()));
    for (const secret of ['FI2112345600000785', 'eb-account-uid-abc', 'hash-abc', 'hash-def', 'conn-1']) {
      expect(json).not.toContain(secret);
    }
  });

  it('never carries transaction-level detail', () => {
    // Line items are where merchant names and descriptions live.
    const withLines = month({
      incomeBreakdown: [{ itemId: 'i1', name: 'Salary from ACME Oy', amount: 300000, source: 'salary' }],
      expenseBreakdown: [
        { itemId: 'e1', name: 'K-Market Kamppi', amount: 4500, category: 'groceries', source: 'recurring' },
      ],
    });
    const json = JSON.stringify(buildHaSummary(base({ accounts: [{ account: account(), currentMonth: withLines }] })));
    expect(json).not.toContain('K-Market');
    expect(json).not.toContain('ACME');
    expect(json).not.toContain('groceries');
  });

  it('does not spread source records, so a new upstream field cannot ride along', () => {
    const smuggled = cardLink({ ...({ futureSecretField: 'must-not-appear' } as object) } as Partial<BankAccountLink>);
    expect(JSON.stringify(buildHaSummary(base({ cards: [smuggled] })))).not.toContain('must-not-appear');
  });
});

describe('buildHaSummary — the numbers', () => {
  it('reports the projected end-of-month balance', () => {
    expect(buildHaSummary(base()).accounts[0].endOfMonthBalance).toBe(150000);
  });

  it('computes "left this month" as the month end without further income', () => {
    // 150000 end of month, of which 300000 is income still to arrive.
    expect(buildHaSummary(base()).accounts[0].leftThisMonth).toBe(150000 - 300000);
  });

  it('stays correct mid-month, when the projection has actualized', () => {
    // Once a salary is booked, totalIncome holds only what REMAINS — so the
    // figure must not keep subtracting money already in the account.
    const actualized = month({ isActualized: true, totalIncome: 0, endingBalance: 150000 });
    const out = buildHaSummary(base({ accounts: [{ account: account(), currentMonth: actualized }] }));
    expect(out.accounts[0].leftThisMonth).toBe(150000);
  });

  it('totals across accounts and cards', () => {
    const out = buildHaSummary(
      base({
        accounts: [
          { account: account({ id: 'a1' }), currentMonth: month({ endingBalance: 150000, totalIncome: 0 }) },
          { account: account({ id: 'a2' }), currentMonth: month({ endingBalance: 50000, totalIncome: 0 }) },
        ],
        cards: [cardLink({ id: 'c1', outstanding: 42000 }), cardLink({ id: 'c2', outstanding: 8000 })],
      })
    );
    expect(out.totals.cashBalance).toBe(200000);
    expect(out.totals.leftThisMonth).toBe(200000);
    expect(out.totals.cardOutstanding).toBe(50000);
  });

  it('ignores archived accounts, excluded cards and non-card links', () => {
    const out = buildHaSummary(
      base({
        accounts: [
          { account: account({ id: 'a1', isArchived: true }), currentMonth: month() },
          { account: account({ id: 'a2' }), currentMonth: undefined },
        ],
        cards: [
          cardLink({ id: 'c1', isExcluded: true }),
          cardLink({ id: 'c2', accountRole: 'cash' }),
        ],
      })
    );
    expect(out.accounts).toEqual([]);
    expect(out.cards).toEqual([]);
    expect(out.totals).toEqual({ cashBalance: 0, cardOutstanding: 0, leftThisMonth: 0 });
  });

  it('prefers the user-set card name and falls back sensibly', () => {
    expect(buildHaSummary(base({ cards: [cardLink({ customName: 'Everyday Visa' })] })).cards[0].name)
      .toBe('Everyday Visa');
    expect(buildHaSummary(base({ cards: [cardLink({ name: undefined, customName: undefined })] })).cards[0].name)
      .toBe('Card');
  });
});

describe('sendHaSummary', () => {
  it('makes no network call at all when no webhook is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sendHaSummary(buildHaSummary(base()), null)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the payload as JSON', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    expect(await sendHaSummary(buildHaSummary(base()), 'https://ha.example/api/webhook/secret-id')).toBe(true);
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).event).toBe('summary.updated');
  });

  it('never throws, and never logs the webhook URL, when delivery fails', async () => {
    // The URL embeds the secret webhook id.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(sendHaSummary(buildHaSummary(base()), 'https://ha.example/api/webhook/secret-id')).resolves.toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-id');
  });

  it('reports a rejection without leaking the payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    expect(await sendHaSummary(buildHaSummary(base()), 'https://ha.example/api/webhook/secret-id')).toBe(false);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('403');
    expect(logged).not.toContain('Joint account');
  });
});
