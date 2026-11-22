import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { encode } from 'next-auth/jwt';
import { proxy } from './proxy';

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
