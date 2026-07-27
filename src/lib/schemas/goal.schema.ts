import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';

export const goalSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().or(z.literal('')),
  targetAmount: z.number().positive('Target amount must be positive'),
  currency: z.enum(CURRENCY_VALUES),
  targetDate: z.string().regex(/^\d{4}-\d{2}$/).optional().or(z.literal('')),
  trackingMethod: z.enum(['account-balance', 'net-worth', 'manual']),
  linkedAccountId: z.string().optional().or(z.literal('')),
  currentManualAmount: z.number().min(0).optional(),
  // No `.default()` here — a schema-level default would diverge zod's input
  // vs. output types and break the react-hook-form resolver's type inference.
  // The dialog always sends an explicit value ('reserve' by default; see
  // GoalDialog's `defaultValues`/`reset`).
  goalType: z.enum(['reserve', 'spend']).optional(),
  priority: z.number().int().min(1).max(999).nullable().optional(),
  injectIntoCashflow: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.trackingMethod === 'account-balance' && !data.linkedAccountId) {
    ctx.addIssue({
      code: 'custom',
      path: ['linkedAccountId'],
      message: 'Select the account to track',
    });
  }
  if (data.injectIntoCashflow) {
    if ((data.goalType ?? 'reserve') !== 'spend' || !data.targetDate || data.trackingMethod !== 'account-balance') {
      ctx.addIssue({
        code: 'custom',
        path: ['injectIntoCashflow'],
        message: 'Injecting into cashflow requires a spend goal tracked against an account balance with a target date',
      });
    }
  }
});

export type GoalFormData = z.infer<typeof goalSchema>;
