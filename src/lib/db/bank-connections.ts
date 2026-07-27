/**
 * Enable Banking — connection storage (file I/O).
 *
 * A BankConnection (one bank consent + its linked accounts) is stored
 * per-user, one file per connection. The live consent secrets live in a
 * SEPARATE companion file (`{id}.session.enc`) that is NEVER cached and never
 * logged — only the action/sync layers read it, by an uncached accessor.
 *
 * Layout: data/users/{userId}/bank/connections/{id}.enc
 *         data/users/{userId}/bank/connections/{id}.session.enc
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  BankConnection,
  BankAccountLink,
  BankConnectionStatus,
  BankSessionSecret,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getBankDir(userId: string): string {
  return path.join(getUserDir(userId), 'bank');
}

function getConnectionsDir(userId: string): string {
  return path.join(getBankDir(userId), 'connections');
}

function getConnectionFile(userId: string, connectionId: string): string {
  return path.join(getConnectionsDir(userId), `${connectionId}.enc`);
}

function getSessionSecretFile(userId: string, connectionId: string): string {
  return path.join(getConnectionsDir(userId), `${connectionId}.session.enc`);
}

// ============================================================
// Connections
// ============================================================

export async function getBankConnections(userId: string): Promise<BankConnection[]> {
  const dir = getConnectionsDir(userId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter(
    (f) => f.endsWith('.enc') && !f.endsWith('.session.enc')
  );
  const results = await Promise.all(
    files.map((f) => readEncryptedFile<BankConnection>(path.join(dir, f)))
  );
  return results
    .filter((c): c is BankConnection => c !== null)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function getBankConnectionById(
  userId: string,
  connectionId: string
): Promise<BankConnection | null> {
  return readEncryptedFile<BankConnection>(getConnectionFile(userId, connectionId));
}

export async function createBankConnection(
  userId: string,
  data: {
    aspspName: string;
    aspspCountry: string;
    applicationId?: string;
    status?: BankConnectionStatus;
  }
): Promise<BankConnection> {
  const now = new Date().toISOString();
  const connection: BankConnection = {
    id: uuidv4(),
    userId,
    aspspName: data.aspspName,
    aspspCountry: data.aspspCountry,
    applicationId: data.applicationId,
    status: data.status ?? 'pending',
    psuType: 'personal',
    linkedAccounts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeEncryptedFile(getConnectionFile(userId, connection.id), connection);
  return connection;
}

export async function updateBankConnection(
  userId: string,
  connectionId: string,
  updates: Partial<Omit<BankConnection, 'id' | 'userId' | 'createdAt'>>
): Promise<BankConnection | null> {
  const existing = await getBankConnectionById(userId, connectionId);
  if (!existing) return null;
  const updated: BankConnection = {
    ...existing,
    ...updates,
    id: existing.id,
    userId: existing.userId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await writeEncryptedFile(getConnectionFile(userId, connectionId), updated);
  return updated;
}

/** Replace the full linked-account list (used after mapping accounts at consent). */
export async function setConnectionLinkedAccounts(
  userId: string,
  connectionId: string,
  linkedAccounts: BankAccountLink[]
): Promise<BankConnection | null> {
  return updateBankConnection(userId, connectionId, { linkedAccounts });
}

export async function deleteBankConnection(
  userId: string,
  connectionId: string
): Promise<boolean> {
  await deleteFile(getConnectionFile(userId, connectionId));
  await deleteFile(getSessionSecretFile(userId, connectionId));
  return true;
}

// ============================================================
// Session secret — UNCACHED, never logged
// ============================================================

/** Read the live consent secrets for a connection. Intentionally not cached. */
export async function getBankSessionSecret(
  userId: string,
  connectionId: string
): Promise<BankSessionSecret | null> {
  return readEncryptedFile<BankSessionSecret>(getSessionSecretFile(userId, connectionId));
}

export async function writeBankSessionSecret(
  userId: string,
  secret: BankSessionSecret
): Promise<void> {
  await writeEncryptedFile(getSessionSecretFile(userId, secret.connectionId), secret);
}

export async function deleteBankSessionSecret(
  userId: string,
  connectionId: string
): Promise<void> {
  await deleteFile(getSessionSecretFile(userId, connectionId));
}

/**
 * Find the pending connection for a user whose session secret carries the given
 * single-use `state`. Used by the OAuth callback for CSRF matching. Returns the
 * connection + its secret, or null when no match (or already consumed).
 */
export async function findConnectionByState(
  userId: string,
  state: string
): Promise<{ connection: BankConnection; secret: BankSessionSecret } | null> {
  const connections = await getBankConnections(userId);
  for (const connection of connections) {
    const secret = await getBankSessionSecret(userId, connection.id);
    if (secret && secret.state === state) {
      return { connection, secret };
    }
  }
  return null;
}
