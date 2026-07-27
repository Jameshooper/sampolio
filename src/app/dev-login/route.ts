import { NextResponse } from 'next/server';
import { signIn } from '@/lib/auth';

/**
 * Dev-only convenience route: signs in as the DEV_AUTH_BYPASS user without a
 * password so the Preview browser lands on an authenticated page in one hop.
 *
 * Double-guarded so it is inert (404) in production or when the flag is unset.
 * `signIn` throws a redirect (carrying the session Set-Cookie) which Next handles,
 * so it must not be wrapped in a try/catch.
 */
export async function GET() {
  if (process.env.NODE_ENV === 'production' || !process.env.DEV_AUTH_BYPASS) {
    return new NextResponse('Not found', { status: 404 });
  }

  await signIn('dev-bypass', { redirectTo: '/' });
}
