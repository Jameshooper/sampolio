'use server';

import { auth } from '@/lib/auth';
import { updateTag } from 'next/cache';
import {
  getBalanceSnapshots,
  getAllAdjustments,
  getReconciliationSessions,
  deleteSnapshotsByIds,
  deleteAdjustmentsByIds,
  deleteSessionsByIds,
} from '@/lib/db/reconciliation';
import { computeCompactionPlan } from '@/lib/maintenance-utils';
import type { ApiResponse } from '@/types';

export interface HistoryCompactionStats {
  snapshots: number; // prunable balance snapshots (older than each entity's latest)
  adjustments: number; // adjustments orphaned by the pruned snapshots
  sessions: number; // reconciliation sessions older than the latest reconciliation month
  keptAnchors: number; // latest-per-entity snapshots that are always retained
}

async function buildPlan(userId: string) {
  const [snapshots, adjustments, sessions] = await Promise.all([
    getBalanceSnapshots(userId),
    getAllAdjustments(userId),
    getReconciliationSessions(userId),
  ]);
  return computeCompactionPlan(snapshots, adjustments, sessions);
}

/** Report what a compaction would remove, without deleting anything. */
export async function previewHistoryCompaction(): Promise<ApiResponse<HistoryCompactionStats>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  try {
    const plan = await buildPlan(session.user.id);
    return {
      success: true,
      data: {
        snapshots: plan.snapshotIds.length,
        adjustments: plan.adjustmentIds.length,
        sessions: plan.sessionIds.length,
        keptAnchors: plan.keptAnchorIds.length,
      },
    };
  } catch (error) {
    console.error('Preview history compaction error:', error);
    return { success: false, error: 'Failed to analyze history' };
  }
}

/** Prune pre-anchor reconciliation history. Idempotent; never changes a forecast. */
export async function compactHistory(): Promise<ApiResponse<HistoryCompactionStats>> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: 'Not authenticated' };
  try {
    const userId = session.user.id;
    const plan = await buildPlan(userId);
    // Delete adjustments first so none are left dangling mid-operation.
    const adjustments = await deleteAdjustmentsByIds(userId, plan.adjustmentIds);
    const snapshots = await deleteSnapshotsByIds(userId, plan.snapshotIds);
    const sessions = await deleteSessionsByIds(userId, plan.sessionIds);
    if (snapshots + sessions + adjustments > 0) {
      updateTag(`user:${userId}:reconciliation`);
    }
    return { success: true, data: { snapshots, adjustments, sessions, keptAnchors: plan.keptAnchorIds.length } };
  } catch (error) {
    console.error('Compact history error:', error);
    return { success: false, error: 'Failed to compact history' };
  }
}
