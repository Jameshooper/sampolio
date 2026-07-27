import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';

const currencyEnum = z.enum(CURRENCY_VALUES);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date (YYYY-MM-DD)');
const cents = z.number().int('Amount must be whole cents');

export const splitModeEnum = z.enum(['equal', 'full', 'exact', 'percent', 'shares']);
export const splitIntervalEnum = z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly']);

export const splitSpecSchema = z.object({
  paidByUserId: z.string().min(1, 'Pick who paid'),
  splitMode: splitModeEnum,
  splitConfig: z.record(z.string(), z.number()).optional(),
  participantUserIds: z.array(z.string()).optional(),
});

export const createSplitGroupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  emoji: z.string().max(8).optional(),
  currency: currencyEnum,
  members: z
    .array(z.object({ email: z.string().email(), role: z.enum(['owner', 'member']).optional() }))
    .optional(),
});

export const updateSplitGroupSchema = z.object({
  name: z.string().min(1).optional(),
  emoji: z.string().max(8).optional(),
  isArchived: z.boolean().optional(),
});

export const addSplitMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'member']).optional(),
});

export const splitGroupMemberRoleSchema = z.enum(['owner', 'member']);

// Deliberately NO ownerUserId field — the server stamps it from the session in
// createSplitExpense; never client-trusted (a member could otherwise forge whose
// bank connection an expense claims to come from).
export const splitExpenseBankLinkSchema = z.object({
  txId: z.string().min(1),
  linkedAccountId: z.string().min(1),
  bookingDate: isoDate,
  amount: z.number(),
  currency: currencyEnum,
  counterpartyName: z.string().optional(),
  bankName: z.string().optional(),
});

export const createSplitExpenseSchema = z.object({
  title: z.string().min(1, 'Description is required'),
  category: z.string().min(1),
  amountCents: cents.positive('Amount must be positive'),
  date: isoDate,
  note: z.string().optional(),
  split: splitSpecSchema,
  bankLink: splitExpenseBankLinkSchema.optional(),
});

// The link is never editable via the edit dialog and always preserved
// server-side (prevents a member forging/clearing it) — see updateSplitExpense.
export const updateSplitExpenseSchema = createSplitExpenseSchema.omit({ bankLink: true });

export const quickAddSplitExpenseSchema = z.object({
  title: z.string().min(1, 'Description is required'),
  amountCents: cents.positive('Amount must be positive'),
  category: z.string().optional(),
  date: isoDate.optional(),
});

export const settleUpSchema = z
  .object({
    fromUserId: z.string().min(1),
    toUserId: z.string().min(1),
    amountCents: cents.positive('Amount must be positive'),
    date: isoDate.optional(),
    note: z.string().optional(),
  })
  .refine((d) => d.fromUserId !== d.toUserId, { message: 'Payer and payee must differ' });

export const createSplitRecurrenceRuleSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  amountCents: cents.positive(),
  note: z.string().optional(),
  split: splitSpecSchema,
  interval: splitIntervalEnum,
  anchorDate: isoDate,
  endDate: isoDate.optional(),
  isActive: z.boolean().optional(),
});

// endDate is tri-state on update: absent = unchanged, null = clear, date = set.
export const updateSplitRecurrenceRuleSchema = createSplitRecurrenceRuleSchema
  .partial()
  .extend({ endDate: isoDate.nullable().optional() });

export const markSplitGroupSeenSchema = z.object({ seenAt: z.iso.datetime() });

export const importSplitwiseSchema = z.object({
  groupId: z.string().min(1),
  columnUserIds: z.array(z.string()),
  rows: z
    .array(
      z.object({
        date: isoDate,
        description: z.string(),
        category: z.string(),
        amountCents: cents.min(0),
        currency: z.string(),
        netByColumn: z.array(z.number().int()),
        isPayment: z.boolean(),
      }),
    )
    .min(1, 'No rows to import'),
  replaceAll: z.boolean().optional(),
});

export type CreateSplitGroupFormData = z.infer<typeof createSplitGroupSchema>;
export type CreateSplitExpenseFormData = z.infer<typeof createSplitExpenseSchema>;
export type QuickAddSplitExpenseFormData = z.infer<typeof quickAddSplitExpenseSchema>;
export type SettleUpFormData = z.infer<typeof settleUpSchema>;
export type CreateSplitRecurrenceRuleFormData = z.infer<typeof createSplitRecurrenceRuleSchema>;
