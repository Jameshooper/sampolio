import 'next-auth';
import { DefaultSession } from 'next-auth';
import { UserRole } from './index';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
    } & DefaultSession['user'];
  }

  interface User {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    sessionVersion?: number;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    /** Session id: stable across token refreshes; revoked on sign-out. */
    sid?: string;
    /** User.sessionVersion at sign-in; a mismatch ends the session. */
    sv?: number;
  }
}
