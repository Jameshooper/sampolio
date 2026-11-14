'use server';

import { z } from 'zod';
import { createUser, findUserByEmail, getAllUsers } from '@/lib/db/users';
import { isSelfSignupEnabled } from '@/lib/db/app-settings';
import type { ApiResponse } from '@/types';

// Strong password requirements for production security
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^a-zA-Z0-9]/, 'Password must contain at least one special character');

const signUpSchema = z.object({
  email: z.string().email('Invalid email address').transform(e => e.toLowerCase().trim()),
  password: passwordSchema,
  name: z.string().min(2, 'Name must be at least 2 characters').max(100, 'Name is too long'),
});

interface SignUpResponse {
  id: string;
  email: string;
  name: string;
  role: string;
}

export async function signUp(
  data: z.infer<typeof signUpSchema>
): Promise<ApiResponse<SignUpResponse>> {
  try {
    const { email, password, name } = signUpSchema.parse(data);

    // Check if this is the first user (always allow first user signup)
    const allUsers = await getAllUsers();
    const isFirstUser = allUsers.length === 0;

    // Check if self-signup is enabled (unless first user)
    if (!isFirstUser) {
      const selfSignupEnabled = await isSelfSignupEnabled();
      if (!selfSignupEnabled) {
        console.warn('[signup] Rejected: self-signup is disabled and an account already exists.');
        return {
          success: false,
          error: 'Self-signup is currently disabled. Please contact an administrator.',
        };
      }
    }

    // Check if user already exists
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      console.warn(`[signup] Rejected for ${email}: an account with that address already exists.`);
      return { success: false, error: 'An account with this email already exists' };
    }

    // Create the user
    const user = await createUser(email, password, name);
    console.log(
      `[signup] Created ${user.role} account for ${user.email}` +
        (isFirstUser ? ' (first user — granted admin).' : '.')
    );

    return {
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Field names only — the values are the password and the email.
      console.warn(
        `[signup] Rejected: ${error.issues
          .map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)
          .join('; ')}`
      );
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('[signup] Failed with an unexpected error:', error instanceof Error ? error.message : error);
    return {
      success: false,
      error: error instanceof Error ? `Failed to create account: ${error.message}` : 'Failed to create account',
    };
  }
}

export async function checkSignupEnabled(): Promise<ApiResponse<{ enabled: boolean; isFirstUser: boolean }>> {
  try {
    const allUsers = await getAllUsers();
    const isFirstUser = allUsers.length === 0;
    
    if (isFirstUser) {
      return { success: true, data: { enabled: true, isFirstUser: true } };
    }
    
    const selfSignupEnabled = await isSelfSignupEnabled();
    return { success: true, data: { enabled: selfSignupEnabled, isFirstUser: false } };
  } catch (error) {
    console.error('Check signup enabled error:', error);
    return { success: false, error: 'Failed to check signup status' };
  }
}
