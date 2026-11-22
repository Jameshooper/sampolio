import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { randomUUID, createHash } from 'crypto';
import {
  findUserByEmail,
  verifyPassword,
  verifyDummyPassword,
  recordFailedLogin,
  recordSuccessfulLogin,
  isAccountLocked,
} from '@/lib/db/users';
import { revokeSession } from '@/lib/db/revoked-sessions';
import { validateSessionClaims } from '@/lib/session-validation';
import { getClientIp } from '@/lib/client-ip';
import type { UserRole } from '@/types';

// Any non-empty password is checked (and counted against the lockout). The
// strength policy applies where passwords are set, not where they are tried.
const signInSchema = z.object({
  email: z.string().email('Invalid email address').max(320),
  password: z.string().min(1).max(1024),
});

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, rolling

/** Short, non-reversible tag for log lines (no raw email addresses in logs). */
export function logTag(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 10);
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  session: {
    strategy: 'jwt',
    maxAge: SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 60, // Update session every hour
  },
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production' ? '__Secure-authjs.session-token' : 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
  },
  logger: {
    // A wrong password is routine; don't print a stack trace per attempt.
    error(error) {
      // Match on Auth.js's stable `type`; class names are minified in builds.
      if ((error as { type?: string }).type === 'CredentialsSignin' || error.name === 'CredentialsSignin') return;
      console.error('[auth][error]', error);
    },
  },
  events: {
    async signOut(message) {
      // Signing out deletes the cookie; also revoke the session id so a copied
      // cookie stops working immediately.
      const token = 'token' in message ? message.token : null;
      const sid = token?.sid;
      if (typeof sid === 'string') {
        await revokeSession(sid, SESSION_MAX_AGE_SECONDS * 1000);
      }
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.role = (user as { role?: UserRole }).role || 'user';
        token.sid = randomUUID();
        token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0;
        token.iat = Math.floor(Date.now() / 1000);
        return token;
      }

      // Every later request re-validates against the stored account, so
      // deactivation, deletion, role changes, password changes and sign-out
      // take effect immediately instead of when the JWT expires. Returning
      // null clears the session cookie.
      const current = await validateSessionClaims(token);
      if (!current) return null;
      token.role = current.role;
      token.name = current.name;
      token.email = current.email;
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        session.user.role = token.role as UserRole;
      }
      return session;
    },
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        try {
          const parsed = signInSchema.safeParse(credentials);
          if (!parsed.success) return null;
          const { email, password } = parsed.data;
          const ip = getClientIp(request.headers);
          const tag = logTag(email);

          if (await isAccountLocked(email, ip)) {
            console.warn(`[auth] Login refused (temporarily locked) user=${tag}`);
            return null;
          }

          const user = await findUserByEmail(email);
          if (!user || !user.isActive) {
            // Same bcrypt cost as a real check, so timing doesn't reveal
            // whether the email has an (active) account.
            await verifyDummyPassword(password);
            await recordFailedLogin(email, ip);
            console.warn(`[auth] Login failed user=${tag}`);
            return null;
          }

          const isValid = await verifyPassword(user, password);
          if (!isValid) {
            await recordFailedLogin(email, ip);
            console.warn(`[auth] Login failed user=${tag}`);
            return null;
          }

          await recordSuccessfulLogin(email, ip);

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            sessionVersion: user.sessionVersion ?? 0,
          };
        } catch (error) {
          console.error('[auth] authorize error:', error instanceof Error ? error.message : 'unknown');
          return null;
        }
      },
    }),
    // Dev-only, password-less bypass for local UI testing / Preview browser.
    // Double-guarded: only outside production AND when DEV_AUTH_BYPASS is set, so
    // this provider is never even registered in a production build.
    ...(process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS
      ? [
          Credentials({
            id: 'dev-bypass',
            name: 'Dev Bypass',
            credentials: {},
            async authorize() {
              const email = process.env.DEV_AUTH_BYPASS!.trim().toLowerCase();
              const user = await findUserByEmail(email);
              if (!user) {
                console.error(`[auth] DEV_AUTH_BYPASS="${email}" but no such user exists locally. Sign that account up first (or check ENCRYPTION_KEY).`);
                return null;
              }
              console.warn(`[auth] ⚠️  DEV AUTH BYPASS active — signing in as ${email} without a password.`);
              return { id: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: user.sessionVersion ?? 0 };
            },
          }),
        ]
      : []),
  ],
});
