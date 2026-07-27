'use server';

import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  createTrip as dbCreateTrip,
  updateTrip as dbUpdateTrip,
  deleteTrip as dbDeleteTrip,
} from '@/lib/db/trips';
import {
  cachedGetTrips,
  cachedGetTripById,
} from '@/lib/db/cached';
import { tripSchema, updateTripSchema } from '@/lib/schemas/trip.schema';
import { updateTag } from 'next/cache';
import type { ApiResponse, Trip } from '@/types';

// ============================================================
// TRIPS ACTIONS
// ============================================================

export async function getTrips(): Promise<ApiResponse<Trip[]>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const trips = await cachedGetTrips(session.user.id);
    return { success: true, data: trips };
  } catch (error) {
    console.error('Get trips error:', error);
    return { success: false, error: 'Failed to fetch trips' };
  }
}

export async function getTripById(tripId: string): Promise<ApiResponse<Trip>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const trip = await cachedGetTripById(session.user.id, tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    return { success: true, data: trip };
  } catch (error) {
    console.error('Get trip error:', error);
    return { success: false, error: 'Failed to fetch trip' };
  }
}

export async function createTrip(
  data: z.infer<typeof tripSchema>
): Promise<ApiResponse<Trip>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = tripSchema.parse(data);
    const trip = await dbCreateTrip(session.user.id, validated);

    updateTag(`user:${session.user.id}:trips`);
    return { success: true, data: trip };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Create trip error:', error);
    return { success: false, error: 'Failed to create trip' };
  }
}

export async function updateTrip(
  tripId: string,
  data: z.infer<typeof updateTripSchema>
): Promise<ApiResponse<Trip>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    const validated = updateTripSchema.parse(data);
    const trip = await dbUpdateTrip(session.user.id, tripId, validated);

    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    updateTag(`user:${session.user.id}:trips`);
    return { success: true, data: trip };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0]?.message ?? 'Validation error' };
    }
    console.error('Update trip error:', error);
    return { success: false, error: 'Failed to update trip' };
  }
}

export async function deleteTrip(tripId: string): Promise<ApiResponse<void>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    await dbDeleteTrip(session.user.id, tripId);
    updateTag(`user:${session.user.id}:trips`);
    return { success: true };
  } catch (error) {
    console.error('Delete trip error:', error);
    return { success: false, error: 'Failed to delete trip' };
  }
}
