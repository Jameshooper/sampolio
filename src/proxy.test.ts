/**
 * Regression tests for the edge proxy's handling of a session cookie on an
 * auth page.
 *
 * This block used to delete the session cookie whenever one was present on
 * /auth/signin, on the assumption that only a stale JWT could get there. The
 * sign-in page calls router.refresh() immediately after authenticating, which
 * re-requests /auth/signin carrying the cookie that was just set — so every
 * successful sign-in destroyed its own session, and login appeared to do
 * nothing at all, with no error client-side or server-side. These tests pin
 * both halves: a valid session survives, an invalid one is still cleared so
 * the redirect loop it guards against stays broken.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { proxy } from '@/proxy';
import { sessionCookieName } from '@/lib/auth-cookies';

const SECRET = 'test-secret-for-proxy-session-tests';
const ORIGIN = 'http://192.0.2.10:3999'; // plain http, non-localhost: the add-on's shape

let validToken: string;

beforeAll(async () => {
  process.env.AUTH_SECRET = SECRET;
  process.env.AUTH_URL = ORIGIN;
  validToken = await encode({
    token: { id: 'user-1', email: 'alex@example.com', role: 'user' },
    secret: SECRET,
    salt: sessionCookieName(),
  });
});

/** The Set-Cookie directives this response uses to expire the session. */
function clearedCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => /session-token=/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c))
    .map((c) => c.split('=')[0]);
}

function requestWithCookie(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(path, ORIGIN));
  if (cookie) req.cookies.set(sessionCookieName(), cookie);
  return req;
}

describe('proxy: session cookie on an auth page', () => {
  it('keeps a valid session and sends the visitor into the app', async () => {
    const res = await proxy(requestWithCookie('/auth/signin', validToken));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('still clears a session cookie whose JWT does not verify', async () => {
    // This is the redirect loop the block exists for: the server-side auth()
    // check rejects the token, bounces here, and without clearing it the
    // visitor can never reach a sign-in form again.
    const res = await proxy(requestWithCookie('/auth/signin', 'not-a-valid-jwt'));
    expect(clearedCookies(res).length).toBeGreaterThan(0);
    expect(res.headers.get('location')).toBeNull();
  });

  it('clears a token signed with a different secret', async () => {
    const foreign = await encode({
      token: { id: 'user-1' },
      secret: 'a-completely-different-secret-value',
      salt: sessionCookieName(),
    });
    expect(clearedCookies(await proxy(requestWithCookie('/auth/signin', foreign))).length).toBeGreaterThan(0);
  });

  it('leaves a visitor with no cookie alone on the sign-in page', async () => {
    const res = await proxy(requestWithCookie('/auth/signin'));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.headers.get('location')).toBeNull();
  });

  it('applies the same rule to the sign-up page', async () => {
    const res = await proxy(requestWithCookie('/auth/signup', validToken));
    expect(clearedCookies(res)).toEqual([]);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });
});
