import { describe, it, expect } from 'vitest';
import { applyLinkBalances, type BalanceApplicationLink } from './apply-link-balances';
import type { MappedBalance } from './mappers';

const nowIso = '2026-07-10T12:00:00.000Z';

function cardLink(overrides: Partial<BalanceApplicationLink> = {}): BalanceApplicationLink {
  return {
    accountRole: 'credit-card',
    lastBalance: -100,
    lastBalanceType: 'ITBD',
    lastBalanceAt: '2026-07-09T12:00:00.000Z',
    outstanding: 100,
    availableCredit: 900,
    creditLimit: 1000,
    ...overrides,
  };
}

function depositLink(overrides: Partial<BalanceApplicationLink> = {}): BalanceApplicationLink {
  return {
    accountRole: 'cash',
    lastBalance: 500,
    lastBalanceType: 'CLBD',
    lastBalanceAt: '2026-07-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('applyLinkBalances — credit-card', () => {
  it('derives outstanding/availableCredit/creditLimit when both booked and available are present', () => {
    const balances: MappedBalance[] = [
      { type: 'ITBD', amount: -250, currency: 'EUR' },
      { type: 'ITAV', amount: 750, currency: 'EUR' },
    ];
    const result = applyLinkBalances(cardLink(), balances, nowIso);
    expect(result.balanceFound).toBe(true);
    expect(result.outstanding).toBe(250);
    expect(result.availableCredit).toBe(750);
    expect(result.creditLimit).toBe(1000);
    expect(result.lastBalance).toBe(-250);
    expect(result.lastBalanceType).toBe('ITBD');
    expect(result.lastBalanceAt).toBe(nowIso);
  });

  it('clears availableCredit/creditLimit when a booked balance is found but no available', () => {
    // A stale (pre-fix) availableCredit/creditLimit must NOT survive: with only a
    // booked balance we can't compute available credit, so both are dropped
    // (returned as explicit undefined so the link write removes the keys).
    const balances: MappedBalance[] = [{ type: 'ITBD', amount: -300, currency: 'EUR' }];
    const link = cardLink({ availableCredit: 900, creditLimit: 1000 });
    const result = applyLinkBalances(link, balances, nowIso);
    expect(result.balanceFound).toBe(true);
    expect(result.outstanding).toBe(300);
    expect('availableCredit' in result).toBe(true); // key present…
    expect(result.availableCredit).toBeUndefined(); // …but explicitly undefined
    expect(result.creditLimit).toBeUndefined();
  });

  it('reinterprets OP’s single negative ITAV as owed and clears the stale negative availableCredit', () => {
    // OP returns one balance (negative ITAV) → pickCardBalances reinterprets it as
    // booked. The link still carries a stale availableCredit: -1500 that must be
    // cleared.
    const balances: MappedBalance[] = [{ type: 'ITAV', amount: -1500, currency: 'EUR' }];
    const link = cardLink({ outstanding: undefined, availableCredit: -1500, creditLimit: undefined });
    const result = applyLinkBalances(link, balances, nowIso);
    expect(result.balanceFound).toBe(true);
    expect(result.outstanding).toBeCloseTo(1500, 2);
    expect(result.availableCredit).toBeUndefined(); // stale negative dropped
    expect(result.creditLimit).toBeUndefined();
    expect(result.lastBalance).toBe(-1500);
    expect(result.lastBalanceType).toBe('ITAV');
  });

  it('preserves every field and reports balanceFound=false when neither balance type is present', () => {
    const link = cardLink();
    const result = applyLinkBalances(link, [], nowIso);
    expect(result).toEqual({
      balanceFound: false,
      lastBalance: link.lastBalance,
      lastBalanceType: link.lastBalanceType,
      lastBalanceAt: link.lastBalanceAt,
      outstanding: link.outstanding,
      availableCredit: link.availableCredit,
      creditLimit: link.creditLimit,
    });
  });
});

describe('applyLinkBalances — deposit accounts (cash/savings/other)', () => {
  it('picks the anchor balance and reports it for auto-anchoring', () => {
    const balances: MappedBalance[] = [
      { type: 'ITAV', amount: 400, currency: 'EUR' },
      { type: 'CLBD', amount: 1234.56, currency: 'EUR' },
    ];
    const result = applyLinkBalances(depositLink(), balances, nowIso);
    expect(result.balanceFound).toBe(true);
    expect(result.lastBalance).toBe(1234.56); // CLBD wins priority over ITAV
    expect(result.lastBalanceType).toBe('CLBD');
    expect(result.lastBalanceAt).toBe(nowIso);
    expect(result.anchorBalanceAmount).toBe(1234.56);
  });

  it('preserves the prior balance and does not touch lastBalanceAt when nothing is found', () => {
    const link = depositLink();
    const result = applyLinkBalances(link, [], nowIso);
    expect(result.balanceFound).toBe(false);
    expect(result.lastBalance).toBe(link.lastBalance);
    expect(result.lastBalanceType).toBe(link.lastBalanceType);
    expect(result.lastBalanceAt).toBe(link.lastBalanceAt); // NOT bumped to nowIso
    expect(result.anchorBalanceAmount).toBeUndefined();
  });

  it('applies the same deposit logic to a savings-role link', () => {
    const balances: MappedBalance[] = [{ type: 'CLBD', amount: 5000, currency: 'EUR' }];
    const result = applyLinkBalances(depositLink({ accountRole: 'savings' }), balances, nowIso);
    expect(result.balanceFound).toBe(true);
    expect(result.anchorBalanceAmount).toBe(5000);
  });
});
