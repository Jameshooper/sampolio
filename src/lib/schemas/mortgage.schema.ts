import { z } from 'zod';
import { CURRENCY_VALUES } from '@/lib/constants';

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Use a month (YYYY-MM)');

export const mortgageLoanSchema = z.object({
  label: z.string().min(1, 'Loan name is required'),
  kind: z.enum(['asp', 'regular']),
  initialPrincipal: z.number().positive('Must be positive'),
  startDate: yearMonth,
  originalTermMonths: z.number().int().positive('Term must be at least 1 month'),
  paymentMode: z.enum(['annuity-fixed-term', 'fixed-payment']),
  margin: z.number().min(0).max(100),
  dayCount: z.enum(['actual/360', '30E/360']),
  currentMonthlyPayment: z.number().positive().optional(),
  insuranceMonthly: z.number().min(0).optional(),
  aspEnabled: z.boolean().optional(),
});

export const mortgageSetupSchema = z
  .object({
    name: z.string().min(1, 'Give your mortgage a name'),
    currency: z.enum(CURRENCY_VALUES),
    housePrice: z.number().positive('House price must be positive'),
    rateResetMonth: z.number().int().min(1).max(12),
    rateResetDay: z.number().int().min(1).max(31),
    creatorInitialPayment: z.number().min(0),
    creatorOwnershipTargetPercent: z.number().min(0).max(1),
    partnerEmail: z.string().email('Enter a valid email').or(z.literal('')).optional(),
    partnerInitialPayment: z.number().min(0).optional(),
    partnerOwnershipTargetPercent: z.number().min(0).max(1).optional(),
    initialEuribor: z.number().min(-5).max(100),
    invoicingFeeMonthly: z.number().min(0).optional(),
    serviceFeeMonthly: z.number().min(0).optional(),
    loans: z.array(mortgageLoanSchema).min(1, 'Add at least one loan'),
  })
  .refine(
    (d) => {
      const sum = d.creatorOwnershipTargetPercent + (d.partnerEmail ? d.partnerOwnershipTargetPercent ?? 0 : 0);
      return Math.abs(sum - 1) < 0.005;
    },
    { message: 'Ownership targets must add up to 100%' }
  );

export type MortgageSetupFormData = z.infer<typeof mortgageSetupSchema>;
export type MortgageLoanFormData = z.infer<typeof mortgageLoanSchema>;

/**
 * A competing bank's transfer/refinancing offer, used by the (ephemeral,
 * client-side) transfer-comparison simulator on the mortgage page. Not persisted.
 */
export const mortgageOfferSchema = z.object({
  margin: z.number().min(0).max(100),
  euriborRate: z.number().min(-5).max(100),
  termMonths: z.number().int().positive('Term must be at least 1 month'),
  paymentMode: z.enum(['annuity-fixed-term', 'fixed-payment']),
  arrangementFee: z.number().min(0),
  deedTransferFee: z.number().min(0),
  otherOneOffCosts: z.number().min(0),
  earlyRepaymentPenalty: z.number().min(0),
  monthlyServiceFee: z.number().min(0),
  monthlyInsurance: z.number().min(0),
  retainAsp: z.boolean(),
});

export type MortgageOfferFormData = z.infer<typeof mortgageOfferSchema>;
