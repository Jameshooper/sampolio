/**
 * Tests for the add-on's recovery switches.
 *
 * These exist because a forgotten password previously meant uninstalling the
 * add-on with "delete app data" — so the one property that matters most is
 * that neither switch can fire twice. A wipe that repeated on every restart
 * would destroy the data the maintainer had just finished restoring.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpDirs: string[] = [];

function scratchDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampolio-maint-'));
  tmpDirs.push(dir);
  process.env.DATA_DIR = dir;
  return dir;
}

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const MARKER = '.admin-password-reset-done';

describe('generateTemporaryPassword', () => {
  it('always satisfies the app’s own password policy', async () => {
    const { generateTemporaryPassword } = await import('@/lib/addon-maintenance');
    // The maintainer may well keep this password, so it has to pass the same
    // rules the sign-up form enforces.
    for (let i = 0; i < 200; i++) {
      const pw = generateTemporaryPassword();
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it('avoids glyphs that are ambiguous when retyped from a log', () => {
    // 0/O and 1/l/I are the ones that get mistyped off a terminal.
    return import('@/lib/addon-maintenance').then(({ generateTemporaryPassword }) => {
      for (let i = 0; i < 200; i++) {
        expect(generateTemporaryPassword()).not.toMatch(/[0O1lI]/);
      }
    });
  });

  it('does not repeat itself', async () => {
    const { generateTemporaryPassword } = await import('@/lib/addon-maintenance');
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(200);
  });
});

describe('runAdminPasswordReset', () => {
  it('resets the oldest admin and prints the password exactly once', async () => {
    const dir = scratchDataDir();
    const changePassword = vi.fn().mockResolvedValue(true);
    vi.doMock('@/lib/db/users', () => ({
      changePassword,
      getAllUsers: vi.fn().mockResolvedValue([
        { id: 'u2', email: 'sam@example.com', role: 'admin', createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'u1', email: 'alex@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'u3', email: 'other@example.com', role: 'user', createdAt: '2025-01-01T00:00:00.000Z' },
      ]),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    await runAdminPasswordReset(true);

    // Oldest *admin*, not merely the oldest account.
    expect(changePassword).toHaveBeenCalledTimes(1);
    expect(changePassword.mock.calls[0][0]).toBe('u1');

    const banner = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(banner).toContain('alex@example.com');
    expect(banner).toContain(changePassword.mock.calls[0][1]);
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(true);
  });

  it('refuses to fire again while the switch is left on', async () => {
    const dir = scratchDataDir();
    await fsp.writeFile(path.join(dir, MARKER), '2026-01-01T00:00:00.000Z');
    const changePassword = vi.fn().mockResolvedValue(true);
    vi.doMock('@/lib/db/users', () => ({
      changePassword,
      getAllUsers: vi.fn().mockResolvedValue([
        { id: 'u1', email: 'alex@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    await runAdminPasswordReset(true);

    expect(changePassword).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toContain('already been applied');
  });

  it('re-arms once the switch is turned off', async () => {
    const dir = scratchDataDir();
    await fsp.writeFile(path.join(dir, MARKER), 'x');
    vi.doMock('@/lib/db/users', () => ({ changePassword: vi.fn(), getAllUsers: vi.fn() }));

    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    await runAdminPasswordReset(false);

    expect(fs.existsSync(path.join(dir, MARKER))).toBe(false);
  });

  it('stays armed, and changes nothing, when there are no accounts yet', async () => {
    const dir = scratchDataDir();
    const changePassword = vi.fn();
    vi.doMock('@/lib/db/users', () => ({ changePassword, getAllUsers: vi.fn().mockResolvedValue([]) }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    await runAdminPasswordReset(true);

    expect(changePassword).not.toHaveBeenCalled();
    // Not marking it done means it still works after the first sign-up.
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(false);
  });

  it('does not mark the reset done when the password change fails', async () => {
    const dir = scratchDataDir();
    vi.doMock('@/lib/db/users', () => ({
      changePassword: vi.fn().mockResolvedValue(false),
      getAllUsers: vi.fn().mockResolvedValue([
        { id: 'u1', email: 'alex@example.com', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z' },
      ]),
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { runAdminPasswordReset } = await import('@/lib/addon-maintenance');
    await runAdminPasswordReset(true);

    // Otherwise a failed reset would lock the maintainer out permanently.
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(false);
  });
});
