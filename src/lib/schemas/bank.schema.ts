/**
 * Enable Banking — Zod schemas. Two roles:
 *  1. Validate inputs to server actions (start connect, edit a link).
 *  2. Defensively validate the few API responses the flow *depends* on
 *     (auth url, session id) — everything else is parsed tolerantly by the
 *     pure mappers, so odd-but-harmless fields never break a sync.
 */

import { z } from 'zod';

// ---------- Action inputs ----------
export const startBankConnectionSchema = z.object({
  aspspName: z.string().min(1, 'Bank name is required'),
  aspspCountry: z
    .string()
    .regex(/^[A-Z]{2}$/, 'Country must be a 2-letter ISO code')
    .default('FI'),
});
export type StartBankConnectionInput = z.infer<typeof startBankConnectionSchema>;

const dayOfMonth = z.number().int().min(1).max(31);

export const updateBankAccountLinkSchema = z.object({
  accountRole: z.enum(['cash', 'credit-card', 'savings', 'other']).optional(),
  customName: z.string().max(60).nullable().optional(),
  linkedFinancialAccountId: z.string().nullable().optional(),
  isExcluded: z.boolean().optional(),
  statementDay: dayOfMonth.nullable().optional(),
  paymentDueDay: dayOfMonth.nullable().optional(),
  creditLimit: z.number().nonnegative().nullable().optional(),
  manualCreditLimit: z.number().min(0).nullable().optional(), // null clears
  expectedMonthlySpend: z.number().nonnegative().nullable().optional(),
});
export type UpdateBankAccountLinkInput = z.infer<typeof updateBankAccountLinkSchema>;

// ---------- Defensive API response parsers (only the critical bits) ----------
export const authResponseSchema = z.object({
  url: z.string().url(),
  authorization_id: z.string().min(1),
});

export const sessionResponseSchema = z
  .object({
    session_id: z.string().min(1),
    accounts: z.array(z.unknown()).optional(),
    access: z.object({ valid_until: z.string().optional() }).partial().optional(),
  })
  .passthrough();
