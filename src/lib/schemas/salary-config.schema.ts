import { z } from 'zod';

const salaryBenefitSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Benefit name is required'),
  amount: z.number().min(0, 'Amount must be non-negative'),
  isTaxable: z.boolean(),
});

export const salaryConfigSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  grossSalary: z.number().positive('Gross salary must be positive'),
  benefits: z.array(salaryBenefitSchema).optional(),
  taxRate: z.number().min(0).max(100),
  contributionsRate: z.number().min(0).max(100),
  otherDeductions: z.number().min(0).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}$/, 'Invalid date format'),
  endDate: z.string().regex(/^\d{4}-\d{2}$/).optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  isLinkedToRecurring: z.boolean().optional(),
});

export type SalaryConfigFormData = z.infer<typeof salaryConfigSchema>;
