/**
 * Shared Mortgage storage layer.
 *
 * Unlike every other entity (scoped to a single user's directory), a mortgage is
 * SHARED by a set of members. It lives in a global, non-user-scoped directory and
 * is decryptable by the app's global key; access control is enforced in the action
 * layer via the `members` list. A per-user reverse index maps userId → mortgageIds
 * so reads don't have to scan and decrypt every shared file.
 *
 * Layout:
 *   data/shared/mortgages/{id}.enc                 # SharedMortgage (loans + members embedded)
 *   data/shared/mortgages/{id}/rates/{id}.enc      # Euribor reset history
 *   data/shared/mortgages/{id}/costs/{id}.enc      # insurance / invoicing / service fee history
 *   data/shared/mortgages/{id}/extra-payments/{id}.enc
 *   data/shared/mortgages/{id}/snapshots/{id}.enc  # drift re-anchors
 *   data/shared/mortgage-members/{userId}.enc      # { mortgageIds: string[] } reverse index
 */

import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  SharedMortgage,
  MortgageMember,
  MortgageLoan,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageExtraPayment,
  MortgageBalanceSnapshot,
  CreateMortgageRequest,
  UpdateMortgageRequest,
  UpdateMortgageLoanRequest,
  UpdateMortgageMemberRequest,
  SetMortgageRateRequest,
  SetMortgageCostRequest,
  CreateMortgageExtraPaymentRequest,
  CreateMortgageBalanceSnapshotRequest,
  MortgageActualEntry,
  MortgageActualInput,
  MortgageDayCount,
  MortgagePaymentMode,
} from '@/types';
import {
  getDataDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

// ============================================================
// PATHS
// ============================================================

function getSharedDir(): string {
  return path.join(getDataDir(), 'shared');
}
function getMortgagesDir(): string {
  return path.join(getSharedDir(), 'mortgages');
}
function getMortgageFile(mortgageId: string): string {
  return path.join(getMortgagesDir(), `${mortgageId}.enc`);
}
function getRatesDir(mortgageId: string): string {
  return path.join(getMortgagesDir(), mortgageId, 'rates');
}
function getCostsDir(mortgageId: string): string {
  return path.join(getMortgagesDir(), mortgageId, 'costs');
}
function getExtraPaymentsDir(mortgageId: string): string {
  return path.join(getMortgagesDir(), mortgageId, 'extra-payments');
}
function getSnapshotsDir(mortgageId: string): string {
  return path.join(getMortgagesDir(), mortgageId, 'snapshots');
}
function getActualsDir(mortgageId: string): string {
  return path.join(getMortgagesDir(), mortgageId, 'actuals');
}
function getMemberIndexFile(userId: string): string {
  return path.join(getSharedDir(), 'mortgage-members', `${userId}.enc`);
}

// ============================================================
// REVERSE MEMBER INDEX
// ============================================================

interface MemberIndex {
  mortgageIds: string[];
}

export async function getMortgageIdsForUser(userId: string): Promise<string[]> {
  const index = await readEncryptedFile<MemberIndex>(getMemberIndexFile(userId));
  return index?.mortgageIds ?? [];
}

async function addUserToMortgageIndex(userId: string, mortgageId: string): Promise<void> {
  const ids = await getMortgageIdsForUser(userId);
  if (!ids.includes(mortgageId)) {
    ids.push(mortgageId);
    await writeEncryptedFile(getMemberIndexFile(userId), { mortgageIds: ids });
  }
}

async function removeUserFromMortgageIndex(userId: string, mortgageId: string): Promise<void> {
  const ids = await getMortgageIdsForUser(userId);
  const next = ids.filter((id) => id !== mortgageId);
  await writeEncryptedFile(getMemberIndexFile(userId), { mortgageIds: next });
}

// ============================================================
// MORTGAGE CRUD
// ============================================================

export async function getMortgageById(mortgageId: string): Promise<SharedMortgage | null> {
  return readEncryptedFile<SharedMortgage>(getMortgageFile(mortgageId));
}

export async function getMortgagesForUser(userId: string): Promise<SharedMortgage[]> {
  const ids = await getMortgageIdsForUser(userId);
  const results = await Promise.all(ids.map((id) => getMortgageById(id)));
  return results
    .filter((m): m is SharedMortgage => m !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function buildLoan(input: CreateMortgageRequest['loans'][number]): MortgageLoan {
  return {
    id: uuidv4(),
    label: input.label,
    kind: input.kind,
    initialPrincipal: input.initialPrincipal,
    startDate: input.startDate,
    originalTermMonths: input.originalTermMonths,
    paymentMode: (input.paymentMode ?? 'annuity-fixed-term') as MortgagePaymentMode,
    margin: input.margin,
    dayCount: (input.dayCount ?? 'actual/360') as MortgageDayCount,
    paymentDayOfMonth: input.paymentDayOfMonth,
    currentMonthlyPayment: input.currentMonthlyPayment,
    aspSubsidy: input.aspSubsidy,
  };
}

/**
 * Create a shared mortgage. `members` must be fully resolved (email→userId done
 * in the action layer); the creator is added as an 'owner'. Genesis rate/cost
 * schedules are written as sub-collection entries.
 */
export async function createMortgage(
  creator: { userId: string; email: string; name: string },
  data: CreateMortgageRequest,
  resolvedMembers: MortgageMember[]
): Promise<SharedMortgage> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const creatorMember: MortgageMember = {
    userId: creator.userId,
    email: creator.email,
    name: creator.name,
    role: 'owner',
    initialPayment: data.creatorInitialPayment,
    loanSharePercent: data.creatorLoanSharePercent,
    ownershipTargetPercent: data.creatorOwnershipTargetPercent,
  };

  const members = [creatorMember, ...resolvedMembers.filter((m) => m.userId !== creator.userId)];

  const mortgage: SharedMortgage = {
    id,
    name: data.name,
    currency: data.currency,
    housePrice: data.housePrice,
    rateResetMonth: data.rateResetMonth ?? 12,
    rateResetDay: data.rateResetDay ?? 14,
    loans: data.loans.map(buildLoan),
    members,
    isArchived: false,
    createdBy: creator.userId,
    createdAt: now,
    updatedAt: now,
    updatedBy: creator.userId,
  };

  await ensureDir(getMortgagesDir());
  await writeEncryptedFile(getMortgageFile(id), mortgage);

  // Genesis schedules
  for (const r of data.rates ?? []) {
    await setRate(id, { effectiveDate: r.effectiveDate, euriborRate: r.euriborRate, note: r.note });
  }
  for (const c of data.costs ?? []) {
    await setCost(id, c);
  }

  // Reverse index for every member
  await Promise.all(members.map((m) => addUserToMortgageIndex(m.userId, id)));

  return mortgage;
}

export async function updateMortgage(
  mortgageId: string,
  updates: UpdateMortgageRequest,
  byUserId: string
): Promise<SharedMortgage | null> {
  const mortgage = await getMortgageById(mortgageId);
  if (!mortgage) return null;
  const updated: SharedMortgage = {
    ...mortgage,
    ...updates,
    updatedAt: new Date().toISOString(),
    updatedBy: byUserId,
  };
  await writeEncryptedFile(getMortgageFile(mortgageId), updated);
  return updated;
}

export async function updateMortgageLoan(
  mortgageId: string,
  loanId: string,
  updates: UpdateMortgageLoanRequest,
  byUserId: string
): Promise<SharedMortgage | null> {
  const mortgage = await getMortgageById(mortgageId);
  if (!mortgage) return null;
  const updated: SharedMortgage = {
    ...mortgage,
    loans: mortgage.loans.map((l) => (l.id === loanId ? { ...l, ...updates, id: l.id } : l)),
    updatedAt: new Date().toISOString(),
    updatedBy: byUserId,
  };
  await writeEncryptedFile(getMortgageFile(mortgageId), updated);
  return updated;
}

export async function deleteMortgage(mortgageId: string): Promise<boolean> {
  const mortgage = await getMortgageById(mortgageId);
  // Cascade sub-collections
  for (const dir of [
    getRatesDir(mortgageId),
    getCostsDir(mortgageId),
    getExtraPaymentsDir(mortgageId),
    getSnapshotsDir(mortgageId),
    getActualsDir(mortgageId),
  ]) {
    try {
      const files = await listFiles(dir);
      for (const f of files) await deleteFile(path.join(dir, f));
    } catch {
      // dir may not exist
    }
  }
  await deleteFile(getMortgageFile(mortgageId));
  // Clean each member's reverse index
  if (mortgage) {
    await Promise.all(mortgage.members.map((m) => removeUserFromMortgageIndex(m.userId, mortgageId)));
  }
  return true;
}

// ============================================================
// MEMBERS
// ============================================================

export async function addMortgageMember(
  mortgageId: string,
  member: MortgageMember
): Promise<SharedMortgage | null> {
  const mortgage = await getMortgageById(mortgageId);
  if (!mortgage) return null;
  if (mortgage.members.some((m) => m.userId === member.userId)) return mortgage; // already a member
  const updated: SharedMortgage = {
    ...mortgage,
    members: [...mortgage.members, member],
    updatedAt: new Date().toISOString(),
  };
  await writeEncryptedFile(getMortgageFile(mortgageId), updated);
  await addUserToMortgageIndex(member.userId, mortgageId);
  return updated;
}

export async function removeMortgageMember(
  mortgageId: string,
  userId: string
): Promise<SharedMortgage | null> {
  const mortgage = await getMortgageById(mortgageId);
  if (!mortgage) return null;
  const updated: SharedMortgage = {
    ...mortgage,
    members: mortgage.members.filter((m) => m.userId !== userId),
    updatedAt: new Date().toISOString(),
  };
  await writeEncryptedFile(getMortgageFile(mortgageId), updated);
  await removeUserFromMortgageIndex(userId, mortgageId);
  return updated;
}

export async function updateMortgageMember(
  mortgageId: string,
  userId: string,
  updates: UpdateMortgageMemberRequest
): Promise<SharedMortgage | null> {
  const mortgage = await getMortgageById(mortgageId);
  if (!mortgage) return null;
  const updated: SharedMortgage = {
    ...mortgage,
    members: mortgage.members.map((m) => (m.userId === userId ? { ...m, ...updates } : m)),
    updatedAt: new Date().toISOString(),
  };
  await writeEncryptedFile(getMortgageFile(mortgageId), updated);
  return updated;
}

// ============================================================
// RATES (Euribor schedule)
// ============================================================

export async function getRates(mortgageId: string): Promise<MortgageRateEntry[]> {
  const dir = getRatesDir(mortgageId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.enc'));
  const results = await Promise.all(files.map((f) => readEncryptedFile<MortgageRateEntry>(path.join(dir, f))));
  return results
    .filter((r): r is MortgageRateEntry => r !== null)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

export async function setRate(
  mortgageId: string,
  data: SetMortgageRateRequest
): Promise<MortgageRateEntry> {
  const dir = getRatesDir(mortgageId);
  await ensureDir(dir);
  const existing = (await getRates(mortgageId)).find((r) => r.effectiveDate === data.effectiveDate);
  if (existing) {
    const updated: MortgageRateEntry = { ...existing, euriborRate: data.euriborRate, note: data.note };
    await writeEncryptedFile(path.join(dir, `${existing.id}.enc`), updated);
    return updated;
  }
  const entry: MortgageRateEntry = {
    id: uuidv4(),
    mortgageId,
    effectiveDate: data.effectiveDate,
    euriborRate: data.euriborRate,
    note: data.note,
    createdAt: new Date().toISOString(),
  };
  await writeEncryptedFile(path.join(dir, `${entry.id}.enc`), entry);
  return entry;
}

export async function deleteRate(mortgageId: string, rateId: string): Promise<boolean> {
  await deleteFile(path.join(getRatesDir(mortgageId), `${rateId}.enc`));
  return true;
}

// ============================================================
// COSTS (insurance / invoicing / service fee schedule)
// ============================================================

export async function getCosts(mortgageId: string): Promise<MortgageCostEntry[]> {
  const dir = getCostsDir(mortgageId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.enc'));
  const results = await Promise.all(files.map((f) => readEncryptedFile<MortgageCostEntry>(path.join(dir, f))));
  return results
    .filter((c): c is MortgageCostEntry => c !== null)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

export async function setCost(
  mortgageId: string,
  data: SetMortgageCostRequest
): Promise<MortgageCostEntry> {
  const dir = getCostsDir(mortgageId);
  await ensureDir(dir);
  // Upsert by type + loanId + effectiveDate
  const existing = (await getCosts(mortgageId)).find(
    (c) => c.type === data.type && c.loanId === data.loanId && c.effectiveDate === data.effectiveDate
  );
  if (existing) {
    const updated: MortgageCostEntry = { ...existing, amount: data.amount, note: data.note };
    await writeEncryptedFile(path.join(dir, `${existing.id}.enc`), updated);
    return updated;
  }
  const entry: MortgageCostEntry = {
    id: uuidv4(),
    mortgageId,
    type: data.type,
    loanId: data.loanId,
    effectiveDate: data.effectiveDate,
    amount: data.amount,
    note: data.note,
    createdAt: new Date().toISOString(),
  };
  await writeEncryptedFile(path.join(dir, `${entry.id}.enc`), entry);
  return entry;
}

export async function deleteCost(mortgageId: string, costId: string): Promise<boolean> {
  await deleteFile(path.join(getCostsDir(mortgageId), `${costId}.enc`));
  return true;
}

// ============================================================
// EXTRA PAYMENTS
// ============================================================

export async function getExtraPayments(mortgageId: string): Promise<MortgageExtraPayment[]> {
  const dir = getExtraPaymentsDir(mortgageId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.enc'));
  const results = await Promise.all(files.map((f) => readEncryptedFile<MortgageExtraPayment>(path.join(dir, f))));
  return results
    .filter((p): p is MortgageExtraPayment => p !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function createExtraPayment(
  mortgageId: string,
  data: CreateMortgageExtraPaymentRequest
): Promise<MortgageExtraPayment> {
  const dir = getExtraPaymentsDir(mortgageId);
  await ensureDir(dir);
  const entry: MortgageExtraPayment = {
    id: uuidv4(),
    mortgageId,
    loanId: data.loanId,
    date: data.date,
    amount: data.amount,
    mode: data.mode,
    note: data.note,
    createdAt: new Date().toISOString(),
  };
  await writeEncryptedFile(path.join(dir, `${entry.id}.enc`), entry);
  return entry;
}

export async function deleteExtraPayment(mortgageId: string, paymentId: string): Promise<boolean> {
  await deleteFile(path.join(getExtraPaymentsDir(mortgageId), `${paymentId}.enc`));
  return true;
}

// ============================================================
// DRIFT SNAPSHOTS
// ============================================================

export async function getBalanceSnapshots(mortgageId: string): Promise<MortgageBalanceSnapshot[]> {
  const dir = getSnapshotsDir(mortgageId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.enc'));
  const results = await Promise.all(files.map((f) => readEncryptedFile<MortgageBalanceSnapshot>(path.join(dir, f))));
  return results
    .filter((s): s is MortgageBalanceSnapshot => s !== null)
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

export async function createBalanceSnapshot(
  mortgageId: string,
  data: CreateMortgageBalanceSnapshotRequest
): Promise<MortgageBalanceSnapshot> {
  const dir = getSnapshotsDir(mortgageId);
  await ensureDir(dir);
  // Upsert by loanId + yearMonth
  const existing = (await getBalanceSnapshots(mortgageId)).find(
    (s) => s.loanId === data.loanId && s.yearMonth === data.yearMonth
  );
  if (existing) {
    const updated: MortgageBalanceSnapshot = { ...existing, actualBalance: data.actualBalance, note: data.note };
    await writeEncryptedFile(path.join(dir, `${existing.id}.enc`), updated);
    return updated;
  }
  const entry: MortgageBalanceSnapshot = {
    id: uuidv4(),
    mortgageId,
    loanId: data.loanId,
    yearMonth: data.yearMonth,
    actualBalance: data.actualBalance,
    note: data.note,
    createdAt: new Date().toISOString(),
  };
  await writeEncryptedFile(path.join(dir, `${entry.id}.enc`), entry);
  return entry;
}

export async function deleteBalanceSnapshot(mortgageId: string, snapshotId: string): Promise<boolean> {
  await deleteFile(path.join(getSnapshotsDir(mortgageId), `${snapshotId}.enc`));
  return true;
}

// ============================================================
// ACTUAL MONTHLY ENTRIES (imported bank history)
// ============================================================

export async function getActuals(mortgageId: string): Promise<MortgageActualEntry[]> {
  const dir = getActualsDir(mortgageId);
  await ensureDir(dir);
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.enc'));
  const results = await Promise.all(files.map((f) => readEncryptedFile<MortgageActualEntry>(path.join(dir, f))));
  return results
    .filter((a): a is MortgageActualEntry => a !== null)
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth) || a.loanId.localeCompare(b.loanId));
}

export async function setActual(
  mortgageId: string,
  input: MortgageActualInput
): Promise<MortgageActualEntry> {
  const dir = getActualsDir(mortgageId);
  await ensureDir(dir);
  // Upsert by loanId + yearMonth
  const existing = (await getActuals(mortgageId)).find(
    (a) => a.loanId === input.loanId && a.yearMonth === input.yearMonth
  );
  if (existing) {
    const updated: MortgageActualEntry = {
      ...existing,
      remaining: input.remaining,
      repayment: input.repayment,
      interest: input.interest,
      insurance: input.insurance,
      subsidy: input.subsidy ?? 0,
    };
    await writeEncryptedFile(path.join(dir, `${existing.id}.enc`), updated);
    return updated;
  }
  const entry: MortgageActualEntry = {
    id: uuidv4(),
    mortgageId,
    loanId: input.loanId,
    yearMonth: input.yearMonth,
    remaining: input.remaining,
    repayment: input.repayment,
    interest: input.interest,
    insurance: input.insurance,
    subsidy: input.subsidy ?? 0,
    createdAt: new Date().toISOString(),
  };
  await writeEncryptedFile(path.join(dir, `${entry.id}.enc`), entry);
  return entry;
}

export async function deleteAllActuals(mortgageId: string): Promise<void> {
  const dir = getActualsDir(mortgageId);
  try {
    const files = await listFiles(dir);
    for (const f of files) await deleteFile(path.join(dir, f));
  } catch {
    // dir may not exist
  }
}

/** Remove every recorded actual for one month (all loans). Used to "un-reconcile"
 * a month so it reverts to a projected forecast. Returns the number deleted. */
export async function deleteActualsForMonth(mortgageId: string, yearMonth: string): Promise<number> {
  const dir = getActualsDir(mortgageId);
  const toDelete = (await getActuals(mortgageId)).filter((a) => a.yearMonth === yearMonth);
  for (const a of toDelete) await deleteFile(path.join(dir, `${a.id}.enc`));
  return toDelete.length;
}

/** Bulk import. When replaceAll is true, clears existing actuals first. */
export async function bulkSetActuals(
  mortgageId: string,
  inputs: MortgageActualInput[],
  replaceAll = false
): Promise<number> {
  if (replaceAll) await deleteAllActuals(mortgageId);
  for (const input of inputs) await setActual(mortgageId, input);
  return inputs.length;
}
