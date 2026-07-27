/**
 * User avatar image endpoint.
 *
 * Serves the plain (unencrypted) binary avatar stored at
 * data/users/{id}/avatar.webp (see setUserAvatar in src/lib/db/users.ts). The
 * whole point of a route handler — rather than inlining the image as a data URI
 * — is HTTP caching: the URL carries an immutable `?v={avatarVersion}` buster
 * (avatarUrlFor), so the browser caches each version for a year and repeat
 * renders across the app do zero work. Requires an authenticated session; the
 * image itself is low-sensitivity, so `Cache-Control: private` (browser-only,
 * never a shared/CDN cache) is enough.
 *
 * This runs on the default Node runtime (needs fs) — do NOT switch to edge.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { auth } from '@/lib/auth';
import { getAvatarPath } from '@/lib/db/users';

// User ids are UUIDs; this also blocks any path-traversal payload before the id
// is ever passed to a filesystem path join.
const SAFE_USER_ID = /^[A-Za-z0-9-]+$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { userId } = await params;
  if (!SAFE_USER_ID.test(userId)) {
    return NextResponse.json({ error: 'Invalid user id' }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = await readFile(getAvatarPath(userId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'No avatar' }, { status: 404 });
    }
    throw err;
  }

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'image/webp',
      // Immutable: the URL changes (?v=) whenever the image does, so a given URL
      // never returns different bytes. `private` keeps it out of shared caches.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': String(buf.length),
    },
  });
}
