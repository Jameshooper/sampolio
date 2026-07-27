'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  findUserById,
  createUser as dbCreateUser,
  updateUser as dbUpdateUser,
  changePassword,
  deleteUser as dbDeleteUser,
  setUserAvatar,
  toPublicUser,
} from '@/lib/db/users';
import { avatarDataUriSchema, avatarDataUriToBuffer } from '@/lib/schemas/user.schema';
import { updateAppSettings as dbUpdateAppSettings } from '@/lib/db/app-settings';
import { cachedGetAllUsers, cachedGetAppSettings } from '@/lib/db/cached';
import { updateTag } from 'next/cache';
import type { ApiResponse, PublicUser, AppSettings } from '@/types';

const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  role: z.enum(['admin', 'user']),
});

const updateUserSchema = z.object({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
  // Present ⇒ set the avatar (data URI) or remove it (null); absent ⇒ untouched.
  avatarDataUri: avatarDataUriSchema.nullable().optional(),
});

const updateSettingsSchema = z.object({
  selfSignupEnabled: z.boolean().optional(),
});

// ==================== USER MANAGEMENT ====================

export async function getUsers(): Promise<ApiResponse<PublicUser[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const users = await cachedGetAllUsers();
    const publicUsers = users.map(toPublicUser);
    return { success: true, data: publicUsers };
  } catch (error) {
    console.error('Get users error:', error);
    return { success: false, error: 'Failed to fetch users' };
  }
}

export async function getUserById(userId: string): Promise<ApiResponse<PublicUser>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const user = await findUserById(userId);
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    return { success: true, data: toPublicUser(user) };
  } catch (error) {
    console.error('Get user error:', error);
    return { success: false, error: 'Failed to fetch user' };
  }
}

export async function createUser(
  data: z.infer<typeof createUserSchema>
): Promise<ApiResponse<PublicUser>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const { email, password, name, role } = createUserSchema.parse(data);
    const user = await dbCreateUser(email, password, name, role);

    updateTag('users');
    return { success: true, data: toPublicUser(user) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    if (error instanceof Error && error.message.includes('already exists')) {
      return { success: false, error: error.message };
    }
    console.error('Create user error:', error);
    return { success: false, error: 'Failed to create user' };
  }
}

export async function updateUser(
  userId: string,
  data: z.infer<typeof updateUserSchema>
): Promise<ApiResponse<PublicUser>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const parsedData = updateUserSchema.parse(data);

    // Prevent admin from demoting themselves
    if (userId === session.user.id && parsedData.role === 'user') {
      return { success: false, error: 'You cannot demote yourself from admin' };
    }

    // Prevent admin from deactivating themselves
    if (userId === session.user.id && parsedData.isActive === false) {
      return { success: false, error: 'You cannot deactivate your own account' };
    }

    // Handle password change separately
    if (parsedData.password) {
      await changePassword(userId, parsedData.password);
    }

    // Handle avatar separately: present (incl. null) ⇒ set/remove; absent ⇒ untouched.
    if ('avatarDataUri' in parsedData) {
      const image = parsedData.avatarDataUri ? avatarDataUriToBuffer(parsedData.avatarDataUri) : null;
      const avatarUser = await setUserAvatar(userId, image);
      if (!avatarUser) {
        return { success: false, error: 'User not found' };
      }
    }

    // Update other fields (exclude password + avatar from the DB user update)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { password: _password, avatarDataUri: _avatarDataUri, ...otherUpdates } = parsedData;
    const user = await dbUpdateUser(userId, otherUpdates);

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    updateTag('users');
    return { success: true, data: toPublicUser(user) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update user error:', error);
    return { success: false, error: 'Failed to update user' };
  }
}

export async function deleteUser(userId: string): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    // Prevent admin from deleting themselves
    if (userId === session.user.id) {
      return { success: false, error: 'You cannot delete your own account' };
    }

    const success = await dbDeleteUser(userId);
    if (!success) {
      return { success: false, error: 'User not found' };
    }

    updateTag('users');
    return { success: true };
  } catch (error) {
    console.error('Delete user error:', error);
    return { success: false, error: 'Failed to delete user' };
  }
}

// ==================== SETTINGS MANAGEMENT ====================

export async function getSettings(): Promise<ApiResponse<AppSettings>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const settings = await cachedGetAppSettings();
    return { success: true, data: settings };
  } catch (error) {
    console.error('Get settings error:', error);
    return { success: false, error: 'Failed to fetch settings' };
  }
}

export async function updateSettings(
  data: z.infer<typeof updateSettingsSchema>
): Promise<ApiResponse<AppSettings>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    const parsedData = updateSettingsSchema.parse(data);
    const settings = await dbUpdateAppSettings(parsedData, session.user.id);

    updateTag('app-settings');
    return { success: true, data: settings };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update settings error:', error);
    return { success: false, error: 'Failed to update settings' };
  }
}

// ==================== CACHE MANAGEMENT ====================

export async function revalidateAllCaches(): Promise<ApiResponse<null>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const currentUser = await findUserById(session.user.id);
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Admin access required' };
    }

    updateTag('all-data');
    return { success: true };
  } catch (error) {
    console.error('Revalidate all caches error:', error);
    return { success: false, error: 'Failed to revalidate caches' };
  }
}
