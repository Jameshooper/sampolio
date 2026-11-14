import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { findUserByEmail, verifyPassword, recordFailedLogin, recordSuccessfulLogin, isAccountLocked } from '@/lib/db/users';
import { sessionCookieName, secureCookiesEnabled } from '@/lib/auth-cookies';
import type { UserRole } from '@/types';

const signInSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60 * 30, // 30 days
    updateAge: 60 * 60, // Update session every hour
  },
  cookies: {
    sessionToken: {
      // Keyed on AUTH_URL's scheme, not NODE_ENV — see auth-cookies.ts for
      // why, and for the trade-off this makes over plain HTTP.
      name: sessionCookieName(),
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: secureCookiesEnabled(),
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
        token.role = (user as { role?: UserRole }).role || 'user';
        token.iat = Math.floor(Date.now() / 1000);
      }
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
      async authorize(credentials) {
        // Every branch below logs exactly one reason, always prefixed
        // [auth], so a failed sign-in is diagnosable from the add-on log
        // alone. Never log the password, or anything derived from it.
        let email = '<unparsed>';
        try {
          const parsed = signInSchema.safeParse(credentials);
          if (!parsed.success) {
            // Previously this threw into the catch below and surfaced as a
            // generic "Auth error", which looked identical to a server fault.
            console.warn(
              `[auth] Rejected sign-in: credentials failed validation (${parsed.error.issues
                .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
                .join('; ')})`
            );
            return null;
          }
          email = parsed.data.email;
          const { password } = parsed.data;
          console.log(`[auth] Login attempt for: ${email}`);

          // Check if account is locked due to too many failed attempts
          const locked = await isAccountLocked(email);
          if (locked) {
            console.warn(
              `[auth] Rejected sign-in for ${email}: account is temporarily locked after repeated failed attempts. ` +
                `Wait for the lockout to expire, or clear it with the add-on's reset_admin_password option.`
            );
            return null;
          }

          const user = await findUserByEmail(email);
          if (!user) {
            console.warn(
              `[auth] Rejected sign-in for ${email}: no such user in this data directory. ` +
                `If the account should exist, ENCRYPTION_KEY likely differs from the one it was created with.`
            );
            // Record failed attempt even for non-existent users to prevent enumeration
            await recordFailedLogin(email);
            return null;
          }

          // Check if user is active
          if (!user.isActive) {
            console.warn(`[auth] Rejected sign-in for ${email}: account is deactivated.`);
            return null;
          }

          const isValid = await verifyPassword(user, password);
          if (!isValid) {
            console.warn(
              `[auth] Rejected sign-in for ${email}: password does not match the stored hash. ` +
                `The account exists and decrypted fine, so this is the password itself.`
            );
            await recordFailedLogin(email);
            return null;
          }

          // Record successful login
          await recordSuccessfulLogin(email);
          console.log(`[auth] Sign-in succeeded for: ${email}`);

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          };
        } catch (error) {
          console.error(
            `[auth] Sign-in for ${email} failed with an unexpected error:`,
            error instanceof Error ? error.message : error
          );
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
              return { id: user.id, email: user.email, name: user.name, role: user.role };
            },
          }),
        ]
      : []),
  ],
});
