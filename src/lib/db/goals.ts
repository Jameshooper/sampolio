import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Goal,
  CreateGoalRequest,
  UpdateGoalRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

function getGoalsDir(userId: string): string {
  return path.join(getUserDir(userId), 'goals');
}

function getGoalFile(userId: string, goalId: string): string {
  return path.join(getGoalsDir(userId), `${goalId}.enc`);
}

// ============================================================
// GOALS CRUD
// ============================================================

export async function getGoals(userId: string): Promise<Goal[]> {
  const goalsDir = getGoalsDir(userId);
  await ensureDir(goalsDir);

  const files = await listFiles(goalsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<Goal>(path.join(goalsDir, file)))
  );
  const goals = results.filter((g): g is Goal => g !== null);

  return goals.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGoalById(userId: string, goalId: string): Promise<Goal | null> {
  const goalFile = getGoalFile(userId, goalId);
  return readEncryptedFile<Goal>(goalFile);
}

export async function createGoal(userId: string, data: CreateGoalRequest): Promise<Goal> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const goal: Goal = {
    id,
    userId,
    name: data.name,
    description: data.description,
    targetAmount: data.targetAmount,
    currency: data.currency,
    targetDate: data.targetDate,
    trackingMethod: data.trackingMethod,
    linkedAccountId: data.linkedAccountId,
    currentManualAmount: data.currentManualAmount,
    goalType: data.goalType,
    priority: data.priority,
    injectIntoCashflow: data.injectIntoCashflow,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
  };

  const goalsDir = getGoalsDir(userId);
  await ensureDir(goalsDir);

  const goalFile = getGoalFile(userId, id);
  await writeEncryptedFile(goalFile, goal);

  return goal;
}

export async function updateGoal(
  userId: string,
  goalId: string,
  updates: UpdateGoalRequest
): Promise<Goal | null> {
  const goal = await getGoalById(userId, goalId);
  if (!goal) {
    return null;
  }

  const updatedGoal: Goal = {
    ...goal,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const goalFile = getGoalFile(userId, goalId);
  await writeEncryptedFile(goalFile, updatedGoal);

  return updatedGoal;
}

export async function deleteGoal(userId: string, goalId: string): Promise<boolean> {
  const goalFile = getGoalFile(userId, goalId);
  await deleteFile(goalFile);
  return true;
}
