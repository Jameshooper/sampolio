import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';
import { findUserByEmail, verifyPassword, recordFailedLogin, recordSuccessfulLogin, isAccountLocked } from '@/lib/db/users';
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
      name: process.env.NODE_ENV === 'production' ? '__Secure-authjs.session-token' : 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
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
        try {
          const { email, password } = signInSchema.parse(credentials);
          console.log(`[auth] Login attempt for: ${email}`);
          
          // Check if account is locked due to too many failed attempts
          const locked = await isAccountLocked(email);
          if (locked) {
            console.warn(`[auth] Account locked: ${email}`);
            return null;
          }
          
          const user = await findUserByEmail(email);
          if (!user) {
            console.warn(`[auth] User not found: ${email} (check ENCRYPTION_KEY if user should exist)`);
            // Record failed attempt even for non-existent users to prevent enumeration
            await recordFailedLogin(email);
            return null;
          }
          
          // Check if user is active
          if (!user.isActive) {
            console.warn(`[auth] Inactive user: ${email}`);
            return null;
          }
          
          const isValid = await verifyPassword(user, password);
          if (!isValid) {
            console.warn(`[auth] Invalid password for: ${email}`);
            await recordFailedLogin(email);
            return null;
          }
          
          // Record successful login
          await recordSuccessfulLogin(email);
          
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          };
        } catch (error) {
          console.error('Auth error:', error);
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
