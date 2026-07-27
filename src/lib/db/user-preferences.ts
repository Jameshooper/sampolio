import * as path from 'path';
import type { UserPreferences } from '@/types';
import { getUserDir, ensureDir, readEncryptedFile, writeEncryptedFile } from './encryption';

function getPreferencesFile(userId: string): string {
  return path.join(getUserDir(userId), 'preferences.enc');
}

const DEFAULT_PREFERENCES: UserPreferences = {
  hasCompletedOnboarding: false,
  updatedAt: new Date().toISOString(),
};

export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  await ensureDir(getUserDir(userId));
  const prefs = await readEncryptedFile<UserPreferences>(getPreferencesFile(userId));
  return prefs ?? { ...DEFAULT_PREFERENCES, updatedAt: new Date().toISOString() };
}

export async function updateUserPreferences(
  userId: string,
  updates: Partial<Omit<UserPreferences, 'updatedAt'>>
): Promise<UserPreferences> {
  const current = await getUserPreferences(userId);
  const updated: UserPreferences = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await writeEncryptedFile(getPreferencesFile(userId), updated);
  return updated;
}
