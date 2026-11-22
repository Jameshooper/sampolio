import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { decode } from 'next-auth/jwt';
import { getClientIp } from '@/lib/client-ip';
import { validateSessionClaims } from '@/lib/session-validation';

// Proxy always runs on the Node.js runtime in Next 16. It does cheap,
// request-level gating: rate limits, a body-size cap for unauthenticated
// server-action calls, and redirecting obviously signed-out visitors. Real
// authorisation (including revocation) happens in auth() on the server.

// Rate limiting store (in-memory, single process, resets on server restart)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limit configuration
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_AUTH = 20; // per client per minute: credential posts, sign-up, and signed-out auth traffic
const RATE_LIMIT_MAX_GENERAL = 300; // per client per minute for signed-out requests

// Unauthenticated server-action calls (sign-up, signup-status) are tiny; the
// 20 MB action body limit in next.config.ts exists only for the signed-in
// backup import. Refuse large bodies before Next buffers and parses them.
const MAX_UNAUTHENTICATED_ACTION_BODY = 64 * 1024;

function checkRateLimit(key: string, maxRequests: number): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const record = rateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    rateLimitStore.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: maxRequests - 1, resetIn: RATE_LIMIT_WINDOW };
  }

  if (record.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetIn: record.resetTime - now };
  }

  record.count++;
  return { allowed: true, remaining: maxRequests - record.count, resetIn: record.resetTime - now };
}

// Clean up old rate limit entries periodically
if (typeof setInterval !== 'undefined') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
      if (now > record.resetTime) {
        rateLimitStore.delete(key);
      }
    }
  }, 60 * 1000); // Clean up every minute
  (timer as { unref?: () => void }).unref?.();
}

const SESSION_COOKIE_NAMES = [
  '__Secure-authjs.session-token',
  'authjs.session-token',
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
];

/** Raw session cookie (reassembling Auth.js chunked cookies), if any. */
function getSessionCookie(request: NextRequest): { name: string; value: string } | null {
  for (const name of SESSION_COOKIE_NAMES) {
    const whole = request.cookies.get(name)?.value;
    if (whole) return { name, value: whole };
    const chunks: string[] = [];
    for (let i = 0; ; i++) {
      const part = request.cookies.get(`${name}.${i}`)?.value;
      if (!part) break;
      chunks.push(part);
    }
    if (chunks.length > 0) return { name, value: chunks.join('') };
  }
  return null;
}

/** A session cookie is present (valid or not) — used only to clear stale ones. */
function hasSessionCookie(request: NextRequest): boolean {
  return getSessionCookie(request) !== null;
}

/**
 * The session cookie decrypts and verifies with AUTH_SECRET and hasn't
 * expired. Presence alone proves nothing (anyone can send a cookie named
 * `authjs.session-token`), so every "is this visitor signed in?" decision in
 * the proxy uses this. Revocation is checked later by auth().
 */
async function decodeSession(request: NextRequest): Promise<Record<string, unknown> | null> {
  const cookie = getSessionCookie(request);
  const secret = process.env.AUTH_SECRET;
  if (!cookie || !secret) return null;
  try {
    const payload = await decode({ token: cookie.value, secret, salt: cookie.name });
    return payload && typeof (payload as { id?: unknown }).id === 'string' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  return (await decodeSession(request)) !== null;
}

/** Valid AND not revoked — the full check auth() makes (one user-file read). */
async function hasLiveSession(request: NextRequest): Promise<boolean> {
  const payload = await decodeSession(request);
  if (!payload) return false;
  try {
    return (await validateSessionClaims(payload)) !== null;
  } catch {
    return false;
  }
}

function tooManyRequests(message: string, limit: number, remaining: number, resetIn: number): NextResponse {
  return new NextResponse(
    JSON.stringify({ success: false, error: message, retryAfter: Math.ceil(resetIn / 1000) }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': Math.ceil(resetIn / 1000).toString(),
        'X-RateLimit-Limit': limit.toString(),
        'X-RateLimit-Remaining': remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(resetIn / 1000).toString(),
      },
    }
  );
}

// URL prefixes of the authenticated app pages (the (dashboard) route group
// does not appear in URLs — list the real paths). Add new pages here.
const PROTECTED_PREFIXES = [
  '/overview',
  '/cashflow',
  '/mortgage',
  '/budgets',
  '/trips',
  '/split',
  '/bank',
  '/goals',
  '/playground',
  '/settings',
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const clientIp = getClientIp(request.headers);
  const isAuthenticated = await hasValidSession(request);

  // Credential checks and sign-up are always rate limited per client, signed in
  // or not (a signed-in user must not get unlimited password guesses against
  // someone else's account). Other signed-out traffic to the auth surface
  // shares the same bucket; signed-in session polling is exempt.
  const isAuthSurface = pathname.startsWith('/api/auth') || pathname.startsWith('/auth/');
  const isCredentialPost =
    request.method === 'POST' && (pathname.startsWith('/api/auth/callback') || pathname.startsWith('/auth/'));
  if (isCredentialPost || (isAuthSurface && !isAuthenticated)) {
    const { allowed, remaining, resetIn } = checkRateLimit(`auth:${clientIp}`, RATE_LIMIT_MAX_AUTH);
    if (!allowed) {
      return tooManyRequests('Too many requests. Please try again later.', RATE_LIMIT_MAX_AUTH, remaining, resetIn);
    }
  }

  if (!isAuthenticated) {
    // General limit for signed-out visitors. Signed-in users are exempt: server
    // actions (POSTs to page URLs) can legitimately burst during page loads.
    const generalLimit = checkRateLimit(`general:${clientIp}`, RATE_LIMIT_MAX_GENERAL);
    if (!generalLimit.allowed) {
      return tooManyRequests('Too many requests. Please slow down.', RATE_LIMIT_MAX_GENERAL, 0, generalLimit.resetIn);
    }

    // Body-size cap for signed-out server-action calls.
    if (request.method === 'POST' && request.headers.has('next-action')) {
      const length = Number(request.headers.get('content-length') ?? NaN);
      if (!Number.isFinite(length) || length > MAX_UNAUTHENTICATED_ACTION_BODY) {
        return new NextResponse('Payload too large', { status: 413 });
      }
    }
  }

  // Dev-only auth bypass: route unauthenticated users straight to /dev-login
  // (which signs them in as DEV_AUTH_BYPASS) instead of the sign-in form, so the
  // Preview browser reaches an authenticated page in one hop. Inert in production
  // and when the flag is unset.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_AUTH_BYPASS &&
    !isAuthenticated &&
    !pathname.startsWith('/dev-login') &&
    !pathname.startsWith('/api/auth') &&
    (pathname === '/' || pathname.startsWith('/auth/signin') || pathname.startsWith('/auth/signup'))
  ) {
    return NextResponse.redirect(new URL('/dev-login', request.url));
  }

  // Protect app pages - require a (cryptographically valid) session. Revoked
  // sessions still pass here; the (dashboard) layout's auth() check rejects
  // them and redirects to sign-in, where the stale cookie is cleared below.
  const isProtectedPath =
    pathname === '/' ||
    PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (isProtectedPath && !isAuthenticated) {
    const signInUrl = new URL('/auth/signin', request.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // A session cookie on an auth page is ambiguous: it is either a stale or
  // revoked JWT that the server-side auth() check already rejected (bounced
  // here — clearing it is what breaks the redirect loop), or a perfectly good
  // session belonging to someone who just signed in (the sign-in page calls
  // router.refresh() right after authenticating, which re-requests this page
  // with the fresh cookie; deleting it on sight made every sign-in undo
  // itself). Decide with the same full check auth() runs — signature, expiry,
  // sign-out revocation, account active, session version — because a JWT that
  // merely decrypts can still be revoked, and redirecting that one to '/'
  // would loop (/ → auth() rejects → /auth/signin → /).
  if (pathname.startsWith('/auth/signin') || pathname.startsWith('/auth/signup')) {
    if (hasSessionCookie(request)) {
      if (await hasLiveSession(request)) {
        // Already signed in — into the app, cookie untouched.
        return NextResponse.redirect(new URL('/', request.url));
      }
      const response = NextResponse.next();
      for (const name of SESSION_COOKIE_NAMES) response.cookies.delete(name);
      return response;
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - manifest.webmanifest / sw.js / offline.html / icons (PWA assets — must be
     *   fetchable without an auth redirect; the install screen requests the
     *   manifest without credentials)
     * - public folder files
     */
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icons|themes|.*\\.png$|.*\\.jpg$|.*\\.svg$).*)',
  ],
};
