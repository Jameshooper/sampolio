import * as path from 'path';
import * as fs from 'fs/promises';
import { getDataDir, readEncryptedFile, updateEncryptedFile } from './encryption';

/**
 * Signed-out session ids (the JWT `sid` claim, stable across token refreshes).
 *
 * JWT sessions are stateless, so signing out only deletes the browser cookie; a
 * copy of the cookie would keep working until it expires. Sign-out records the
 * `sid` here and the auth `jwt` callback rejects it. Entries are kept until no
 * token carrying that sid can still be valid (revocation time + session
 * max-age), then pruned. Ending *all* of a user's sessions uses
 * `User.sessionVersion` instead (see src/lib/db/users.ts).
 */

interface RevokedSessionsFile {
  entries: { sid: string; until: number }[];
}

const FILE = 'revoked-sessions.enc';

function getFilePath(): string {
  return path.join(getDataDir(), FILE);
}

// The file is the source of truth. Sign-out is handled by the Auth.js route
// handler while sessions are checked from server actions/pages — separate
// module instances — so the parsed list is cached per process on globalThis
// and re-read whenever the file's mtime changes (one stat per check).
interface RevokedCache { mtimeMs: number; map: Map<string, number> }
const store = globalThis as { __sampolioRevokedSessions?: RevokedCache | null };

async function load(): Promise<Map<string, number>> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(getFilePath())).mtimeMs;
  } catch {
    // No file yet → nothing revoked.
  }
  const cached = store.__sampolioRevokedSessions;
  if (cached && cached.mtimeMs === mtimeMs) return cached.map;
  const data = mtimeMs ? await readEncryptedFile<RevokedSessionsFile>(getFilePath()) : null;
  const now = Date.now();
  const map = new Map((data?.entries ?? []).filter((e) => e.until > now).map((e) => [e.sid, e.until] as [string, number]));
  store.__sampolioRevokedSessions = { mtimeMs, map };
  return map;
}

export async function isSessionRevoked(sid: string): Promise<boolean> {
  const map = await load();
  const until = map.get(sid);
  return until !== undefined && until > Date.now();
}

export async function revokeSession(sid: string, keepForMs: number): Promise<void> {
  const until = Date.now() + keepForMs;
  await updateEncryptedFile<RevokedSessionsFile>(getFilePath(), (current) => {
    const now = Date.now();
    const entries = (current?.entries ?? []).filter((e) => e.until > now && e.sid !== sid);
    entries.push({ sid, until });
    return { entries };
  });
  store.__sampolioRevokedSessions = null; // force a re-read (and fresh mtime) on the next check
}

/** Test hook. */
export function resetRevokedSessionsCacheForTests(): void {
  store.__sampolioRevokedSessions = null;
}
