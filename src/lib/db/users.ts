import * as path from 'path';
import * as fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import type { User, UserRole, PublicUser } from '@/types';
import {
  getDataDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  getUserDir,
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
export async function setUserAvatar(userId: string, image: Buffer | null): Promise<User | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const avatarPath = getAvatarPath(userId);
  if (image) {
    await ensureDir(getUserDir(userId));
    await fs.writeFile(avatarPath, image);
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
  role: UserRole = 'user'
): Promise<User> {
  // Check if user already exists
  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    throw new Error('User with this email already exists');
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, 12);

  // Check if this is the first user - make them admin
  const index = await getUsersIndex();
  const isFirstUser = index.users.length === 0;

  const user: User = {
    id,
    email: email.toLowerCase(),
    name,
    passwordHash,
    role: isFirstUser ? 'admin' : role,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  // Create user directory and save user data
  const userDir = getUserDir(id);
  await ensureDir(userDir);

  const userFile = path.join(userDir, 'user.enc');
  await writeEncryptedFile(userFile, user);

  // Update users index
  index.users.push({ id, email: user.email });
  await saveUsersIndex(index);

  return user;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export async function updateUser(
  userId: string,
  updates: Partial<Pick<User, 'name' | 'email' | 'role' | 'isActive'>>
): Promise<User | null> {
  const user = await findUserById(userId);
  if (!user) {
    return null;
  }

  const updatedUser: User = {
    ...user,
    ...updates,
    email: updates.email ? updates.email.toLowerCase() : user.email,
    updatedAt: new Date().toISOString(),
  };

  const userDir = getUserDir(userId);
  const userFile = path.join(userDir, 'user.enc');
  await writeEncryptedFile(userFile, updatedUser);

  // Update index if email changed
  if (updates.email && updates.email.toLowerCase() !== user.email.toLowerCase()) {
    const index = await getUsersIndex();
    const userEntry = index.users.find(u => u.id === userId);
    if (userEntry) {
      userEntry.email = updates.email.toLowerCase();
      await saveUsersIndex(index);
    }
  }

  return updatedUser;
}

export async function changePassword(userId: string, newPassword: string): Promise<boolean> {
  const user = await findUserById(userId);
  if (!user) {
    return false;
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const updatedUser: User = {
    ...user,
    passwordHash,
    updatedAt: new Date().toISOString(),
  };

  const userDir = getUserDir(userId);
  const userFile = path.join(userDir, 'user.enc');
  await writeEncryptedFile(userFile, updatedUser);

  return true;
}

export async function getAllUsers(): Promise<User[]> {
  const index = await getUsersIndex();

  const results = await Promise.all(
    index.users.map(entry => findUserById(entry.id))
  );

  return results.filter((u): u is User => u !== null);
}

export async function deleteUser(userId: string): Promise<boolean> {
  const user = await findUserById(userId);
  if (!user) {
    return false;
  }

  // Remove from index
  const index = await getUsersIndex();
  index.users = index.users.filter(u => u.id !== userId);
  await saveUsersIndex(index);

  // Note: We don't delete the user directory to preserve data
  // Instead we just deactivate them
  const updatedUser: User = {
    ...user,
    isActive: false,
    updatedAt: new Date().toISOString(),
  };

  const userDir = getUserDir(userId);
  const userFile = path.join(userDir, 'user.enc');
  await writeEncryptedFile(userFile, updatedUser);

  return true;
}

/** Permanent, irreversible deletion: removes the user from the index AND
 * recursively deletes their entire data directory. Unlike `deleteUser` (a soft
 * deactivate that preserves files for admin purposes), this is for account
 * self-deletion — the caller must have already torn down any shared entities
 * (split groups / mortgages) the user belongs to. */
export async function hardDeleteUser(userId: string): Promise<boolean> {
  const index = await getUsersIndex();
  index.users = index.users.filter(u => u.id !== userId);
  await saveUsersIndex(index);

  const userDir = getUserDir(userId);
  await fs.rm(userDir, { recursive: true, force: true });

  return true;
}

export async function getAllUserIds(): Promise<string[]> {
  const index = await getUsersIndex();
  return index.users.map(u => u.id);
}

// ==================== Account Lockout for Brute Force Protection ====================

// In-memory store for failed login attempts (resets on server restart)
// For production with multiple instances, use Redis
const failedLoginAttempts = new Map<string, { count: number; lastAttempt: number; lockedUntil: number | null }>();

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW = 15 * 60 * 1000; // 15 minutes - reset count after this

export async function isAccountLocked(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase();
  const record = failedLoginAttempts.get(normalizedEmail);

  if (!record) {
    return false;
  }

  // Check if lockout has expired
  if (record.lockedUntil && Date.now() > record.lockedUntil) {
    failedLoginAttempts.delete(normalizedEmail);
    return false;
  }

  return record.lockedUntil !== null;
}

export async function recordFailedLogin(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const now = Date.now();
  const record = failedLoginAttempts.get(normalizedEmail);

  if (!record || now - record.lastAttempt > ATTEMPT_WINDOW) {
    // Reset count if first attempt or window has passed
    failedLoginAttempts.set(normalizedEmail, {
      count: 1,
      lastAttempt: now,
      lockedUntil: null,
    });
    return;
  }

  const newCount = record.count + 1;

  if (newCount >= MAX_FAILED_ATTEMPTS) {
    // Lock the account
    failedLoginAttempts.set(normalizedEmail, {
      count: newCount,
      lastAttempt: now,
      lockedUntil: now + LOCKOUT_DURATION,
    });
    console.warn(`Account locked due to too many failed attempts: ${normalizedEmail}`);
  } else {
    failedLoginAttempts.set(normalizedEmail, {
      count: newCount,
      lastAttempt: now,
      lockedUntil: null,
    });
  }
}

export async function recordSuccessfulLogin(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  // Clear failed attempts on successful login
  failedLoginAttempts.delete(normalizedEmail);
}

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of failedLoginAttempts.entries()) {
    // Remove entries that are both unlocked and outside the attempt window
    if (!record.lockedUntil && now - record.lastAttempt > ATTEMPT_WINDOW) {
      failedLoginAttempts.delete(email);
    }
    // Remove entries where lockout has expired
    if (record.lockedUntil && now > record.lockedUntil) {
      failedLoginAttempts.delete(email);
    }
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes
