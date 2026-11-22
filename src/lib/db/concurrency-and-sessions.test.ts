import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import bcrypt from 'bcryptjs';
import {
  createUser,
  findUserByEmail,
  getAllUsers,
  updateUser,
  changePassword,
  deleteUser,
  isFirstUserSetup,
  FirstUserTakenError,
  isAccountLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  resetLoginAttemptsForTests,
  verifyDummyPassword,
  MAX_FAILED_ATTEMPTS_PER_CLIENT,
  MAX_FAILED_ATTEMPTS_PER_ACCOUNT,
} from './users';
import { createBalanceSnapshot, getBalanceSnapshots } from './reconciliation';
import { updateUserPreferences, getUserPreferences } from './user-preferences';
import { revokeSession, resetRevokedSessionsCacheForTests } from './revoked-sessions';
import { validateSessionClaims } from '@/lib/session-validation';

/**
 * Regression tests for the concurrency and session findings:
 *  - 5 concurrent first sign-ups all became admin and 4 vanished from the index;
 *  - 20 parallel snapshot writes kept only 5 (read-modify-write races);
 *  - lockout was per email only (anyone could lock anyone out);
 *  - deactivated / deleted / signed-out sessions kept working for 30 days.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = path.join(os.tmpdir(), `sampolio-conc-${process.pid}-${Math.random().toString(36).slice(2)}`);
  process.env.DATA_DIR = dataDir;
  resetLoginAttemptsForTests();
  resetRevokedSessionsCacheForTests();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe('first-user bootstrap', () => {
  it('concurrent first sign-ups produce exactly one admin and keep every account', async () => {
    const emails = ['alex', 'sam', 'robin', 'kai', 'noa'].map((n) => `${n}@example.com`);
    const users = await Promise.all(emails.map((e) => createUser(e, 'Str0ng!Pass', 'X')));
    expect(users.filter((u) => u.role === 'admin')).toHaveLength(1);
    const all = await getAllUsers();
    expect(all.map((u) => u.email).sort()).toEqual([...emails].sort());
    for (const e of emails) expect(await findUserByEmail(e)).not.toBeNull();
  });

  it('concurrent sign-ups with the same email create one account', async () => {
    const results = await Promise.allSettled([1, 2, 3].map(() => createUser('alex@example.com', 'Str0ng!Pass', 'Alex')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await getAllUsers()).toHaveLength(1);
  });

  it('a missing users index does not re-open first-user (admin) sign-up', async () => {
    await createUser('alex@example.com', 'Str0ng!Pass', 'Alex');
    await fs.rm(path.join(dataDir, 'users-index.enc'));
    expect(await isFirstUserSetup()).toBe(false);
    const late = await createUser('mallory@example.com', 'Str0ng!Pass', 'M');
    expect(late.role).toBe('user');
  });

  it('onlyIfFirstUser refuses once the first account exists', async () => {
    await createUser('alex@example.com', 'Str0ng!Pass', 'Alex');
    await expect(
      createUser('sam@example.com', 'Str0ng!Pass', 'Sam', 'user', { onlyIfFirstUser: true })
    ).rejects.toBeInstanceOf(FirstUserTakenError);
  });
});

describe('locked read-modify-write', () => {
  it('20 parallel snapshot writes are all persisted', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createBalanceSnapshot('sam-user', 'cash-account', `acct-${i}`, '2026-10', 100, 100 + i)
      )
    );
    expect(await getBalanceSnapshots('sam-user')).toHaveLength(20);
  });

  it('parallel preference updates merge instead of overwriting each other', async () => {
    await Promise.all([
      updateUserPreferences('sam-user', { hasCompletedOnboarding: true }),
      updateUserPreferences('sam-user', { customCategories: ['Pets'] }),
      updateUserPreferences('sam-user', { removedDefaultCategories: ['Other'] }),
    ]);
    const prefs = await getUserPreferences('sam-user');
    expect(prefs.hasCompletedOnboarding).toBe(true);
    expect(prefs.customCategories).toEqual(['Pets']);
    expect(prefs.removedDefaultCategories).toEqual(['Other']);
  });
});

describe('login lockout', () => {
  it('locks one client after repeated failures without locking the owner on another client', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_CLIENT; i++) await recordFailedLogin('sam@example.com', '203.0.113.9');
    expect(await isAccountLocked('sam@example.com', '203.0.113.9')).toBe(true);
    expect(await isAccountLocked('sam@example.com', '198.51.100.7')).toBe(false);
  });

  it('caps distributed guessing per account', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_ACCOUNT; i++) await recordFailedLogin('sam@example.com', `198.51.100.${i}`);
    expect(await isAccountLocked('sam@example.com', '192.0.2.1')).toBe(true);
  });

  it('a success clears only that client’s counter', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS_PER_CLIENT - 1; i++) await recordFailedLogin('sam@example.com', '203.0.113.9');
    await recordSuccessfulLogin('sam@example.com', '203.0.113.9');
    await recordFailedLogin('sam@example.com', '203.0.113.9');
    expect(await isAccountLocked('sam@example.com', '203.0.113.9')).toBe(false);
  });

  it('failed logins for unknown accounts still run a full bcrypt comparison', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    await verifyDummyPassword('anything');
    expect(spy).toHaveBeenCalledTimes(1);
    const hash = spy.mock.calls[0][1] as string;
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    spy.mockRestore();
  });
});

describe('session validation', () => {
  async function signedIn() {
    const user = await createUser('sam@example.com', 'Str0ng!Pass', 'Sam');
    return { user, claims: { id: user.id, sid: 'session-1', sv: user.sessionVersion ?? 0 } };
  }

  it('accepts a current session and refreshes its role', async () => {
    const { user, claims } = await signedIn();
    expect((await validateSessionClaims(claims))?.id).toBe(user.id);
  });

  it('rejects tokens without the claims set at sign-in (pre-upgrade tokens)', async () => {
    const { user } = await signedIn();
    expect(await validateSessionClaims({ id: user.id })).toBeNull();
  });

  it('ends sessions on deactivation, role change, password change and deletion', async () => {
    const { user, claims } = await signedIn();
    // deactivate
    await updateUser(user.id, { isActive: false });
    expect(await validateSessionClaims(claims)).toBeNull();

    const other = await createUser('alex@example.com', 'Str0ng!Pass', 'Alex');
    const otherClaims = { id: other.id, sid: 's2', sv: other.sessionVersion ?? 0 };
    // a rename does not end the session
    await updateUser(other.id, { name: 'Alex B' });
    expect(await validateSessionClaims(otherClaims)).not.toBeNull();
    // role change does
    await updateUser(other.id, { role: other.role === 'admin' ? 'user' : 'admin' });
    expect(await validateSessionClaims(otherClaims)).toBeNull();

    const third = await createUser('robin@example.com', 'Str0ng!Pass', 'Robin');
    await changePassword(third.id, 'N3w!Passw0rd');
    expect(await validateSessionClaims({ id: third.id, sid: 's3', sv: 0 })).toBeNull();

    const fourth = await createUser('kai@example.com', 'Str0ng!Pass', 'Kai');
    await deleteUser(fourth.id);
    expect(await validateSessionClaims({ id: fourth.id, sid: 's4', sv: 0 })).toBeNull();
  });

  it('rejects a signed-out session id, even after a restart (file-backed)', async () => {
    const { claims } = await signedIn();
    await revokeSession(claims.sid, 60_000);
    expect(await validateSessionClaims(claims)).toBeNull();
    resetRevokedSessionsCacheForTests();
    expect(await validateSessionClaims(claims)).toBeNull();
    expect(await validateSessionClaims({ ...claims, sid: 'another-device' })).not.toBeNull();
  });
});
