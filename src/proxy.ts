import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { sessionCookieName, secureCookiesEnabled } from '@/lib/auth-cookies';

// This middleware runs on the Edge runtime, so it cannot import Node.js modules
// For auth checks, we rely on the auth token being present
// The actual auth validation happens in the auth library when accessed

// Rate limiting store (in-memory, resets on server restart)
// For production with multiple instances, use Redis
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Rate limit configuration
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_AUTH_UNAUTHENTICATED = 20; // 20 requests per minute for unauthenticated auth endpoints (login/signup)
const RATE_LIMIT_MAX_GENERAL = 300; // 300 requests per minute for general endpoints

function getClientIp(request: NextRequest): string {
  // Check various headers that proxies might set
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback to a generic identifier
  return 'unknown';
}

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
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore.entries()) {
      if (now > record.resetTime) {
        rateLimitStore.delete(key);
      }
    }
  }, 60 * 1000); // Clean up every minute
}

// Check if user has a valid auth session cookie
function hasAuthSession(request: NextRequest): boolean {
  // NextAuth session cookies - check for both secure and non-secure variants
  const sessionCookies = [
    'authjs.session-token',
    '__Secure-authjs.session-token',
    'next-auth.session-token',
    '__Secure-next-auth.session-token',
  ];

  for (const cookieName of sessionCookies) {
    const cookie = request.cookies.get(cookieName);
    if (cookie?.value) {
      return true;
    }
  }

  return false;
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
  const clientIp = getClientIp(request);

  // Apply strict rate limiting to auth endpoints only for unauthenticated users
  // Authenticated users making session polling requests (e.g., /api/auth/session)
  // should not be rate-limited under the strict auth limit — use general limit instead
  if (pathname.startsWith('/api/auth') || pathname.startsWith('/auth/')) {
    const isAuthenticated = hasAuthSession(request);

    if (!isAuthenticated) {
      const rateLimitKey = `auth:${clientIp}`;
      const { allowed, remaining, resetIn } = checkRateLimit(rateLimitKey, RATE_LIMIT_MAX_AUTH_UNAUTHENTICATED);

      if (!allowed) {
        return new NextResponse(
          JSON.stringify({
            success: false,
            error: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil(resetIn / 1000),
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': Math.ceil(resetIn / 1000).toString(),
              'X-RateLimit-Limit': RATE_LIMIT_MAX_AUTH_UNAUTHENTICATED.toString(),
              'X-RateLimit-Remaining': remaining.toString(),
              'X-RateLimit-Reset': Math.ceil(resetIn / 1000).toString(),
            },
          }
        );
      }
    }
    // Authenticated users' auth requests fall through to general rate limiting below
  }

  // General rate limiting applies only to unauthenticated requests.
  // Authenticated users are exempt — this is a self-hosted app where server actions
  // (POST requests to page URLs) can easily generate hundreds of requests per minute
  // during normal page loads with parallel data fetching.
  const isAuthenticated = hasAuthSession(request);

  if (!isAuthenticated) {
    const generalRateLimitKey = `general:${clientIp}`;
    const generalLimit = checkRateLimit(generalRateLimitKey, RATE_LIMIT_MAX_GENERAL);

    if (!generalLimit.allowed) {
      return new NextResponse(
        JSON.stringify({
          success: false,
          error: 'Too many requests. Please slow down.',
          retryAfter: Math.ceil(generalLimit.resetIn / 1000),
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': Math.ceil(generalLimit.resetIn / 1000).toString(),
          },
        }
      );
    }
  }

  // Dev-only auth bypass: route unauthenticated users straight to /dev-login
  // (which signs them in as DEV_AUTH_BYPASS) instead of the sign-in form, so the
  // Preview browser reaches an authenticated page in one hop. Inert in production
  // and when the flag is unset.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.DEV_AUTH_BYPASS &&
    !hasAuthSession(request) &&
    !pathname.startsWith('/dev-login') &&
    !pathname.startsWith('/api/auth') &&
    (pathname === '/' || pathname.startsWith('/auth/signin') || pathname.startsWith('/auth/signup'))
  ) {
    return NextResponse.redirect(new URL('/dev-login', request.url));
  }

  // Protect app pages - require authentication
  // Note: This is a lightweight check based on cookie presence; the actual
  // session validation happens server-side in auth() (the (dashboard) layout
  // and src/app/page.tsx redirect on an invalid session). This edge check just
  // avoids rendering page shells for obviously unauthenticated visitors.
  const isProtectedPath =
    pathname === '/' ||
    PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (isProtectedPath && !hasAuthSession(request)) {
    const signInUrl = new URL('/auth/signin', request.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // A session cookie on an auth page is ambiguous: it is either a stale JWT
  // that the server-side auth() check already rejected (bounced here, and
  // clearing it is what breaks the redirect loop), or a perfectly good
  // session belonging to someone who just signed in.
  //
  // This used to assume the first and delete the cookie on sight, which made
  // every successful sign-in destroy itself: the sign-in page calls
  // router.refresh() straight after authenticating, that re-requests
  // /auth/signin carrying the cookie that was just set, and this cleared it.
  // Login looked like it silently did nothing. So verify the JWT and only
  // clear it when it really is invalid.
  if (pathname.startsWith('/auth/signin') || pathname.startsWith('/auth/signup')) {
    if (hasAuthSession(request)) {
      let sessionIsValid = false;
      try {
        const token = await getToken({
          req: request,
          secret: process.env.AUTH_SECRET,
          cookieName: sessionCookieName(),
          secureCookie: secureCookiesEnabled(),
        });
        sessionIsValid = Boolean(token);
      } catch {
        // Fall through to clearing. Treating an unreadable token as invalid
        // keeps the loop-breaking behaviour this block exists for; the cost
        // is one extra sign-in, versus an unescapable loop the other way.
        sessionIsValid = false;
      }

      if (sessionIsValid) {
        // Already signed in — send them into the app instead of showing a
        // sign-in form, and leave the cookie alone.
        return NextResponse.redirect(new URL('/', request.url));
      }

      const response = NextResponse.next();
      response.cookies.delete('authjs.session-token');
      response.cookies.delete('__Secure-authjs.session-token');
      response.cookies.delete('next-auth.session-token');
      response.cookies.delete('__Secure-next-auth.session-token');
      return response;
    }
  }

  // Add security headers to the response
  const response = NextResponse.next();

  return response;
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
