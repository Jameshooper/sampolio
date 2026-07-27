import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  SalaryConfig,
  CreateSalaryConfigRequest,
  UpdateSalaryConfigRequest
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';
import { createRecurringItem, updateRecurringItem, deleteRecurringItem } from './recurring-items';
import { calculateNetSalary } from '../salary-utils';

export { calculateNetSalary };

function getSalaryConfigsDir(userId: string, accountId: string): string {
  return path.join(getUserDir(userId), 'accounts', accountId, 'salary');
}

function getSalaryConfigFile(userId: string, accountId: string, configId: string): string {
  return path.join(getSalaryConfigsDir(userId, accountId), `${configId}.enc`);
}

export async function getSalaryConfigs(userId: string, accountId: string): Promise<SalaryConfig[]> {
  const configsDir = getSalaryConfigsDir(userId, accountId);
  await ensureDir(configsDir);

  const files = await listFiles(configsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<SalaryConfig>(path.join(configsDir, file)))
  );
  const configs = results.filter((c): c is SalaryConfig => c !== null);

  return configs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getActiveSalaryConfigs(userId: string, accountId: string): Promise<SalaryConfig[]> {
  const configs = await getSalaryConfigs(userId, accountId);
  return configs.filter(config => config.isActive);
}

export async function getSalaryConfigById(
  userId: string,
  accountId: string,
  configId: string
): Promise<SalaryConfig | null> {
  const configFile = getSalaryConfigFile(userId, accountId, configId);
  return readEncryptedFile<SalaryConfig>(configFile);
}

export async function createSalaryConfig(
  userId: string,
  data: CreateSalaryConfigRequest
): Promise<SalaryConfig> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const netSalary = calculateNetSalary(
    data.grossSalary,
    data.taxRate,
    data.contributionsRate,
    data.otherDeductions || 0,
    data.benefits || []
  );

  let linkedRecurringItemId: string | undefined;

  // Create linked recurring income item if requested
  if (data.isLinkedToRecurring) {
    const recurringItem = await createRecurringItem(userId, {
      accountId: data.accountId,
      type: 'income',
      name: `Salary: ${data.name}`,
      amount: netSalary,
      category: 'Salary',
      frequency: 'monthly',
      startDate: data.startDate,
      endDate: data.endDate,
      isActive: data.isActive ?? true,
    });
    linkedRecurringItemId = recurringItem.id;
  }

  const config: SalaryConfig = {
    id,
    accountId: data.accountId,
    name: data.name,
    grossSalary: data.grossSalary,
    benefits: data.benefits || [],
    taxRate: data.taxRate,
    contributionsRate: data.contributionsRate,
    otherDeductions: data.otherDeductions || 0,
    netSalary,
    isLinkedToRecurring: data.isLinkedToRecurring ?? false,
    linkedRecurringItemId,
    startDate: data.startDate,
    endDate: data.endDate,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  };

  const configsDir = getSalaryConfigsDir(userId, data.accountId);
  await ensureDir(configsDir);

  const configFile = getSalaryConfigFile(userId, data.accountId, id);
  await writeEncryptedFile(configFile, config);

  return config;
}

export async function updateSalaryConfig(
  userId: string,
  accountId: string,
  configId: string,
  updates: UpdateSalaryConfigRequest
): Promise<SalaryConfig | null> {
  const config = await getSalaryConfigById(userId, accountId, configId);
  if (!config) {
    return null;
  }

  // Recalculate net salary if any salary parameters changed
  const grossSalary = updates.grossSalary ?? config.grossSalary;
  const taxRate = updates.taxRate ?? config.taxRate;
  const contributionsRate = updates.contributionsRate ?? config.contributionsRate;
  const otherDeductions = updates.otherDeductions ?? config.otherDeductions;
  const benefits = updates.benefits ?? config.benefits ?? [];

  const netSalary = calculateNetSalary(grossSalary, taxRate, contributionsRate, otherDeductions, benefits);

  const updatedConfig: SalaryConfig = {
    ...config,
    ...updates,
    netSalary,
    updatedAt: new Date().toISOString(),
  };

  // Update linked recurring item if it exists
  if (config.linkedRecurringItemId && config.isLinkedToRecurring) {
    await updateRecurringItem(userId, accountId, config.linkedRecurringItemId, {
      name: `Salary: ${updatedConfig.name}`,
      amount: netSalary,
      startDate: updatedConfig.startDate,
      endDate: updatedConfig.endDate,
      isActive: updatedConfig.isActive,
    });
  }

  const configFile = getSalaryConfigFile(userId, accountId, configId);
  await writeEncryptedFile(configFile, updatedConfig);

  return updatedConfig;
}

export async function toggleSalaryConfigActive(
  userId: string,
  accountId: string,
  configId: string
): Promise<SalaryConfig | null> {
  const config = await getSalaryConfigById(userId, accountId, configId);
  if (!config) {
    return null;
  }

  return updateSalaryConfig(userId, accountId, configId, { isActive: !config.isActive });
}

export async function deleteSalaryConfig(
  userId: string,
  accountId: string,
  configId: string
): Promise<boolean> {
  const config = await getSalaryConfigById(userId, accountId, configId);

  // Delete linked recurring item if it exists
  if (config?.linkedRecurringItemId) {
    await deleteRecurringItem(userId, accountId, config.linkedRecurringItemId);
  }

  const configFile = getSalaryConfigFile(userId, accountId, configId);
  await deleteFile(configFile);
  return true;
}
