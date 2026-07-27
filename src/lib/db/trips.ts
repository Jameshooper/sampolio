import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Trip,
  CreateTripRequest,
  UpdateTripRequest,
} from '@/types';
import {
  getUserDir,
  ensureDir,
  readEncryptedFile,
  writeEncryptedFile,
  listFiles,
  deleteFile,
} from './encryption';

// A trip is stored as a single encrypted document (day list + rate snapshot
// embedded) — it is single-user, edited from one page, and small.

function getTripsDir(userId: string): string {
  return path.join(getUserDir(userId), 'trips');
}

function getTripFile(userId: string, tripId: string): string {
  return path.join(getTripsDir(userId), `${tripId}.enc`);
}

// ============================================================
// TRIPS CRUD
// ============================================================

export async function getTrips(userId: string): Promise<Trip[]> {
  const tripsDir = getTripsDir(userId);
  await ensureDir(tripsDir);

  const files = await listFiles(tripsDir);
  const encFiles = files.filter(file => file.endsWith('.enc'));
  const results = await Promise.all(
    encFiles.map(file => readEncryptedFile<Trip>(path.join(tripsDir, file)))
  );
  const trips = results.filter((t): t is Trip => t !== null);

  // Newest trip first.
  return trips.sort((a, b) => b.startDateTime.localeCompare(a.startDateTime));
}

export async function getTripById(userId: string, tripId: string): Promise<Trip | null> {
  return readEncryptedFile<Trip>(getTripFile(userId, tripId));
}

export async function createTrip(userId: string, data: CreateTripRequest): Promise<Trip> {
  const id = uuidv4();
  const now = new Date().toISOString();

  const trip: Trip = {
    id,
    userId,
    name: data.name,
    destinationCountry: data.destinationCountry,
    startDateTime: data.startDateTime,
    endDateTime: data.endDateTime,
    days: data.days,
    rates: data.rates,
    linkedAccountId: data.linkedAccountId,
    expectedReimbursementMonth: data.expectedReimbursementMonth,
    status: data.status ?? 'planned',
    notes: data.notes,
    createdAt: now,
    updatedAt: now,
  };

  const tripsDir = getTripsDir(userId);
  await ensureDir(tripsDir);

  await writeEncryptedFile(getTripFile(userId, id), trip);

  return trip;
}

export async function updateTrip(
  userId: string,
  tripId: string,
  updates: UpdateTripRequest
): Promise<Trip | null> {
  const trip = await getTripById(userId, tripId);
  if (!trip) {
    return null;
  }

  const updatedTrip: Trip = {
    ...trip,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeEncryptedFile(getTripFile(userId, tripId), updatedTrip);

  return updatedTrip;
}

export async function deleteTrip(userId: string, tripId: string): Promise<boolean> {
  await deleteFile(getTripFile(userId, tripId));
  return true;
}
