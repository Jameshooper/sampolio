import { z } from 'zod';

export const recurringItemSchema = z.object({
  type: z.enum(['income', 'expense']),
  name: z.string().min(1, 'Name is required'),
  amount: z.number().positive('Amount must be positive'),
  category: z.string().optional(),
  frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']),
  customIntervalMonths: z.number().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format'),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional().or(z.literal('')),
  isActive: z.boolean().optional(),
}).refine(
  data => data.frequency !== 'custom' || (data.customIntervalMonths && data.customIntervalMonths >= 1),
  { message: 'Custom interval is required', path: ['customIntervalMonths'] }
);

export type RecurringItemFormData = z.infer<typeof recurringItemSchema>;
