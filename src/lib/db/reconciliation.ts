import * as crypto from 'crypto';
import * as path from 'path';
import { getUserDir, ensureDir, readEncryptedFile, writeEncryptedFile } from './encryption';
import type { BalanceSnapshot, ReconciliationAdjustment, ReconciliationSession, EntityType, AdjustmentCategory } from '@/types';

const SNAPSHOTS_FILE = 'balance-snapshots.enc';
const ADJUSTMENTS_FILE = 'reconciliation-adjustments.enc';
const SESSIONS_FILE = 'reconciliation-sessions.enc';

function getReconciliationDir(userId: string): string {
  return path.join(getUserDir(userId), 'reconciliation');
}

// ============================================================
// Balance Snapshots
// ============================================================

interface SnapshotsData {
  snapshots: BalanceSnapshot[];
}

async function readSnapshots(userId: string): Promise<SnapshotsData> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  const data = await readEncryptedFile<SnapshotsData>(path.join(dir, SNAPSHOTS_FILE));
  return data || { snapshots: [] };
}

async function writeSnapshots(userId: string, data: SnapshotsData): Promise<void> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  await writeEncryptedFile(path.join(dir, SNAPSHOTS_FILE), data);
}

export async function getBalanceSnapshots(userId: string): Promise<BalanceSnapshot[]> {
  const data = await readSnapshots(userId);
  return data.snapshots;
}

export async function getSnapshotsForEntity(
  userId: string,
  entityType: EntityType,
  entityId: string
): Promise<BalanceSnapshot[]> {
  const data = await readSnapshots(userId);
  return data.snapshots.filter(
    s => s.entityType === entityType && s.entityId === entityId
  ).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

export async function getSnapshotsForMonth(
  userId: string,
  yearMonth: string
): Promise<BalanceSnapshot[]> {
  const data = await readSnapshots(userId);
  return data.snapshots.filter(s => s.yearMonth === yearMonth);
}

export async function getLatestSnapshot(
  userId: string,
  entityType: EntityType,
  entityId: string
): Promise<BalanceSnapshot | null> {
  const snapshots = await getSnapshotsForEntity(userId, entityType, entityId);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

export async function createBalanceSnapshot(
  userId: string,
  entityType: EntityType,
  entityId: string,
  yearMonth: string,
  expectedBalance: number,
  actualBalance: number,
  source: 'manual' | 'bank-sync' = 'manual'
): Promise<BalanceSnapshot> {
  const data = await readSnapshots(userId);

  // Check if snapshot already exists for this entity/month
  const existingIndex = data.snapshots.findIndex(
    s => s.entityType === entityType && s.entityId === entityId && s.yearMonth === yearMonth
  );
  const existing = existingIndex >= 0 ? data.snapshots[existingIndex] : null;

  // Last write wins for a given entity/month. A bank-sync reflects the real
  // account balance at sync time, so it supersedes the current month's prior
  // snapshot (manual or an earlier sync) — that is why a linked account's
  // displayed balance and forecast anchor track the bank, not a stale manually
  // entered value. Bank-sync only ever writes the CURRENT month, so historical
  // manual reconciliations are never overwritten. A manual reconciliation
  // likewise overwrites the current bank value (until the next sync), letting
  // the user correct a mid-clearing or otherwise wrong bank balance.

  const snapshot: BalanceSnapshot = {
    id: existing ? existing.id : crypto.randomUUID(),
    userId,
    entityType,
    entityId,
    yearMonth,
    expectedBalance,
    actualBalance,
    variance: actualBalance - expectedBalance,
    source,
    createdAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    data.snapshots[existingIndex] = snapshot;
  } else {
    data.snapshots.push(snapshot);
  }

  await writeSnapshots(userId, data);
  return snapshot;
}

export async function deleteBalanceSnapshot(userId: string, snapshotId: string): Promise<boolean> {
  const data = await readSnapshots(userId);
  const index = data.snapshots.findIndex(s => s.id === snapshotId);
  if (index === -1) return false;

  data.snapshots.splice(index, 1);
  await writeSnapshots(userId, data);
  return true;
}

/** Bulk-delete snapshots by id in a single rewrite. Returns the count removed. */
export async function deleteSnapshotsByIds(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  const data = await readSnapshots(userId);
  const before = data.snapshots.length;
  data.snapshots = data.snapshots.filter(s => !idSet.has(s.id));
  const removed = before - data.snapshots.length;
  if (removed > 0) await writeSnapshots(userId, data);
  return removed;
}

// ============================================================
// Reconciliation Adjustments
// ============================================================

interface AdjustmentsData {
  adjustments: ReconciliationAdjustment[];
}

async function readAdjustments(userId: string): Promise<AdjustmentsData> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  const data = await readEncryptedFile<AdjustmentsData>(path.join(dir, ADJUSTMENTS_FILE));
  return data || { adjustments: [] };
}

async function writeAdjustments(userId: string, data: AdjustmentsData): Promise<void> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  await writeEncryptedFile(path.join(dir, ADJUSTMENTS_FILE), data);
}

export async function getAdjustmentsForSnapshot(
  userId: string,
  snapshotId: string
): Promise<ReconciliationAdjustment[]> {
  const data = await readAdjustments(userId);
  return data.adjustments.filter(a => a.snapshotId === snapshotId);
}

export async function getAllAdjustments(userId: string): Promise<ReconciliationAdjustment[]> {
  const data = await readAdjustments(userId);
  return data.adjustments;
}

/** Bulk-delete adjustments by id in a single rewrite. Returns the count removed. */
export async function deleteAdjustmentsByIds(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  const data = await readAdjustments(userId);
  const before = data.adjustments.length;
  data.adjustments = data.adjustments.filter(a => !idSet.has(a.id));
  const removed = before - data.adjustments.length;
  if (removed > 0) await writeAdjustments(userId, data);
  return removed;
}

export async function createAdjustment(
  userId: string,
  snapshotId: string,
  category: AdjustmentCategory,
  amount: number,
  description?: string
): Promise<ReconciliationAdjustment> {
  const data = await readAdjustments(userId);
  
  const adjustment: ReconciliationAdjustment = {
    id: crypto.randomUUID(),
    snapshotId,
    category,
    amount,
    description,
    createdAt: new Date().toISOString(),
  };
  
  data.adjustments.push(adjustment);
  await writeAdjustments(userId, data);
  return adjustment;
}

export async function deleteAdjustment(userId: string, adjustmentId: string): Promise<boolean> {
  const data = await readAdjustments(userId);
  const index = data.adjustments.findIndex(a => a.id === adjustmentId);
  if (index === -1) return false;
  
  data.adjustments.splice(index, 1);
  await writeAdjustments(userId, data);
  return true;
}

// ============================================================
// Reconciliation Sessions
// ============================================================

interface SessionsData {
  sessions: ReconciliationSession[];
}

async function readSessions(userId: string): Promise<SessionsData> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  const data = await readEncryptedFile<SessionsData>(path.join(dir, SESSIONS_FILE));
  return data || { sessions: [] };
}

async function writeSessions(userId: string, data: SessionsData): Promise<void> {
  const dir = getReconciliationDir(userId);
  await ensureDir(dir);
  await writeEncryptedFile(path.join(dir, SESSIONS_FILE), data);
}

export async function getReconciliationSessions(userId: string): Promise<ReconciliationSession[]> {
  const data = await readSessions(userId);
  return data.sessions.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
}

export async function getSessionForMonth(
  userId: string,
  yearMonth: string
): Promise<ReconciliationSession | null> {
  const data = await readSessions(userId);
  return data.sessions.find(s => s.yearMonth === yearMonth) || null;
}

export async function getLatestCompletedSession(
  userId: string
): Promise<ReconciliationSession | null> {
  const data = await readSessions(userId);
  const completed = data.sessions
    .filter(s => s.status === 'completed')
    .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  return completed.length > 0 ? completed[0] : null;
}

/** Bulk-delete reconciliation sessions by id in a single rewrite. Returns the count removed. */
export async function deleteSessionsByIds(userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const idSet = new Set(ids);
  const data = await readSessions(userId);
  const before = data.sessions.length;
  data.sessions = data.sessions.filter(s => !idSet.has(s.id));
  const removed = before - data.sessions.length;
  if (removed > 0) await writeSessions(userId, data);
  return removed;
}

export async function createReconciliationSession(
  userId: string,
  yearMonth: string
): Promise<ReconciliationSession> {
  const data = await readSessions(userId);
  
  // Check if session already exists for this month
  const existingIndex = data.sessions.findIndex(s => s.yearMonth === yearMonth);
  
  const session: ReconciliationSession = {
    id: existingIndex >= 0 ? data.sessions[existingIndex].id : crypto.randomUUID(),
    userId,
    yearMonth,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    snapshots: [],
    adjustments: [],
  };
  
  if (existingIndex >= 0) {
    // Update existing session but keep snapshots if any
    session.snapshots = data.sessions[existingIndex].snapshots;
    session.adjustments = data.sessions[existingIndex].adjustments;
    data.sessions[existingIndex] = session;
  } else {
    data.sessions.push(session);
  }
  
  await writeSessions(userId, data);
  return session;
}

export async function completeReconciliationSession(
  userId: string,
  sessionId: string
): Promise<ReconciliationSession | null> {
  const data = await readSessions(userId);
  const index = data.sessions.findIndex(s => s.id === sessionId);
  if (index === -1) return null;
  
  data.sessions[index].status = 'completed';
  data.sessions[index].completedAt = new Date().toISOString();
  
  await writeSessions(userId, data);
  return data.sessions[index];
}

export async function updateSessionSnapshots(
  userId: string,
  sessionId: string,
  snapshots: BalanceSnapshot[]
): Promise<ReconciliationSession | null> {
  const data = await readSessions(userId);
  const index = data.sessions.findIndex(s => s.id === sessionId);
  if (index === -1) return null;
  
  data.sessions[index].snapshots = snapshots;
  await writeSessions(userId, data);
  return data.sessions[index];
}

export async function updateSessionAdjustments(
  userId: string,
  sessionId: string,
  adjustments: ReconciliationAdjustment[]
): Promise<ReconciliationSession | null> {
  const data = await readSessions(userId);
  const index = data.sessions.findIndex(s => s.id === sessionId);
  if (index === -1) return null;
  
  data.sessions[index].adjustments = adjustments;
  await writeSessions(userId, data);
  return data.sessions[index];
}

// ============================================================
// Utility Functions
// ============================================================

export async function getReconciliationSummary(
  userId: string,
  yearMonth: string
): Promise<{
  isReconciled: boolean;
  totalVariance: number;
  entitiesReconciled: number;
  adjustmentsByCategory: Record<AdjustmentCategory, number>;
  lastReconciledAt?: string;
}> {
  const session = await getSessionForMonth(userId, yearMonth);
  const snapshots = await getSnapshotsForMonth(userId, yearMonth);
  
  const adjustmentsByCategory: Record<AdjustmentCategory, number> = {
    'untracked-income': 0,
    'untracked-expense': 0,
    'valuation-change': 0,
    'interest-adjustment': 0,
    'data-correction': 0,
    'other': 0,
  };
  
  // Aggregate adjustments
  for (const snapshot of snapshots) {
    const adjustments = await getAdjustmentsForSnapshot(userId, snapshot.id);
    for (const adj of adjustments) {
      adjustmentsByCategory[adj.category] += adj.amount;
    }
  }
  
  return {
    isReconciled: session?.status === 'completed',
    totalVariance: snapshots.reduce((sum, s) => sum + s.variance, 0),
    entitiesReconciled: snapshots.length,
    adjustmentsByCategory,
    lastReconciledAt: session?.completedAt,
  };
}
