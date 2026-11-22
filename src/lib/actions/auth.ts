'use server';

import { z } from 'zod';
import { passwordPolicySchema as passwordSchema } from '@/lib/schemas/auth.schema';
import { createUser, findUserByEmail, isFirstUserSetup, FirstUserTakenError } from '@/lib/db/users';
import { isSelfSignupEnabled } from '@/lib/db/app-settings';
import type { ApiResponse } from '@/types';

const signUpSchema = z.object({
  email: z.string().email('Invalid email address').max(320).transform(e => e.toLowerCase().trim()),
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

    // The very first account may always be created (it becomes the admin).
    // createUser re-checks this inside the users-index lock, so a concurrent
    // sign-up can't slip through as a second "first user".
    const isFirstUser = await isFirstUserSetup();

    // Check if self-signup is enabled (unless first user)
    if (!isFirstUser) {
      const selfSignupEnabled = await isSelfSignupEnabled();
      if (!selfSignupEnabled) {
        return {
          success: false,
          error: 'Self-signup is currently disabled. Please contact an administrator.',
        };
      }
    }

    // Check if user already exists
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return { success: false, error: 'An account with this email already exists' };
    }

    // Create the user. When sign-up is closed, only the first-user path is
    // allowed — refuse if someone else completed it in the meantime.
    const user = await createUser(email, password, name, 'user', {
      onlyIfFirstUser: !(await isSelfSignupEnabled()),
    });

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
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    if (error instanceof FirstUserTakenError) {
      return { success: false, error: 'Self-signup is currently disabled. Please contact an administrator.' };
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      return { success: false, error: 'An account with this email already exists' };
    }
    console.error('Sign up error:', error instanceof Error ? error.message : error);
    return { success: false, error: 'Failed to create account' };
  }
}

export async function checkSignupEnabled(): Promise<ApiResponse<{ enabled: boolean; isFirstUser: boolean }>> {
  try {
    const isFirstUser = await isFirstUserSetup();

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
