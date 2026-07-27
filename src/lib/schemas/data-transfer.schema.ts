import { z } from 'zod';
import type {
  FinancialAccount,
  RecurringItem,
  PlannedItem,
  SalaryConfig,
  TaxedIncome,
  InvestmentAccount,
  InvestmentContribution,
  Debt,
  DebtReferenceRate,
  DebtExtraPayment,
  Receivable,
  ReceivableRepayment,
  Goal,
  Budget,
  BalanceSnapshot,
  ReconciliationAdjustment,
  ReconciliationSession,
  UserPreferences,
} from '@/types';

// Envelope for the Settings → Data & Export JSON backup. Per-entity validation
// is deliberately minimal (an id plus whatever else the export wrote):
// loose objects let unknown/new fields survive an export → import round-trip
// across app versions.
const entityRow = z.looseObject({ id: z.string().min(1) });

const accountRow = entityRow.extend({
  recurringItems: z.array(entityRow),
  plannedItems: z.array(entityRow),
  salaryConfigs: z.array(entityRow),
  taxedIncomes: z.array(entityRow),
});

const investmentRow = entityRow.extend({ contributions: z.array(entityRow) });
const debtRow = entityRow.extend({ referenceRates: z.array(entityRow), extraPayments: z.array(entityRow) });
const receivableRow = entityRow.extend({ repayments: z.array(entityRow) });

export const EXPORT_FORMAT = 'sampolio-export';
export const EXPORT_VERSION = 1;

export const dataExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.number().int().positive(),
  exportedAt: z.string(),
  appVersion: z.string().optional(),
  userId: z.string(),
  entities: z.object({
    accounts: z.array(accountRow),
    investments: z.array(investmentRow),
    debts: z.array(debtRow),
    receivables: z.array(receivableRow),
    goals: z.array(entityRow),
    budgets: z.array(entityRow),
    reconciliation: z.object({
      snapshots: z.array(entityRow),
      adjustments: z.array(entityRow),
      sessions: z.array(entityRow),
    }),
    preferences: z.looseObject({}).nullable(),
  }),
  notIncluded: z.array(z.string()),
});

// The concrete payload type, in app types. The Zod schema above validates the
// same shape structurally (with loose objects so unknown fields survive) —
// import code safeParses with the schema, then treats the result as DataExport.
export interface DataExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  appVersion?: string;
  userId: string;
  entities: {
    accounts: Array<FinancialAccount & {
      recurringItems: RecurringItem[];
      plannedItems: PlannedItem[];
      salaryConfigs: SalaryConfig[];
      taxedIncomes: TaxedIncome[];
    }>;
    investments: Array<InvestmentAccount & { contributions: InvestmentContribution[] }>;
    debts: Array<Debt & { referenceRates: DebtReferenceRate[]; extraPayments: DebtExtraPayment[] }>;
    receivables: Array<Receivable & { repayments: ReceivableRepayment[] }>;
    goals: Goal[];
    budgets: Budget[];
    reconciliation: {
      snapshots: BalanceSnapshot[];
      adjustments: ReconciliationAdjustment[];
      sessions: ReconciliationSession[];
    };
    preferences: UserPreferences | null;
  };
  notIncluded: string[];
}

export const importOptionsSchema = z.object({
  mode: z.enum(['merge', 'replace']),
});

export type ImportOptions = z.infer<typeof importOptionsSchema>;
