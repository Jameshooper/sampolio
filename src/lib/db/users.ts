import * as path from 'path';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import type { User, UserRole, PublicUser } from '@/types';
import {
  getDataDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  writeFileAtomic,
  getUserDir,
  isSafeId,
  withFileLock,
  serialized,
  listFiles,
} from './encryption';

const USERS_INDEX_FILE = 'users-index.enc';

interface UsersIndex {
  users: { id: string; email: string }[];
}

async function getUsersIndexPath(): Promise<string> {
  const dataDir = getDataDir();
  await ensureDir(dataDir);
  return path.join(dataDir, USERS_INDEX_FILE);
}

async function getUsersIndex(): Promise<UsersIndex> {
  const indexPath = await getUsersIndexPath();
  const index = await readEncryptedFile<UsersIndex>(indexPath);
  return index || { users: [] };
}

async function saveUsersIndex(index: UsersIndex): Promise<void> {
  const indexPath = await getUsersIndexPath();
  await writeEncryptedFile(indexPath, index);
}

/** Serialise every read-modify-write of users-index.enc (account creation,
 * email changes, deletion). Without it concurrent sign-ups each read the same
 * index and the last write drops the others' entries. */
async function withUsersIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(await getUsersIndexPath(), fn);
}

/** True when the instance has no accounts at all — not just an empty index:
 * any existing user directory also counts, so a lost or damaged index can never
 * re-open first-user (admin) sign-up. */
export async function isFirstUserSetup(): Promise<boolean> {
  const index = await getUsersIndex();
  if (index.users.length > 0) return false;
  const dirs = await listFiles(path.join(getDataDir(), 'users'));
  return !dirs.some((d) => isSafeId(d));
}

export class FirstUserTakenError extends Error {
  constructor() {
    super('First-user setup has already been completed');
    this.name = 'FirstUserTakenError';
  }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const index = await getUsersIndex();
  const userEntry = index.users.find(u => u.email.toLowerCase() === email.toLowerCase());

  if (!userEntry) {
    return null;
  }

  const userDir = getUserDir(userEntry.id);
  const userFile = path.join(userDir, 'user.enc');
  const user = await readEncryptedFile<User>(userFile);

  // Migration: add default values for new fields if missing
  if (user && !user.role) {
    user.role = 'user';
    user.isActive = true;
  }

  return user;
}

export async function findUserById(id: string): Promise<User | null> {
  if (!isSafeId(id)) return null;
  const userDir = getUserDir(id);
  const userFile = path.join(userDir, 'user.enc');
  const user = await readEncryptedFile<User>(userFile);

  // Migration: add default values for new fields if missing
  if (user && !user.role) {
    user.role = 'user';
    user.isActive = true;
  }

  return user;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    avatarUrl: avatarUrlFor(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/** URL of the user's avatar (served by /api/avatars/[userId]) with a
 * version cache-buster, or undefined when the user has no avatar. */
export function avatarUrlFor(user: Pick<User, 'id' | 'avatarVersion'>): string | undefined {
  return user.avatarVersion ? `/api/avatars/${user.id}?v=${user.avatarVersion}` : undefined;
}

const AVATAR_FILE = 'avatar.webp';

/** Absolute path of a user's avatar image. The file is deliberately stored
 * UNENCRYPTED (unlike everything else in the data dir): it is low-sensitivity
 * and plain binary lets the /api/avatars route stream it with HTTP caching and
 * zero decryption work. */
export function getAvatarPath(userId: string): string {
  return path.join(getUserDir(userId), AVATAR_FILE);
}

/** Write (or, with null, delete) a user's avatar image and bump avatarVersion
 * on user.enc. Returns the updated user, or null if the user doesn't exist. */
async function setUserAvatarUnlocked(userId: string, image: Buffer | null): Promise<User | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const avatarPath = getAvatarPath(userId);
  if (image) {
    await ensureDir(getUserDir(userId));
    await writeFileAtomic(avatarPath, image);
  } else {
    await fs.rm(avatarPath, { force: true });
  }

  const updatedUser: User = {
    ...user,
    avatarVersion: image ? (user.avatarVersion ?? 0) + 1 : undefined,
    updatedAt: new Date().toISOString(),
  };
  // JSON-stringify drops undefined fields, so clearing the avatar also removes
  // the field from the stored doc.
  const userFile = path.join(getUserDir(userId), 'user.enc');
  await writeEncryptedFile(userFile, updatedUser);

  return updatedUser;
}

export async function createUser(
  email: string,
  password: string,
  name: string,
  role: UserRole = 'user',
  options: { onlyIfFirstUser?: boolean } = {}
): Promise<User> {
  // Hash outside the lock (bcrypt is the slow part).
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  return withUsersIndexLock(async () => {
    // Uniqueness and first-user checks happen inside the lock, so two
    // concurrent sign-ups can't both become admin or both claim one email.
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    const isFirstUser = await isFirstUserSetup();
    if (options.onlyIfFirstUser && !isFirstUser) {
      throw new FirstUserTakenError();
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const user: User = {
      id,
      email: email.toLowerCase(),
      name,
      passwordHash,
      role: isFirstUser ? 'admin' : role,
      isActive: true,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now,
    };

    const userDir = getUserDir(id);
    await ensureDir(userDir);
    await writeEncryptedFile(path.join(userDir, 'user.enc'), user);

    const index = await getUsersIndex();
    index.users.push({ id, email: user.email });
    await saveUsersIndex(index);

    return user;
  });
}

const BCRYPT_ROUNDS = 12;

// A real cost-12 bcrypt hash of a random throwaway secret, generated once per
// process. Comparing against it when the account doesn't exist (or is
// inactive) makes a failed login take the same time either way, so response
// timing doesn't reveal which emails have accounts.
let dummyPasswordHash: Promise<string> | null = null;

/** Burn one bcrypt comparison without a real account (timing equalisation). */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyPasswordHash ??= bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
  await bcrypt.compare(password, await dummyPasswordHash).catch(() => false);
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

function getUserFile(userId: string): string {
  return path.join(getUserDir(userId), 'user.enc');
}

async function updateUserUnlocked(
  userId: string,
  updates: Partial<Pick<User, 'name' | 'email' | 'role' | 'isActive'>>
): Promise<User | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const emailChanged = !!updates.email && updates.email.toLowerCase() !== user.email.toLowerCase();
  // Losing access or privileges must end the sessions that still carry the old state.
  const revokeSessions =
    (updates.isActive === false && user.isActive) || (updates.role !== undefined && updates.role !== user.role);

  const updatedUser: User = {
    ...user,
    ...updates,
    email: updates.email ? updates.email.toLowerCase() : user.email,
    sessionVersion: (user.sessionVersion ?? 0) + (revokeSessions ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };

  if (!emailChanged) {
    await writeEncryptedFile(getUserFile(userId), updatedUser);
    return updatedUser;
  }

  return withUsersIndexLock(async () => {
    const index = await getUsersIndex();
    if (index.users.some(u => u.id !== userId && u.email.toLowerCase() === updatedUser.email)) {
      throw new Error('User with this email already exists');
    }
    await writeEncryptedFile(getUserFile(userId), updatedUser);
    const userEntry = index.users.find(u => u.id === userId);
    if (userEntry) {
      userEntry.email = updatedUser.email;
      await saveUsersIndex(index);
    }
    return updatedUser;
  });
}

/** Per-user lock key for read-modify-write of user.enc. */
const userLockKey = (userId: string) => `user-record:${userId}`;

export const updateUser = serialized(userLockKey, updateUserUnlocked);

export const setUserAvatar = serialized(userLockKey, setUserAvatarUnlocked);

async function changePasswordUnlocked(userId: string, newPassword: string): Promise<boolean> {
  const user = await findUserById(userId);
  if (!user) {
    return false;
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const updatedUser: User = {
    ...user,
    passwordHash,
    // A new password signs out every existing session (including stolen ones).
    sessionVersion: (user.sessionVersion ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  await writeEncryptedFile(getUserFile(userId), updatedUser);
  return true;
}

export const changePassword = serialized(userLockKey, changePasswordUnlocked);

export async function getAllUsers(): Promise<User[]> {
  const index = await getUsersIndex();

  const results = await Promise.all(
    index.users.map(entry => findUserById(entry.id))
  );

  return results.filter((u): u is User => u !== null);
}

export const deleteUser = serialized(userLockKey, async (userId: string): Promise<boolean> => {
  const user = await findUserById(userId);
  if (!user) {
    return false;
  }

  // Remove from index
  await withUsersIndexLock(async () => {
    const index = await getUsersIndex();
    index.users = index.users.filter(u => u.id !== userId);
    await saveUsersIndex(index);
  });

  // Note: We don't delete the user directory to preserve data
  // Instead we just deactivate them (and end their sessions)
  const updatedUser: User = {
    ...user,
    isActive: false,
    sessionVersion: (user.sessionVersion ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  await writeEncryptedFile(getUserFile(userId), updatedUser);

  return true;
});

/** Permanent, irreversible deletion: removes the user from the index AND
 * recursively deletes their entire data directory. Unlike `deleteUser` (a soft
 * deactivate that preserves files for admin purposes), this is for account
 * self-deletion — the caller must have already torn down any shared entities
 * (split groups / mortgages) the user belongs to. */
export async function hardDeleteUser(userId: string): Promise<boolean> {
  await withUsersIndexLock(async () => {
    const index = await getUsersIndex();
    index.users = index.users.filter(u => u.id !== userId);
    await saveUsersIndex(index);
  });

  const userDir = getUserDir(userId);
  await fs.rm(userDir, { recursive: true, force: true });

  return true;
}

export async function getAllUserIds(): Promise<string[]> {
  const index = await getUsersIndex();
  return index.users.map(u => u.id);
}

// ==================== Account Lockout for Brute Force Protection ====================
//
// Two in-memory counters (single process; they reset on restart):
//  - per (email, client IP): 10 failures in 15 min lock that pair for 15 min.
//    Someone guessing from one address is stopped without locking the real
//    owner out from their own devices.
//  - per email, any IP: 50 failures in 15 min lock the account for 15 min. This
//    bounds distributed guessing; reaching it takes 50 attempts from 5+
//    addresses instead of 10 from anywhere.
// The client IP comes from getClientIp (src/lib/client-ip.ts), which only
// trusts X-Forwarded-For hops configured with TRUSTED_PROXY_HOPS.

interface AttemptRecord { count: number; lastAttempt: number; lockedUntil: number | null }

// On globalThis so every bundle in the process shares one set of counters.
const failedLoginAttempts: Map<string, AttemptRecord> = ((globalThis as { __sampolioLoginAttempts?: Map<string, AttemptRecord> })
  .__sampolioLoginAttempts ??= new Map());

export const MAX_FAILED_ATTEMPTS_PER_CLIENT = 10;
export const MAX_FAILED_ATTEMPTS_PER_ACCOUNT = 50;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes - reset count after this

const pairKey = (email: string, ip: string) => `pair:${email.toLowerCase()}|${ip}`;
const accountKey = (email: string) => `account:${email.toLowerCase()}`;

function isKeyLocked(key: string, now: number): boolean {
  const record = failedLoginAttempts.get(key);
  if (!record?.lockedUntil) return false;
  if (now > record.lockedUntil) {
    failedLoginAttempts.delete(key);
    return false;
  }
  return true;
}

function bump(key: string, max: number, now: number): void {
  const record = failedLoginAttempts.get(key);
  if (!record || now - record.lastAttempt > ATTEMPT_WINDOW) {
    failedLoginAttempts.set(key, { count: 1, lastAttempt: now, lockedUntil: null });
    return;
  }
  const count = record.count + 1;
  failedLoginAttempts.set(key, {
    count,
    lastAttempt: now,
    lockedUntil: count >= max ? now + LOCKOUT_DURATION : record.lockedUntil,
  });
}

export async function isAccountLocked(email: string, ip = 'unknown'): Promise<boolean> {
  const now = Date.now();
  return isKeyLocked(pairKey(email, ip), now) || isKeyLocked(accountKey(email), now);
}

export async function recordFailedLogin(email: string, ip = 'unknown'): Promise<void> {
  const now = Date.now();
  bump(pairKey(email, ip), MAX_FAILED_ATTEMPTS_PER_CLIENT, now);
  bump(accountKey(email), MAX_FAILED_ATTEMPTS_PER_ACCOUNT, now);
  if (isKeyLocked(accountKey(email), now) || isKeyLocked(pairKey(email, ip), now)) {
    console.warn('[auth] Login temporarily locked after repeated failures');
  }
}

export async function recordSuccessfulLogin(email: string, ip = 'unknown'): Promise<void> {
  // Clear only this client's counter: a success must not reset the account-wide
  // counter that bounds guessing from other addresses.
  failedLoginAttempts.delete(pairKey(email, ip));
}

/** Test hook: forget all failed-attempt state. */
export function resetLoginAttemptsForTests(): void {
  failedLoginAttempts.clear();
}

// Clean up old entries periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of failedLoginAttempts.entries()) {
    const expiredWindow = !record.lockedUntil && now - record.lastAttempt > ATTEMPT_WINDOW;
    const expiredLock = record.lockedUntil !== null && now > record.lockedUntil;
    if (expiredWindow || expiredLock) failedLoginAttempts.delete(key);
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes
cleanupTimer.unref?.();
