import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserDir, ensureDir, readEncryptedFile, writeEncryptedFile } from './encryption';
import { mergeById } from '@/lib/data-transfer-utils';
import type { DataExport } from '@/lib/schemas/data-transfer.schema';
import type { BalanceSnapshot, ReconciliationAdjustment, ReconciliationSession } from '@/types';

// Writes an export payload back to disk at the canonical per-entity paths.
// Bypasses the db `create*` functions on purpose: those regenerate ids and
// timestamps, which would break every cross-reference in the backup. Ids and
// createdAt/updatedAt are preserved; only `userId` is rewritten to the
// importing user. NEVER touches bank data (`bank-connections/` etc.) — bank
// state is tied to this instance's consents and is not part of the backup.

// Dirs owned by the export payload — the ONLY ones replace mode may remove.
const EXPORTED_DIRS = ['accounts', 'investments', 'receivables', 'debts', 'goals', 'budgets', 'reconciliation'];

type Row = { id: string } & Record<string, unknown>;

async function writeRows(dir: string, rows: Row[], userId: string): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureDir(dir);
  await Promise.all(
    rows.map((row) => writeEncryptedFile(path.join(dir, `${row.id}.enc`), { ...row, userId }))
  );
  return rows.length;
}

async function mergeAggregateFile<T extends { id: string }>(
  filePath: string,
  key: string,
  incoming: T[],
  mode: 'merge' | 'replace'
): Promise<void> {
  const existing = mode === 'merge' ? await readEncryptedFile<Record<string, T[]>>(filePath) : null;
  const merged = mergeById(existing?.[key] ?? [], incoming);
  await writeEncryptedFile(filePath, { [key]: merged });
}

export interface ImportCounts {
  accounts: number;
  accountSubItems: number;
  investments: number;
  debts: number;
  receivables: number;
  goals: number;
  budgets: number;
  snapshots: number;
}

export async function writeUserDataFromExport(
  userId: string,
  data: DataExport,
  mode: 'merge' | 'replace'
): Promise<ImportCounts> {
  const userDir = getUserDir(userId);

  if (mode === 'replace') {
    await Promise.all(
      EXPORTED_DIRS.map((d) => fs.rm(path.join(userDir, d), { recursive: true, force: true }))
    );
  }

  const counts: ImportCounts = {
    accounts: 0,
    accountSubItems: 0,
    investments: 0,
    debts: 0,
    receivables: 0,
    goals: 0,
    budgets: 0,
    snapshots: 0,
  };
  const e = data.entities;

  for (const account of e.accounts) {
    const { recurringItems, plannedItems, salaryConfigs, taxedIncomes, ...accountRow } = account;
    await writeRows(path.join(userDir, 'accounts'), [accountRow as unknown as Row], userId);
    counts.accounts++;
    const base = path.join(userDir, 'accounts', account.id);
    counts.accountSubItems += await writeRows(path.join(base, 'recurring'), recurringItems as unknown as Row[], userId);
    counts.accountSubItems += await writeRows(path.join(base, 'planned'), plannedItems as unknown as Row[], userId);
    counts.accountSubItems += await writeRows(path.join(base, 'salary'), salaryConfigs as unknown as Row[], userId);
    counts.accountSubItems += await writeRows(path.join(base, 'taxed-income'), taxedIncomes as unknown as Row[], userId);
  }

  for (const investment of e.investments) {
    const { contributions, ...row } = investment;
    await writeRows(path.join(userDir, 'investments'), [row as unknown as Row], userId);
    counts.investments++;
    await writeRows(path.join(userDir, 'investments', investment.id, 'contributions'), contributions as unknown as Row[], userId);
  }

  for (const debt of e.debts) {
    const { referenceRates, extraPayments, ...row } = debt;
    await writeRows(path.join(userDir, 'debts'), [row as unknown as Row], userId);
    counts.debts++;
    await writeRows(path.join(userDir, 'debts', debt.id, 'reference-rates'), referenceRates as unknown as Row[], userId);
    await writeRows(path.join(userDir, 'debts', debt.id, 'extra-payments'), extraPayments as unknown as Row[], userId);
  }

  for (const receivable of e.receivables) {
    const { repayments, ...row } = receivable;
    await writeRows(path.join(userDir, 'receivables'), [row as unknown as Row], userId);
    counts.receivables++;
    await writeRows(path.join(userDir, 'receivables', receivable.id, 'repayments'), repayments as unknown as Row[], userId);
  }

  counts.goals = await writeRows(path.join(userDir, 'goals'), e.goals as unknown as Row[], userId);
  counts.budgets = await writeRows(path.join(userDir, 'budgets'), e.budgets as unknown as Row[], userId);

  // Reconciliation lives in three aggregate files, not one file per row.
  const reconDir = path.join(userDir, 'reconciliation');
  await ensureDir(reconDir);
  const stampUser = <T extends { id: string }>(rows: T[]) => rows.map((r) => ({ ...r, userId }));
  await mergeAggregateFile<BalanceSnapshot>(
    path.join(reconDir, 'balance-snapshots.enc'), 'snapshots',
    stampUser(e.reconciliation.snapshots as unknown as BalanceSnapshot[]), mode
  );
  await mergeAggregateFile<ReconciliationAdjustment>(
    path.join(reconDir, 'reconciliation-adjustments.enc'), 'adjustments',
    e.reconciliation.adjustments as unknown as ReconciliationAdjustment[], mode
  );
  await mergeAggregateFile<ReconciliationSession>(
    path.join(reconDir, 'reconciliation-sessions.enc'), 'sessions',
    stampUser(e.reconciliation.sessions as unknown as ReconciliationSession[]), mode
  );
  counts.snapshots = e.reconciliation.snapshots.length;

  if (e.preferences) {
    await writeEncryptedFile(path.join(userDir, 'preferences.enc'), e.preferences);
  }

  return counts;
}
