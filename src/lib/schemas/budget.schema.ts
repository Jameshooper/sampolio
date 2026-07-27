import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Pick a month');

export const budgetDetailsSchema = z
  .object({
    name: z.string().min(1, 'Give your plan a name'),
    destination: z.string().optional().or(z.literal('')),
    description: z.string().optional().or(z.literal('')),
    currency: z.enum(CURRENCY_VALUES),
    startMonth: yearMonth,
    endMonth: yearMonth,
    // '' = no linked split group (cleared on save)
    linkedSplitGroupId: z.string().optional().or(z.literal('')),
  })
  .refine(data => data.endMonth >= data.startMonth, {
    message: "The end can't be before the start",
    path: ['endMonth'],
  });

export type BudgetDetailsFormData = z.infer<typeof budgetDetailsSchema>;

export const budgetLineSchema = z.object({
  name: z.string().min(1, 'Give the cost a name'),
  category: z.string().min(1, 'Pick a category'),
  amount: z.number({ message: 'Enter an amount' }).min(0, 'Amount cannot be negative'),
  kind: z.enum(['one-off', 'monthly']),
  month: yearMonth.optional(),
});

export type BudgetLineFormData = z.infer<typeof budgetLineSchema>;

export const budgetFundingSchema = z
  .object({
    name: z.string().min(1, 'Give it a name'),
    type: z.enum(['grant', 'per-diem', 'other']),
    amount: z.number().min(0).optional(),
    restrictedToCategories: z.array(z.string()).optional(),
    timing: z.enum(['upfront', 'monthly', 'specific-month']),
    receivedMonth: yearMonth.optional(),
    perDiemRate: z.number().min(0).optional(),
    perDiemDays: z.number().int().min(0).optional(),
    linkedTripId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.linkedTripId && data.type !== 'per-diem') {
      ctx.addIssue({ code: 'custom', message: 'Only a daily allowance can be funded by a trip', path: ['linkedTripId'] });
    }
    if (data.type === 'per-diem') {
      // A daily allowance is funded EITHER by a linked trip (amount hydrated
      // from the trip) OR by a manual rate × days — not both required.
      if (!data.linkedTripId) {
        if (!data.perDiemRate) {
          ctx.addIssue({ code: 'custom', message: 'Enter the daily rate', path: ['perDiemRate'] });
        }
        if (!data.perDiemDays) {
          ctx.addIssue({ code: 'custom', message: 'Enter the number of days', path: ['perDiemDays'] });
        }
      }
    } else if (data.amount === undefined || data.amount <= 0) {
      ctx.addIssue({ code: 'custom', message: 'Enter the amount', path: ['amount'] });
    }
    if (data.timing === 'specific-month' && !data.receivedMonth) {
      ctx.addIssue({ code: 'custom', message: 'Pick the month the money arrives', path: ['receivedMonth'] });
    }
  });

export type BudgetFundingFormData = z.infer<typeof budgetFundingSchema>;

export const budgetExpenseEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  description: z.string(),
  amount: z.number({ message: 'Enter an amount' }).positive('Amount must be positive'),
  category: z.string().min(1, 'Pick a category'),
  fundingSourceId: z.string().optional().or(z.literal('')),
  note: z.string().optional().or(z.literal('')),
});

export type BudgetExpenseEntryFormData = z.infer<typeof budgetExpenseEntrySchema>;
