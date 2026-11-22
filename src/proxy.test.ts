import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { proxy } from './proxy';
import { sessionCookieName } from '@/lib/auth-cookies';
import { createUser } from '@/lib/db/users';
import { revokeSession } from '@/lib/db/revoked-sessions';

/**
 * Regression tests for the proxy findings: any cookie *named*
 * `authjs.session-token` exempted a client from every rate limit, and the
 * client-chosen left-most X-Forwarded-For entry was the rate-limit key.
 */

const SECRET = 'test-secret-for-proxy-tests-0123456789abcdef';
const COOKIE = 'authjs.session-token'; // non-production cookie name

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
  delete process.env.TRUSTED_PROXY_HOPS;
});

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(url, 'http://localhost:3999'), {
    method: init.method ?? 'GET',
    headers: init.headers,
  });
}

async function validCookie(): Promise<string> {
  const token = await encode({ token: { id: 'user-1', sid: 'sid-1', sv: 0 }, secret: SECRET, salt: COOKIE });
  return `${COOKIE}=${token}`;
}

async function hammer(make: () => NextRequest, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await proxy(make())).status);
  return statuses;
}

describe('proxy', () => {
  it('a forged session cookie does not exempt credential posts from the rate limit', async () => {
    const statuses = await hammer(
      () =>
        req('/api/auth/callback/credentials', {
          method: 'POST',
          headers: { cookie: `${COOKIE}=garbage`, 'x-forwarded-for': '198.51.100.10' },
        }),
      25
    );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
  });

  it('a valid session still cannot post credentials without limit', async () => {
    const cookie = await validCookie();
    const statuses = await hammer(
      () => req('/api/auth/callback/credentials', { method: 'POST', headers: { cookie, 'x-forwarded-for': '198.51.100.11' } }),
      25
    );
    expect(statuses).toContain(429);
  });

  it('rotating the client-chosen X-Forwarded-For prefix does not create new buckets', async () => {
    let i = 0;
    const statuses = await hammer(
      () =>
        req('/auth/signin', {
          method: 'POST',
          headers: { 'x-forwarded-for': `6.6.6.${i++ % 250}, 198.51.100.12` },
        }),
      25
    );
    expect(statuses).toContain(429);
  });

  it('redirects signed-out and forged-cookie visitors away from app pages', async () => {
    const plain = await proxy(req('/cashflow', { headers: { 'x-forwarded-for': '198.51.100.13' } }));
    expect(plain.status).toBe(307);
    expect(plain.headers.get('location')).toContain('/auth/signin');

    const forged = await proxy(req('/cashflow', { headers: { cookie: `${COOKIE}=garbage`, 'x-forwarded-for': '198.51.100.13' } }));
    expect(forged.status).toBe(307);
  });

  it('lets a valid session through to app pages', async () => {
    const res = await proxy(req('/cashflow', { headers: { cookie: await validCookie(), 'x-forwarded-for': '198.51.100.14' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('caps the body size of signed-out server-action calls', async () => {
    const big = await proxy(
      req('/auth/signup', {
        method: 'POST',
        headers: { 'next-action': 'abc', 'content-length': String(5 * 1024 * 1024), 'x-forwarded-for': '198.51.100.15' },
      })
    );
    expect(big.status).toBe(413);

    const small = await proxy(
      req('/auth/signup', {
        method: 'POST',
        headers: { 'next-action': 'abc', 'content-length': '200', 'x-forwarded-for': '198.51.100.16' },
      })
    );
    expect(small.status).toBe(200);

    const signedIn = await proxy(
      req('/settings', {
        method: 'POST',
        headers: { 'next-action': 'abc', 'content-length': String(5 * 1024 * 1024), cookie: await validCookie(), 'x-forwarded-for': '198.51.100.17' },
      })
    );
    expect(signedIn.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Session cookie on an auth page (sign-in loop regression + revocation).
//
// This block used to delete the session cookie whenever one was present on
// /auth/signin, on the assumption that only a stale JWT could get there. The
// sign-in page calls router.refresh() immediately after authenticating, which
// re-requests /auth/signin carrying the cookie that was just set — so every
// successful sign-in destroyed its own session. A live session must survive
// (and be sent into the app); an invalid or revoked one must still be cleared,
// or the visitor loops between / and /auth/signin.
// ---------------------------------------------------------------------------

describe('proxy: session cookie on an auth page', () => {
  const ORIGIN = 'http://192.0.2.10:3999'; // plain http, non-localhost: the add-on's shape
  let dataDir: string;
  let liveToken: string;
  let liveCookieName: string;

  /** The Set-Cookie directives this response uses to expire the session. */
  function clearedCookies(res: Response): string[] {
    return res.headers
      .getSetCookie()
      .filter((c) => /session-token=/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c))
      .map((c) => c.split('=')[0]);
  }

  function requestWithCookie(path: string, cookie?: string): NextRequest {
    const req = new NextRequest(new URL(path, ORIGIN), { headers: { 'x-forwarded-for': '198.51.100.90' } });
    if (cookie) req.cookies.set(liveCookieName, cookie);
    return req;
  }

  beforeAll(async () => {
    dataDir = path.join(os.tmpdir(), `sampolio-proxy-auth-${process.pid}`);
    process.env.DATA_DIR = dataDir;
    process.env.ENCRYPTION_KEY ??= 'd'.repeat(64);
    process.env.AUTH_URL = ORIGIN;
    liveCookieName = sessionCookieName(); // authjs.session-token over plain http
    const user = await createUser('alex@example.com', 'Str0ng!Pass', 'Alex');
    liveToken = await encode({
      token: { id: user.id, email: user.email, role: user.role, sid: 'live-session', sv: user.sessionVersion ?? 0 },
      secret: SECRET,
      salt: liveCookieName,
    });
  });

  afterAll(async () => {
    delete process.env.AUTH_URL;
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps a live session and sends the visitor into the app', async () => {
    const res = await proxy(requestWithCookie('/auth/signin', liveToken));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('applies the same rule to the sign-up page', async () => {
    const res = await proxy(requestWithCookie('/auth/signup', liveToken));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('still clears a session cookie whose JWT does not verify', async () => {
    const res = await proxy(requestWithCookie('/auth/signin', 'not-a-valid-jwt'));
    expect(clearedCookies(res).length).toBeGreaterThan(0);
    expect(res.headers.get('location')).toBeNull();
  });

  it('clears a token signed with a different secret', async () => {
    const foreign = await encode({ token: { id: 'user-1' }, secret: 'a-completely-different-secret-value', salt: liveCookieName });
    expect(clearedCookies(await proxy(requestWithCookie('/auth/signin', foreign))).length).toBeGreaterThan(0);
  });

  it('clears (does not redirect) a verifying but revoked session — no / ↔ /auth/signin loop', async () => {
    const user = await createUser('sam@example.com', 'Str0ng!Pass', 'Sam');
    const token = await encode({
      token: { id: user.id, sid: 'signed-out-session', sv: user.sessionVersion ?? 0 },
      secret: SECRET,
      salt: liveCookieName,
    });
    await revokeSession('signed-out-session', 60_000);
    const res = await proxy(requestWithCookie('/auth/signin', token));
    expect(res.headers.get('location')).toBeNull();
    expect(clearedCookies(res).length).toBeGreaterThan(0);
  });

  it('leaves a visitor with no cookie alone on the sign-in page', async () => {
    const res = await proxy(requestWithCookie('/auth/signin'));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.headers.get('location')).toBeNull();
  });
});
