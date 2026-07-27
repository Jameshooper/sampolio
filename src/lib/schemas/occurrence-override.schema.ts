import { z } from 'zod';

export const occurrenceOverrideSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  amount: z.number().min(0, 'Amount must be positive'),
  category: z.string(),
  skipOccurrence: z.boolean(),
});

export type OccurrenceOverrideFormData = z.infer<typeof occurrenceOverrideSchema>;
