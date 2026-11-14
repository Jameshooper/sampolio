import * as path from 'path';
import type { AppSettings } from '@/types';
import {
  getDataDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
} from './encryption';

const APP_SETTINGS_FILE = 'app-settings.enc';

async function getAppSettingsPath(): Promise<string> {
  const dataDir = getDataDir();
  await ensureDir(dataDir);
  return path.join(dataDir, APP_SETTINGS_FILE);
}

const DEFAULT_SETTINGS: AppSettings = {
  // Closed by default. First-time setup is unaffected: signUp() always allows
  // the very first account regardless of this flag, and that account becomes
  // the admin — so the only thing this default changes is whether a *second*,
  // uninvited account can be created before anyone has thought about it. That
  // matters on the Home Assistant add-on, where the app may be published on a
  // port with no Home Assistant login in front of it.
  selfSignupEnabled: false,
  updatedAt: new Date().toISOString(),
  updatedBy: 'system',
};

export async function getAppSettings(): Promise<AppSettings> {
  const settingsPath = await getAppSettingsPath();
  const settings = await readEncryptedFile<AppSettings>(settingsPath);
  return settings || DEFAULT_SETTINGS;
}

export async function updateAppSettings(
  updates: Partial<Pick<AppSettings, 'selfSignupEnabled'>>,
  updatedBy: string
): Promise<AppSettings> {
  const currentSettings = await getAppSettings();
  
  const updatedSettings: AppSettings = {
    ...currentSettings,
    ...updates,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  
  const settingsPath = await getAppSettingsPath();
  await writeEncryptedFile(settingsPath, updatedSettings);
  
  return updatedSettings;
}

export async function isSelfSignupEnabled(): Promise<boolean> {
  const settings = await getAppSettings();
  return settings.selfSignupEnabled;
}
