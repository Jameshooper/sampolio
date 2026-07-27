/**
 * Pure helpers for history compaction (no I/O). Decides which reconciliation
 * records are safe to prune WITHOUT changing any projection.
 *
 * Invariant: projections only ever read the *latest* snapshot per entity (the
 * anchor — see resolveAnchor in projection.ts). So keeping the latest snapshot
 * per (entityType, entityId) and dropping the rest leaves every forecast
 * byte-identical. Sessions/adjustments are historical logs the engine never reads.
 */
import type { BalanceSnapshot, ReconciliationAdjustment, ReconciliationSession } from '@/types';

export interface CompactionPlan {
  snapshotIds: string[]; // prunable: older-than-latest per entity
  adjustmentIds: string[]; // prunable: orphaned by a pruned snapshot
  sessionIds: string[]; // prunable: older than the latest reconciliation month
  keptAnchorIds: string[]; // the latest snapshot per entity (always retained)
}

export function computeCompactionPlan(
  snapshots: BalanceSnapshot[],
  adjustments: ReconciliationAdjustment[],
  sessions: ReconciliationSession[]
): CompactionPlan {
  // Keep the latest snapshot per entity; track the overall latest month.
  const byEntity = new Map<string, BalanceSnapshot[]>();
  for (const s of snapshots) {
    const key = `${s.entityType}:${s.entityId}`;
    const arr = byEntity.get(key) ?? [];
    arr.push(s);
    byEntity.set(key, arr);
  }

  const keptAnchorIds: string[] = [];
  let latestMonth = '';
  for (const arr of byEntity.values()) {
    arr.sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
    const latest = arr[arr.length - 1];
    keptAnchorIds.push(latest.id);
    if (latest.yearMonth > latestMonth) latestMonth = latest.yearMonth;
  }

  const keepSet = new Set(keptAnchorIds);
  const prunableSnapshots = snapshots.filter((s) => !keepSet.has(s.id));
  const prunableSnapshotIds = new Set(prunableSnapshots.map((s) => s.id));

  const adjustmentIds = adjustments
    .filter((a) => prunableSnapshotIds.has(a.snapshotId))
    .map((a) => a.id);

  // Sessions strictly before the latest reconciliation month are pure history.
  const sessionIds = latestMonth
    ? sessions.filter((s) => s.yearMonth < latestMonth).map((s) => s.id)
    : [];

  return {
    snapshotIds: prunableSnapshots.map((s) => s.id),
    adjustmentIds,
    sessionIds,
    keptAnchorIds,
  };
}
