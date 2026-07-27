import { z } from 'zod';

export const tripDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  countryCode: z.string().min(1, 'Country is required'),
  freeMeals: z.number().int().min(0).max(10),
  overrideAmount: z.number().min(0).optional(),
});

export const tripRateSnapshotSchema = z.object({
  domesticFull: z.number().min(0),
  domesticPartial: z.number().min(0),
  defaultForeign: z.number().min(0),
  countryRates: z.record(z.string(), z.number().min(0)),
});

const dateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const tripSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  destinationCountry: z.string().min(1, 'Destination is required'),
  startDateTime: z.string().regex(dateTimeRegex, 'Invalid start date/time'),
  endDateTime: z.string().regex(dateTimeRegex, 'Invalid end date/time'),
  days: z.array(tripDaySchema),
  rates: tripRateSnapshotSchema,
  expectedReimbursementMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid month'),
  linkedAccountId: z.string().min(1, 'Select the account to reimburse'),
  status: z.enum(['planned', 'completed', 'reimbursed']),
  notes: z.string().optional().or(z.literal('')),
}).refine((data) => data.endDateTime > data.startDateTime, {
  message: 'End must be after start',
  path: ['endDateTime'],
});

export const updateTripSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  destinationCountry: z.string().min(1, 'Destination is required').optional(),
  startDateTime: z.string().regex(dateTimeRegex, 'Invalid start date/time').optional(),
  endDateTime: z.string().regex(dateTimeRegex, 'Invalid end date/time').optional(),
  days: z.array(tripDaySchema).optional(),
  rates: tripRateSnapshotSchema.optional(),
  expectedReimbursementMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid month').optional(),
  linkedAccountId: z.string().min(1, 'Select the account to reimburse').optional(),
  status: z.enum(['planned', 'completed', 'reimbursed']).optional(),
  notes: z.string().optional().or(z.literal('')),
}).refine(
  (data) => !(data.startDateTime && data.endDateTime) || data.endDateTime > data.startDateTime,
  { message: 'End must be after start', path: ['endDateTime'] }
);

export type TripFormData = z.infer<typeof tripSchema>;
export type TripDayFormData = z.infer<typeof tripDaySchema>;
