import { describe, it, expect } from 'vitest';
import { orderRunnableConnections, type DueConnection } from './scheduler';
import type { BankAccountLink, BankConnection } from '@/types';

const now = Date.parse('2026-07-10T12:00:00.000Z');

function link(overrides: Partial<BankAccountLink> = {}): BankAccountLink {
  return {
    id: 'link-1',
    connectionId: 'conn-1',
    accountUid: 'uid-1',
    currency: 'EUR',
    accountRole: 'cash',
    ...overrides,
  };
}

function connection(overrides: Partial<BankConnection> = {}): BankConnection {
  return {
    id: 'conn-1',
    userId: 'user-1',
    aspspName: 'Nordea',
    aspspCountry: 'FI',
    status: 'active',
    psuType: 'personal',
    linkedAccounts: [link()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('orderRunnableConnections', () => {
  it('budget-skips both users when the shared identity hash is already exhausted', () => {
    const sharedHash = 'hash-shared';
    const due: DueConnection[] = [
      {
        userId: 'user-a',
        connection: connection({
          id: 'conn-a',
          userId: 'user-a',
          linkedAccounts: [link({ id: 'link-a', identificationHash: sharedHash })],
        }),
      },
      {
        userId: 'user-b',
        connection: connection({
          id: 'conn-b',
          userId: 'user-b',
          linkedAccounts: [link({ id: 'link-b', identificationHash: sharedHash })],
        }),
      },
    ];

    // The identity's combined budget for the day is already spent.
    const { runnable, budgetSkipped } = orderRunnableConnections(due, now, () => 0);

    expect(runnable).toHaveLength(0);
    expect(budgetSkipped).toHaveLength(2);
  });

  it('lets a connection with no remaining budget run anyway when every account is already fresh', () => {
    const freshLink = link({
      identificationHash: 'hash-1',
      syncCursor: { backfilledThrough: '2026-07-01' },
      lastSyncedAt: new Date(now - 60 * 1000).toISOString(), // 1 min ago — well within the interval
    });
    const due: DueConnection[] = [
      { userId: 'user-a', connection: connection({ linkedAccounts: [freshLink] }) },
    ];

    // Budget is exhausted, but it should never even be consulted for a fresh account.
    let consulted = false;
    const { runnable, budgetSkipped } = orderRunnableConnections(due, now, () => {
      consulted = true;
      return 0;
    });

    expect(runnable).toHaveLength(1);
    expect(budgetSkipped).toHaveLength(0);
    expect(consulted).toBe(false);
  });

  it('still applies the budget guard to a NOT-yet-backfilled account regardless of lastSyncedAt', () => {
    const midBackfillLink = link({
      identificationHash: 'hash-1',
      syncCursor: { backfilledThrough: undefined },
      lastSyncedAt: new Date(now - 60 * 1000).toISOString(),
    });
    const due: DueConnection[] = [
      { userId: 'user-a', connection: connection({ linkedAccounts: [midBackfillLink] }) },
    ];

    const { runnable, budgetSkipped } = orderRunnableConnections(due, now, () => 0);
    expect(runnable).toHaveLength(0);
    expect(budgetSkipped).toHaveLength(1);
  });

  it('orders least-recently-synced connections first, undefined lastSyncAt first', () => {
    const due: DueConnection[] = [
      {
        userId: 'user-recent',
        connection: connection({
          id: 'conn-recent',
          lastSyncAt: new Date(now - 60 * 60 * 1000).toISOString(), // 1h ago
        }),
      },
      {
        userId: 'user-never',
        connection: connection({ id: 'conn-never', lastSyncAt: undefined }),
      },
      {
        userId: 'user-stale',
        connection: connection({
          id: 'conn-stale',
          lastSyncAt: new Date(now - 10 * 60 * 60 * 1000).toISOString(), // 10h ago
        }),
      },
    ];

    const { runnable } = orderRunnableConnections(due, now, () => Infinity);
    expect(runnable.map((r) => r.connection.id)).toEqual(['conn-never', 'conn-stale', 'conn-recent']);
  });

  it('drops a connection with no non-excluded accounts from both lists', () => {
    const due: DueConnection[] = [
      {
        userId: 'user-a',
        connection: connection({ linkedAccounts: [link({ isExcluded: true })] }),
      },
    ];
    const { runnable, budgetSkipped } = orderRunnableConnections(due, now, () => 1);
    expect(runnable).toHaveLength(0);
    expect(budgetSkipped).toHaveLength(0);
  });
});
