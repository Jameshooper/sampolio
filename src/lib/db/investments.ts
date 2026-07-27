import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  InvestmentAccount,
  InvestmentContribution,
  CreateInvestmentAccountRequest,
  UpdateInvestmentAccountRequest,
  CreateInvestmentContributionRequest,
  UpdateInvestmentContributionRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getInvestmentsDir(userId: string): string {
  return path.join(getUserDir(userId), 'investments');
}

function getInvestmentFile(userId: string, investmentId: string): string {
  return path.join(getInvestmentsDir(userId), `${investmentId}.enc`);
}

function getContributionsDir(userId: string, investmentId: string): string {
  return path.join(getInvestmentsDir(userId), investmentId, 'contributions');
}

function getContributionFile(userId: string, investmentId: string, contributionId: string): string {
  return path.join(getContributionsDir(userId, investmentId), `${contributionId}.enc`);
}

// ============================================================
// INVESTMENT ACCOUNTS CRUD
// ============================================================

export async function getInvestmentAccounts(userId: string): Promise<InvestmentAccount[]> {
  const investmentsDir = getInvestmentsDir(userId);
  await ensureDir(investmentsDir);

  const files = await listFiles(investmentsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<InvestmentAccount>(path.join(investmentsDir, file)))
  );
  const investments = results.filter((i): i is InvestmentAccount => i !== null);

  return investments.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getInvestmentAccountById(
  userId: string,
  investmentId: string
): Promise<InvestmentAccount | null> {
  const investmentFile = getInvestmentFile(userId, investmentId);
  return readEncryptedFile<InvestmentAccount>(investmentFile);
}

export async function createInvestmentAccount(
  userId: string,
  data: CreateInvestmentAccountRequest
): Promise<InvestmentAccount> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const investment: InvestmentAccount = {
    id,
    userId,
    name: data.name,
    description: data.description,
    currency: data.currency,
    startingValuation: data.startingValuation,
    valuationDate: data.valuationDate,
    annualGrowthRate: data.annualGrowthRate,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const investmentsDir = getInvestmentsDir(userId);
  await ensureDir(investmentsDir);

  const investmentFile = getInvestmentFile(userId, id);
  await writeEncryptedFile(investmentFile, investment);

  return investment;
}

export async function updateInvestmentAccount(
  userId: string,
  investmentId: string,
  updates: UpdateInvestmentAccountRequest
): Promise<InvestmentAccount | null> {
  const investment = await getInvestmentAccountById(userId, investmentId);
  if (!investment) {
    return null;
  }

  const updatedInvestment: InvestmentAccount = {
    ...investment,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const investmentFile = getInvestmentFile(userId, investmentId);
  await writeEncryptedFile(investmentFile, updatedInvestment);

  return updatedInvestment;
}

export async function deleteInvestmentAccount(userId: string, investmentId: string): Promise<boolean> {
  // Delete all contributions first
  const contributionsDir = getContributionsDir(userId, investmentId);
  try {
    const contributionFiles = await listFiles(contributionsDir);
    for (const file of contributionFiles) {
      await deleteFile(path.join(contributionsDir, file));
    }
  } catch {
    // Directory might not exist
  }

  const investmentFile = getInvestmentFile(userId, investmentId);
  await deleteFile(investmentFile);
  return true;
}

// ============================================================
// CONTRIBUTIONS CRUD
// ============================================================

export async function getContributions(
  userId: string,
  investmentId: string
): Promise<InvestmentContribution[]> {
  const contributionsDir = getContributionsDir(userId, investmentId);
  try {
    await ensureDir(contributionsDir);
  } catch {
    return [];
  }

  const files = await listFiles(contributionsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<InvestmentContribution>(path.join(contributionsDir, file)))
  );
  const contributions = results.filter((c): c is InvestmentContribution => c !== null);

  return contributions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function getContributionById(
  userId: string,
  investmentId: string,
  contributionId: string
): Promise<InvestmentContribution | null> {
  const contributionFile = getContributionFile(userId, investmentId, contributionId);
  return readEncryptedFile<InvestmentContribution>(contributionFile);
}

export async function createContribution(
  userId: string,
  investmentId: string,
  data: CreateInvestmentContributionRequest
): Promise<InvestmentContribution> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const contribution: InvestmentContribution = {
    id,
    investmentAccountId: investmentId,
    type: data.type,
    kind: data.kind,
    amount: data.amount,
    scheduledDate: data.scheduledDate,
    frequency: data.frequency,
    customIntervalMonths: data.customIntervalMonths,
    startDate: data.startDate,
    endDate: data.endDate,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const contributionsDir = getContributionsDir(userId, investmentId);
  await ensureDir(contributionsDir);

  const contributionFile = getContributionFile(userId, investmentId, id);
  await writeEncryptedFile(contributionFile, contribution);

  return contribution;
}

export async function updateContribution(
  userId: string,
  investmentId: string,
  contributionId: string,
  updates: UpdateInvestmentContributionRequest
): Promise<InvestmentContribution | null> {
  const contribution = await getContributionById(userId, investmentId, contributionId);
  if (!contribution) {
    return null;
  }

  const updatedContribution: InvestmentContribution = {
    ...contribution,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const contributionFile = getContributionFile(userId, investmentId, contributionId);
  await writeEncryptedFile(contributionFile, updatedContribution);

  return updatedContribution;
}

export async function deleteContribution(
  userId: string,
  investmentId: string,
  contributionId: string
): Promise<boolean> {
  const contributionFile = getContributionFile(userId, investmentId, contributionId);
  await deleteFile(contributionFile);
  return true;
}
