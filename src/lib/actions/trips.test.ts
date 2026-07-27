import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Action-layer tests: exercise the real auth-guard → Zod → db → updateTag
// pipeline with auth() and Next's cache APIs mocked (there is no request
// scope under vitest), and the db writing to a temp DATA_DIR.
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({
  updateTag: vi.fn(),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));
// The cached wrappers use the 'use cache' directive, which needs the Next
// runtime — route them straight to the underlying db functions instead.
vi.mock('@/lib/db/cached', async () => {
  const trips = await import('@/lib/db/trips');
  return {
    cachedGetTrips: trips.getTrips,
    cachedGetTripById: trips.getTripById,
  };
});

import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import { getTrips, getTripById, createTrip, updateTrip, deleteTrip } from './trips';
import { createAccount } from '@/lib/db/accounts';
import { buildDefaultRateSnapshot } from '@/lib/per-diem-rates';
import type { TripDay } from '@/types';

const mockAuth = vi.mocked(auth);
const userId = 'action-test-user';

function baseTripInput(overrides?: Partial<Parameters<typeof createTrip>[0]>) {
  const days: TripDay[] = [{ date: '2026-08-01', countryCode: 'FI', freeMeals: 0 }];
  return {
    name: 'Conference trip',
    destinationCountry: 'FI',
    startDateTime: '2026-08-01T08:00',
    endDateTime: '2026-08-02T08:00',
    days,
    rates: buildDefaultRateSnapshot(),
    linkedAccountId: '',
    expectedReimbursementMonth: '2026-08',
    status: 'planned' as const,
    ...overrides,
  };
}

describe('server actions: trips', () => {
  let dataDir: string;
  let accountId: string;

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-trips-actions-test-${process.pid}`);
    process.env.DATA_DIR = dataDir;
    const account = await createAccount(userId, {
      name: 'Test account',
      currency: 'EUR',
      startingBalance: 1000,
      startingDate: '2026-01',
      planningHorizonMonths: 12,
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue({ user: { id: userId } } as any);
  });

  it('rejects every operation without a session', async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await getTrips()).error).toBe('Unauthorized');
    expect((await createTrip(baseTripInput({ linkedAccountId: accountId }))).error).toBe('Unauthorized');
    expect((await updateTrip('some-id', { name: 'Y' })).error).toBe('Unauthorized');
    expect((await deleteTrip('some-id')).error).toBe('Unauthorized');
    expect(updateTag).not.toHaveBeenCalled();
  });

  it('creates, reads, updates, lists and deletes a trip, invalidating the trips tag', async () => {
    const created = await createTrip(baseTripInput({ linkedAccountId: accountId }));
    expect(created.success).toBe(true);
    expect(created.data?.status).toBe('planned');
    expect(updateTag).toHaveBeenCalledWith(`user:${userId}:trips`);

    const fetched = await getTripById(created.data!.id);
    expect(fetched.success).toBe(true);
    expect(fetched.data?.name).toBe('Conference trip');

    const updated = await updateTrip(created.data!.id, { status: 'completed' });
    expect(updated.success).toBe(true);
    expect(updated.data?.status).toBe('completed');

    const list = await getTrips();
    expect(list.data?.map((t) => t.id)).toContain(created.data!.id);

    const deleted = await deleteTrip(created.data!.id);
    expect(deleted.success).toBe(true);
    expect((await getTrips()).data).toHaveLength(0);
  });

  it('rejects invalid input via the Zod schema (empty name)', async () => {
    const res = await createTrip(baseTripInput({ name: '', linkedAccountId: accountId }));
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
    expect(updateTag).not.toHaveBeenCalled();
  });

  it('rejects an end date/time that is not after the start', async () => {
    const res = await createTrip(baseTripInput({
      linkedAccountId: accountId,
      startDateTime: '2026-08-02T08:00',
      endDateTime: '2026-08-01T08:00',
    }));
    expect(res.success).toBe(false);
  });

  it('rejects a missing linked account', async () => {
    const res = await createTrip(baseTripInput({ linkedAccountId: '' }));
    expect(res.success).toBe(false);
  });

  it('returns Trip not found when updating/reading a nonexistent trip', async () => {
    expect((await getTripById('nonexistent')).error).toBe('Trip not found');
    expect((await updateTrip('nonexistent', { name: 'X' })).error).toBe('Trip not found');
  });

  it('persists a foreign destination, per-day country overrides, and notes', async () => {
    const days: TripDay[] = [
      { date: '2026-09-01', countryCode: 'germany', freeMeals: 0 },
      { date: '2026-09-02', countryCode: 'FI', freeMeals: 1, overrideAmount: 30 },
    ];
    const created = await createTrip(baseTripInput({
      linkedAccountId: accountId,
      destinationCountry: 'germany',
      startDateTime: '2026-09-01T08:00',
      endDateTime: '2026-09-02T13:00',
      days,
      notes: 'Bring the badge',
    }));
    expect(created.success).toBe(true);
    expect(created.data?.days).toHaveLength(2);
    expect(created.data?.days[1].overrideAmount).toBe(30);
    expect(created.data?.notes).toBe('Bring the badge');
  });
});
