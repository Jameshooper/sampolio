import { z } from 'zod';

// One flat superset schema with a `recurrence` discriminator. React Hook Form
// keeps a single object in state across recurrence switches, so a strict
// discriminated union would fight the resolver's type inference — instead every
// variant-specific field is optional and `superRefine` enforces the per-variant
// required fields. Server actions re-validate against their own strict schemas.

const ymRegex = /^\d{4}-\d{2}$/;
const ymField = z.string().regex(ymRegex, 'Invalid month').optional().or(z.literal(''));

const salaryBenefitSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount: z.number().min(0),
  isTaxable: z.boolean(),
});

export const cashflowItemSchema = z
  .object({
    recurrence: z.enum(['recurring', 'one-off', 'salary', 'taxed-income']),
    type: z.enum(['income', 'expense']),
    name: z.string().min(1, 'Name is required'),

    // Recurring / one-off amount
    amount: z.number().optional(),
    category: z.string().optional(),

    // Recurring / repeating schedule
    frequency: z.enum(['monthly', 'quarterly', 'yearly', 'custom']).optional(),
    customIntervalMonths: z.number().int().positive().optional(),
    startDate: ymField,
    endDate: ymField,
    isActive: z.boolean().optional(),

    // Expense charged to a credit card
    paidByCardLinkId: z.string().optional(),

    // One-off schedule
    scheduledDate: ymField,

    // Reimbursement (one-off expenses only)
    isReimbursable: z.boolean().optional(),
    expectedReimbursementMonth: ymField,
    reimbursementStatus: z.enum(['pending', 'received']).optional(),

    // Salary
    grossSalary: z.number().optional(),
    taxRate: z.number().min(0).max(100).optional(),
    contributionsRate: z.number().min(0).max(100).optional(),
    otherDeductions: z.number().min(0).optional(),
    benefits: z.array(salaryBenefitSchema).optional(),
    isLinkedToRecurring: z.boolean().optional(),

    // Gross (taxed) income
    grossAmount: z.number().optional(),
    tiKind: z.enum(['one-off', 'recurring']).optional(),
    useSalaryTaxSettings: z.boolean().optional(),
    customTaxRate: z.number().min(0).max(100).optional(),
    customContributionsRate: z.number().min(0).max(100).optional(),
    customOtherDeductions: z.number().min(0).optional(),
    skippedOccurrences: z.array(z.string().regex(ymRegex)).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.recurrence === 'recurring' || data.recurrence === 'one-off') {
      if (data.amount === undefined || data.amount <= 0) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Amount must be positive' });
      }
    }
    if (data.recurrence === 'one-off' && !data.scheduledDate) {
      ctx.addIssue({ code: 'custom', path: ['scheduledDate'], message: 'Select a month' });
    }
    if (
      data.recurrence === 'one-off' &&
      data.type === 'expense' &&
      data.isReimbursable &&
      !data.expectedReimbursementMonth
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedReimbursementMonth'],
        message: 'Select the month you expect the reimbursement',
      });
    }
    if (data.recurrence === 'salary') {
      if (data.grossSalary === undefined || data.grossSalary <= 0) {
        ctx.addIssue({ code: 'custom', path: ['grossSalary'], message: 'Gross salary must be positive' });
      }
    }
    if (data.recurrence === 'taxed-income') {
      if (data.grossAmount === undefined || data.grossAmount <= 0) {
        ctx.addIssue({ code: 'custom', path: ['grossAmount'], message: 'Gross amount must be positive' });
      }
      if (data.tiKind === 'one-off' && !data.scheduledDate) {
        ctx.addIssue({ code: 'custom', path: ['scheduledDate'], message: 'Select a month' });
      }
    }
  });

export type CashflowItemFormData = z.infer<typeof cashflowItemSchema>;
