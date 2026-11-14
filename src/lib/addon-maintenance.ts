/**
 * One-shot maintenance actions driven by Home Assistant add-on options.
 *
 * These exist so a forgotten password never again means uninstalling the
 * add-on with "delete app data". They run once at server start, from the
 * instrumentation hook, and reuse the app's own user/encryption layer rather
 * than reimplementing it.
 *
 * Both are guarded by a marker file so that leaving the option switched on
 * cannot repeat the action on every restart — the destructive half of that
 * (`wipe_data`) is handled in run.sh for the same reason, before the server
 * is even started. Turning the option off removes the marker, so the next
 * time it is switched on it runs again.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/db/encryption';
import { changePassword, getAllUsers } from '@/lib/db/users';

const RESET_MARKER = '.admin-password-reset-done';

/** Characters are drawn per class so the result always satisfies the app's own password policy. */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const DIGITS = '23456789'; // no 0, 1
const SYMBOLS = '!#$%&*+-=?@';

function pick(set: string): string {
  return set[crypto.randomInt(set.length)];
}

/**
 * A password the maintainer will read off a log line and retype once, so it
 * avoids glyphs that are ambiguous in a terminal font. 20 characters drawn
 * from ~70 symbols is far beyond what a local brute force threatens.
 */
export function generateTemporaryPassword(length = 20): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  // Guarantee one of each class, then fill, then shuffle so the guaranteed
  // characters are not always in the same positions.
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Reset the admin account's password to a freshly generated one and print it
 * to the add-on log exactly once.
 *
 * The password is generated here and shown in the log rather than taken from
 * an add-on option on purpose: an option's value is stored in plain text in
 * /data/options.json and displayed in the add-on's Configuration tab, whereas
 * the log line is transient and visible only to someone who is already signed
 * in to Home Assistant.
 */
export async function runAdminPasswordReset(
  enabled = process.env.SAMPOLIO_RESET_ADMIN_PASSWORD === 'true'
): Promise<void> {
  const markerPath = path.join(getDataDir(), RESET_MARKER);

  if (!enabled) {
    // Arm the next request. Nothing to do if it was never used.
    await fs.rm(markerPath, { force: true });
    return;
  }

  try {
    await fs.access(markerPath);
    console.warn(
      '[addon] reset_admin_password is still switched on, but the reset has already been applied. ' +
        'Set it back to false in the add-on Configuration tab; it will not run again until you do.'
    );
    return;
  } catch {
    // No marker: this is a fresh request.
  }

  const users = await getAllUsers();
  if (users.length === 0) {
    console.warn(
      '[addon] reset_admin_password is on, but this data directory has no accounts yet. ' +
        'Sign up at /auth/signup — the first account becomes the admin. Leaving the option armed.'
    );
    return;
  }

  // Oldest admin, else the oldest account: the one a single-household install
  // actually means by "my login".
  const admins = users.filter((u) => u.role === 'admin');
  const target = (admins.length > 0 ? admins : users).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )[0];

  const password = generateTemporaryPassword();
  const ok = await changePassword(target.id, password);
  if (!ok) {
    console.error(`[addon] Failed to reset the password for ${target.email}. The account was left unchanged.`);
    return;
  }

  // Deliberately loud and deliberately once. Anyone who can read this log can
  // already reach Home Assistant itself.
  console.warn(
    '\n' +
      '='.repeat(72) + '\n' +
      '  SAMPOLIO — ADMIN PASSWORD RESET\n' +
      `  Account : ${target.email}\n` +
      `  Password: ${password}\n` +
      '  Sign in with this now, change it in Settings, then set\n' +
      '  reset_admin_password back to false in the Configuration tab.\n' +
      '  This is shown once and is not stored anywhere else.\n' +
      '='.repeat(72) + '\n'
  );

  await fs.writeFile(markerPath, new Date().toISOString(), { mode: 0o600 });
}
