import { v4 as uuidv4 } from 'uuid';
import type {
  FinancialAccount,
  RecurringItem,
  PlannedItem,
  TaxedIncome,
  Debt,
  InvestmentAccount,
  InvestmentContribution,
  Receivable,
  ReceivableRepayment,
  DebtReferenceRate,
  DebtExtraPayment,
  SalaryBenefit,
  BalanceSnapshot,
  Currency,
  SharedMortgage,
  MortgageLoan,
  MortgageMember,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageExtraPayment,
  MortgageBalanceSnapshot,
  MortgageActualEntry,
  Budget,
  BudgetLine,
  BudgetFundingSource,
  BudgetExpenseEntry,
} from '@/types';

const now = new Date().toISOString();

export function createMockAccount(overrides?: Partial<FinancialAccount>): FinancialAccount {
  return {
    id: uuidv4(),
    userId: 'test-user',
    name: 'Test Account',
    currency: 'EUR' as Currency,
    startingBalance: 5000,
    startingDate: '2026-01',
    planningHorizonMonths: 12,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockRecurringItem(overrides?: Partial<RecurringItem>): RecurringItem {
  return {
    id: uuidv4(),
    accountId: 'test-account',
    type: 'income',
    name: 'Test Income',
    amount: 3000,
    category: 'Salary',
    frequency: 'monthly',
    startDate: '2026-01',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockPlannedItem(overrides?: Partial<PlannedItem>): PlannedItem {
  return {
    id: uuidv4(),
    accountId: 'test-account',
    type: 'expense',
    kind: 'one-off',
    name: 'Test Planned',
    amount: 500,
    category: 'Shopping',
    scheduledDate: '2026-03',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockTaxedIncome(overrides?: Partial<TaxedIncome>): TaxedIncome {
  return {
    id: uuidv4(),
    accountId: 'test-account',
    name: 'Test Bonus',
    grossAmount: 5000,
    useSalaryTaxSettings: false,
    customTaxRate: 30,
    customContributionsRate: 8,
    netAmount: 3100,
    taxAmount: 1500,
    contributionsAmount: 400,
    kind: 'one-off',
    scheduledDate: '2026-06',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockDebt(overrides?: Partial<Debt>): Debt {
  return {
    id: uuidv4(),
    userId: 'test-user',
    name: 'Test Debt',
    currency: 'EUR' as Currency,
    debtType: 'amortized',
    initialPrincipal: 100000,
    startDate: '2025-01',
    interestModelType: 'fixed',
    fixedInterestRate: 3.5,
    monthlyPayment: 500,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockInvestment(overrides?: Partial<InvestmentAccount>): InvestmentAccount {
  return {
    id: uuidv4(),
    userId: 'test-user',
    name: 'Test Investment',
    currency: 'EUR' as Currency,
    startingValuation: 10000,
    valuationDate: '2026-01',
    annualGrowthRate: 7,
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockContribution(overrides?: Partial<InvestmentContribution>): InvestmentContribution {
  return {
    id: uuidv4(),
    investmentAccountId: 'test-investment',
    type: 'contribution',
    kind: 'recurring',
    amount: 200,
    frequency: 'monthly',
    startDate: '2026-01',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockReceivable(overrides?: Partial<Receivable>): Receivable {
  return {
    id: uuidv4(),
    userId: 'test-user',
    name: 'Test Receivable',
    currency: 'EUR' as Currency,
    initialPrincipal: 5000,
    currentBalance: 5000,
    hasInterest: false,
    startDate: '2026-01',
    isArchived: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockRepayment(overrides?: Partial<ReceivableRepayment>): ReceivableRepayment {
  return {
    id: uuidv4(),
    receivableId: 'test-receivable',
    date: '2026-02',
    amount: 500,
    createdAt: now,
    ...overrides,
  };
}

export function createMockReferenceRate(overrides?: Partial<DebtReferenceRate>): DebtReferenceRate {
  return {
    id: uuidv4(),
    debtId: 'test-debt',
    yearMonth: '2026-01',
    rate: 3.0,
    createdAt: now,
    ...overrides,
  };
}

export function createMockExtraPayment(overrides?: Partial<DebtExtraPayment>): DebtExtraPayment {
  return {
    id: uuidv4(),
    debtId: 'test-debt',
    date: '2026-06',
    amount: 5000,
    createdAt: now,
    ...overrides,
  };
}

export function createMockSnapshot(overrides?: Partial<BalanceSnapshot>): BalanceSnapshot {
  return {
    id: uuidv4(),
    userId: 'test-user',
    entityType: 'cash-account',
    entityId: 'test-account',
    yearMonth: '2026-03',
    expectedBalance: 5000,
    actualBalance: 6000,
    variance: 1000,
    createdAt: now,
    ...overrides,
  };
}

export function createMockSalaryBenefit(overrides?: Partial<SalaryBenefit>): SalaryBenefit {
  return {
    id: uuidv4(),
    name: 'Lunch Benefit',
    amount: 150,
    isTaxable: true,
    ...overrides,
  };
}

// ============================================================
// SHARED MORTGAGE MOCKS
// ============================================================

export function createMockMortgageLoan(overrides?: Partial<MortgageLoan>): MortgageLoan {
  return {
    id: uuidv4(),
    label: 'Regular loan',
    kind: 'regular',
    initialPrincipal: 120000,
    startDate: '2023-02',
    originalTermMonths: 300,
    paymentMode: 'annuity-fixed-term',
    margin: 0.4,
    dayCount: 'actual/360',
    ...overrides,
  };
}

export function createMockMortgageMember(overrides?: Partial<MortgageMember>): MortgageMember {
  return {
    userId: 'test-user',
    email: 'owner@example.com',
    name: 'Alex',
    role: 'owner',
    initialPayment: 18000,
    loanSharePercent: 0.4863636363636364,
    ownershipTargetPercent: 0.5,
    ...overrides,
  };
}

/**
 * A synthetic two-loan household mortgage: €250k home, €30k down (€18k / €12k),
 * an ASP loan (€100k) + a regular loan (€120k), 50/50 ownership target. The
 * loan shares are what `deriveLoanShares` produces for those deposits.
 */
export function createMockSharedMortgage(overrides?: Partial<SharedMortgage>): SharedMortgage {
  return {
    id: 'test-mortgage',
    name: 'Home',
    currency: 'EUR' as Currency,
    housePrice: 250000,
    rateResetMonth: 6,
    rateResetDay: 1,
    loans: [
      createMockMortgageLoan({
        id: 'loan-asp',
        label: 'ASP loan',
        kind: 'asp',
        initialPrincipal: 100000,
      }),
      createMockMortgageLoan({
        id: 'loan-regular',
        label: 'Regular loan',
        kind: 'regular',
        initialPrincipal: 120000,
      }),
    ],
    members: [
      createMockMortgageMember({ userId: 'alex', name: 'Alex', initialPayment: 18000, loanSharePercent: 0.4863636363636364 }),
      createMockMortgageMember({ userId: 'sam', name: 'Sam', email: 'sam@example.com', role: 'member', initialPayment: 12000, loanSharePercent: 0.5136363636363637 }),
    ],
    isArchived: false,
    createdBy: 'alex',
    createdAt: now,
    updatedAt: now,
    updatedBy: 'alex',
    ...overrides,
  };
}

export function createMockMortgageRate(overrides?: Partial<MortgageRateEntry>): MortgageRateEntry {
  return {
    id: uuidv4(),
    mortgageId: 'test-mortgage',
    effectiveDate: '2022-12',
    euriborRate: 2.963, // + 0.4 margin = 3.363% total
    createdAt: now,
    ...overrides,
  };
}

export function createMockMortgageCost(overrides?: Partial<MortgageCostEntry>): MortgageCostEntry {
  return {
    id: uuidv4(),
    mortgageId: 'test-mortgage',
    type: 'invoicing-fee',
    effectiveDate: '2023-02',
    amount: 5.4,
    createdAt: now,
    ...overrides,
  };
}

export function createMockMortgageExtraPayment(
  overrides?: Partial<MortgageExtraPayment>
): MortgageExtraPayment {
  return {
    id: uuidv4(),
    mortgageId: 'test-mortgage',
    loanId: 'loan-regular',
    date: '2026-01',
    amount: 5000,
    mode: 'shorten-term',
    createdAt: now,
    ...overrides,
  };
}

export function createMockMortgageSnapshot(
  overrides?: Partial<MortgageBalanceSnapshot>
): MortgageBalanceSnapshot {
  return {
    id: uuidv4(),
    mortgageId: 'test-mortgage',
    loanId: 'loan-regular',
    yearMonth: '2025-06',
    actualBalance: 145000,
    createdAt: now,
    ...overrides,
  };
}

export function createMockMortgageActual(
  overrides?: Partial<MortgageActualEntry>
): MortgageActualEntry {
  return {
    id: uuidv4(),
    mortgageId: 'test-mortgage',
    loanId: 'loan-asp',
    yearMonth: '2023-02',
    remaining: 100000,
    repayment: 450.0,
    interest: 448.0,
    insurance: 0,
    subsidy: 0,
    createdAt: now,
    ...overrides,
  };
}

export function createMockBudget(overrides?: Partial<Budget>): Budget {
  return {
    id: uuidv4(),
    userId: 'test-user',
    name: 'Research trip abroad',
    destination: 'Stockholm',
    currency: 'SEK' as Currency,
    startMonth: '2026-03',
    endMonth: '2026-04',
    status: 'draft',
    isArchived: false,
    includeRegularIncome: true,
    lines: [],
    fundingSources: [],
    expenseEntries: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createMockBudgetLine(overrides?: Partial<BudgetLine>): BudgetLine {
  return {
    id: uuidv4(),
    name: 'Rent',
    category: 'Accommodation',
    amount: 800,
    kind: 'monthly',
    ...overrides,
  };
}

export function createMockFundingSource(overrides?: Partial<BudgetFundingSource>): BudgetFundingSource {
  return {
    id: uuidv4(),
    name: 'Test grant',
    type: 'grant',
    amount: 2000,
    restrictedToCategories: ['Accommodation', 'Travel'],
    timing: 'upfront',
    ...overrides,
  };
}

export function createMockBudgetExpenseEntry(overrides?: Partial<BudgetExpenseEntry>): BudgetExpenseEntry {
  return {
    id: uuidv4(),
    date: '2026-03-14',
    description: 'Groceries at the market',
    amount: 240,
    category: 'Food',
    createdAt: now,
    ...overrides,
  };
}
