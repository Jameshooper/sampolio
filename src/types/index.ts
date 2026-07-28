// Core type definitions for Sampolio - Personal Finance Planning Tool

import type React from 'react';

export type Currency = 'EUR' | 'USD' | 'BRL' | 'GBP' | 'JPY' | 'CHF' | 'CAD' | 'AUD' | 'SEK' | 'NOK' | 'DKK';

export type Frequency = 'monthly' | 'quarterly' | 'yearly' | 'custom';

export type ItemType = 'income' | 'expense';

export type ItemKind = 'recurring' | 'one-off' | 'repeating';

// Year-month format: "YYYY-MM"
export type YearMonth = string;

// User roles
export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  isActive: boolean;
  // Avatar image lives as a plain (unencrypted) binary file at
  // data/users/{id}/avatar.webp, served by /api/avatars/[userId]. This version
  // counter busts the browser HTTP cache (?v=) and is bumped on every change;
  // undefined ⇒ no avatar. Never carried in the JWT.
  avatarVersion?: number;
  createdAt: string;
  updatedAt: string;
}

/** Minimal cross-user identity payload for collaborative UIs (avatars + names).
 * Returned by getUserProfiles to any authenticated user — deliberately excludes
 * email/role (names are already denormalized to co-members via group/mortgage
 * membership, so this exposes nothing new). */
export interface UserProfile {
  id: string;
  name: string;
  /** /api/avatars/{id}?v={avatarVersion}; undefined ⇒ render initials fallback. */
  avatarUrl?: string;
}

// Account self-service: what blocks permanent deletion, plus a summary of the
// blast radius when there are no blockers (src/lib/actions/account.ts).
export interface AccountDeletionBlocker {
  message: string;
}

export interface AccountDeletionSummary {
  accounts: number;
  goals: number;
  budgets: number;
  trips: number;
  bankConnections: number;
  splitGroupsToLeave: number;
  splitGroupsToDelete: number;
  mortgagesToLeave: number;
  mortgagesToDelete: number;
}

export interface AccountDeletionPreflight {
  blockers: AccountDeletionBlocker[];
  summary: AccountDeletionSummary;
}

// Application settings (stored in app-settings.enc)
export interface AppSettings {
  selfSignupEnabled: boolean;
  updatedAt: string;
  updatedBy: string; // userId of admin who last updated
}

// User preferences (stored per user in preferences.enc)
export interface TaxDefaults {
  taxRate: number; // percentage, e.g. 25 for 25%
  contributionsRate: number; // percentage, e.g. 8.19
  otherDeductions: number; // fixed amount
}

export type DisplayMode = 'simple' | 'advanced';

export interface UserPreferences {
  hasCompletedOnboarding: boolean;
  displayMode?: DisplayMode; // default 'advanced'
  defaultShareRatio?: number; // 0-1, default 0.5
  customCategories?: string[]; // user-defined categories (merged with built-in ones)
  removedDefaultCategories?: string[]; // built-in categories the user has removed
  taxDefaults?: TaxDefaults;
  defaultSplitGroupId?: string; // pre-selected group for the fast "add shared expense" flow
  // Show the "time to check in" reminder banner on Overview. Default true
  // (undefined ⇒ enabled); bank-synced users may prefer it off.
  checkInRemindersEnabled?: boolean;
  // Also fire a local PWA notification on this device when the monthly
  // check-in is due. Opt-in (undefined ⇒ disabled); requires the browser's
  // Notification permission and only applies while reminders are enabled.
  checkInNotificationsEnabled?: boolean;
  // User-curated display order of connected bank accounts (BankAccountLink ids)
  // on the Bank page. Ids not present keep insertion order after the ordered
  // ones; stale ids are ignored. Undefined ⇒ default (connection) order.
  bankAccountOrder?: string[];
  // User-curated display order of split groups (SplitGroup ids) on /split.
  // Same semantics as bankAccountOrder: missing ids keep the default
  // (createdAt-desc) order after the ordered ones; stale ids are ignored.
  splitGroupOrder?: string[];
  /** Split "new since last visit": groupId → ISO createdAt watermark; moved forward only. */
  splitLastSeenAt?: Record<string, string>;
  updatedAt: string;
}

export interface FinancialAccount {
  id: string;
  userId: string;
  name: string;
  currency: Currency;
  startingBalance: number;
  startingDate: YearMonth; // e.g., "2026-01"
  planningHorizonMonths: number; // e.g., 12, 36, 120 for 1, 3, 10 years
  customEndDate?: YearMonth; // optional specific end date
  isArchived: boolean;
  // Enable Banking (PSD2 AIS): when true, this account is auto-anchored from a
  // linked bank account's balance. Additive/optional — undefined ⇒ manual only.
  bankSyncEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringItem {
  id: string;
  accountId: string;
  type: ItemType;
  name: string;
  amount: number;
  category?: string;
  frequency: Frequency;
  customIntervalMonths?: number; // used when frequency is 'custom'
  startDate: YearMonth;
  endDate?: YearMonth;
  isShared?: boolean;
  shareRatio?: number; // 0-1, default 0.5
  // When set, this expense is charged to a credit card (BankAccountLink.id) — it
  // no longer hits cash directly; it rolls into that card's statement/forecast.
  paidByCardLinkId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlannedItem {
  id: string;
  accountId: string;
  type: ItemType;
  kind: 'one-off' | 'repeating';
  name: string;
  amount: number;
  category?: string;
  // For one-off items
  scheduledDate?: YearMonth;
  // For repeating items
  frequency?: Frequency;
  customIntervalMonths?: number;
  firstOccurrence?: YearMonth;
  endDate?: YearMonth;
  // Shared expense
  isShared?: boolean;
  shareRatio?: number; // 0-1, default 0.5
  // Charged to a credit card (BankAccountLink.id) — see RecurringItem.paidByCardLinkId.
  paidByCardLinkId?: string;
  // Reimbursement tracking (one-off items only)
  isReimbursable?: boolean;
  reimbursementStatus?: 'pending' | 'received';
  expectedReimbursementMonth?: YearMonth;
  // For recurring item occurrence overrides
  linkedRecurringItemId?: string; // the recurring item this overrides
  isRecurringOverride?: boolean;  // true if this is an occurrence override
  skipOccurrence?: boolean;       // true to skip the occurrence (no income/expense)
  createdAt: string;
  updatedAt: string;
}

export interface SalaryBenefit {
  id: string;
  name: string;
  amount: number; // monthly amount
  isTaxable: boolean; // whether it's added to gross before tax calculation
}

export interface SalaryConfig {
  id: string;
  accountId: string;
  name: string;
  grossSalary: number;
  benefits: SalaryBenefit[];
  taxRate: number; // percentage, e.g., 25 for 25%
  contributionsRate: number; // percentage for retirement, insurance, etc.
  otherDeductions: number; // fixed amount
  netSalary: number; // computed
  isLinkedToRecurring: boolean;
  linkedRecurringItemId?: string;
  startDate: YearMonth;
  endDate?: YearMonth;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Projection types
export interface MonthlyProjection {
  yearMonth: YearMonth;
  year: number;
  month: number;
  startingBalance: number;
  totalIncome: number;
  totalExpenses: number;
  netChange: number; // totalIncome - totalExpenses
  endingBalance: number;
  incomeBreakdown: ProjectionLineItem[];
  expenseBreakdown: ProjectionLineItem[];
  // True for retrospective months reconstructed from real booked bank
  // transactions (no Sampolio forecast items). Forecast months leave it unset.
  isActual?: boolean;
  /** True when this month's totals/netChange were computed from remaining (post bank-tx matching) amounts. Set only on the current (anchor) month of a bank-linked account. */
  isActualized?: boolean;
  /** When isActualized: the month's planned totals (Σ line.amount), for "€X of €Y planned" UI. totalIncome/totalExpenses hold the REMAINING totals. */
  plannedTotalIncome?: number;
  plannedTotalExpenses?: number;
}

export interface ProjectionLineItem {
  itemId: string;
  name: string;
  amount: number;
  category?: string;
  source: 'recurring' | 'planned-one-off' | 'planned-repeating' | 'salary' | 'taxed-income' | 'mortgage-payment' | 'budget' | 'credit-card' | 'bank-actual' | 'goal' | 'trip';
  isOverridden?: boolean; // true when a recurring item has an occurrence override for this month
  /** Current (anchor) month only, bank-linked accounts: the part of this line still expected to hit the balance. Absent ⇒ equals `amount`. */
  remainingAmount?: number;
  /** Current month only: exact-matched to a booked bank transaction — already inside the live anchor balance. Implies remainingAmount === 0. */
  isPaid?: boolean;
  /** The booked bank transaction id that paid this line. */
  matchedTxId?: string;
}

export interface YearlyRollup {
  year: number;
  totalIncome: number;
  totalExpenses: number;
  netChange: number;
  startingBalance: number;
  endingBalance: number;
  months: MonthlyProjection[];
}

export interface ProjectionFilters {
  startDate?: YearMonth;
  endDate?: YearMonth;
  categories?: string[];
  itemTypes?: ItemType[];
  itemKinds?: ItemKind[];
}

// API request/response types
export interface CreateAccountRequest {
  name: string;
  currency: Currency;
  startingBalance: number;
  startingDate: YearMonth;
  planningHorizonMonths: number;
  customEndDate?: YearMonth;
}

export interface UpdateAccountRequest extends Partial<CreateAccountRequest> {
  isArchived?: boolean;
}

export interface CreateRecurringItemRequest {
  accountId: string;
  type: ItemType;
  name: string;
  amount: number;
  category?: string;
  frequency: Frequency;
  customIntervalMonths?: number;
  startDate: YearMonth;
  endDate?: YearMonth;
  isShared?: boolean;
  shareRatio?: number;
  paidByCardLinkId?: string;
  isActive?: boolean;
}

export type UpdateRecurringItemRequest = Partial<CreateRecurringItemRequest>;

export interface CreatePlannedItemRequest {
  accountId: string;
  type: ItemType;
  kind: 'one-off' | 'repeating';
  name: string;
  amount: number;
  category?: string;
  scheduledDate?: YearMonth;
  frequency?: Frequency;
  customIntervalMonths?: number;
  firstOccurrence?: YearMonth;
  endDate?: YearMonth;
  isShared?: boolean;
  shareRatio?: number;
  paidByCardLinkId?: string;
  isReimbursable?: boolean;
  expectedReimbursementMonth?: YearMonth;
  // For recurring item occurrence overrides
  linkedRecurringItemId?: string;
  isRecurringOverride?: boolean;
  skipOccurrence?: boolean;
}

export type UpdatePlannedItemRequest = Partial<CreatePlannedItemRequest> & {
  // Not on create (createPlannedItem defaults it to 'pending' when isReimbursable);
  // updatable so a reimbursement can be marked received.
  reimbursementStatus?: 'pending' | 'received';
};

export interface CreateSalaryConfigRequest {
  accountId: string;
  name: string;
  grossSalary: number;
  benefits?: SalaryBenefit[];
  taxRate: number;
  contributionsRate: number;
  otherDeductions?: number;
  startDate: YearMonth;
  endDate?: YearMonth;
  isActive?: boolean;
  isLinkedToRecurring?: boolean;
}

export type UpdateSalaryConfigRequest = Partial<CreateSalaryConfigRequest>;

// Auth types
export interface SignUpRequest {
  email: string;
  password: string;
  name: string;
}

export interface SignInRequest {
  email: string;
  password: string;
}

// Admin types
export interface CreateUserRequest {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  name?: string;
  email?: string;
  password?: string;
  role?: UserRole;
  isActive?: boolean;
}

export interface UpdateAppSettingsRequest {
  selfSignupEnabled?: boolean;
}

// Public user info (without password hash)
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  /** Computed from avatarVersion by toPublicUser; undefined ⇒ no avatar. */
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

// Utility types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================================
// WEALTH MANAGEMENT TYPES
// ============================================================

// Interest model types for debts
export type InterestModelType = 'none' | 'fixed' | 'variable';

export type DebtType = 'amortized' | 'fixed-installment';

// ============================================================
// RECEIVABLES (Loans to others, e.g., "Wife owes me")
// ============================================================

export interface Receivable {
  id: string;
  userId: string;
  name: string;
  description?: string;
  currency: Currency;
  initialPrincipal: number;
  currentBalance: number; // Calculated: initialPrincipal - sum(repayments)
  note?: string;
  // Optional interest model
  hasInterest: boolean;
  annualInterestRate?: number; // percentage, e.g., 5 for 5%
  // Optional soft forecast for projection
  expectedMonthlyRepayment?: number; // For projection purposes only
  startDate: YearMonth;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ReceivableRepayment {
  id: string;
  receivableId: string;
  date: YearMonth;
  amount: number;
  description?: string;
  note?: string;
  // Optional: link repayment to a cash account (money comes in)
  linkedAccountId?: string;
  createdAt: string;
}

export interface CreateReceivableRequest {
  name: string;
  description?: string;
  currency: Currency;
  initialPrincipal: number;
  note?: string;
  hasInterest?: boolean;
  annualInterestRate?: number;
  expectedMonthlyRepayment?: number;
  startDate: YearMonth;
}

export interface UpdateReceivableRequest extends Partial<CreateReceivableRequest> {
  isArchived?: boolean;
  currentBalance?: number;
}

export interface CreateRepaymentRequest {
  date: YearMonth;
  amount: number;
  note?: string;
  linkedAccountId?: string;
}

// ============================================================
// INVESTMENT ACCOUNTS
// ============================================================

export interface InvestmentAccount {
  id: string;
  userId: string;
  name: string;
  description?: string;
  currency: Currency;
  startingValuation: number;
  currentValuation?: number; // Current calculated valuation
  valuationDate: YearMonth; // As-of date for the starting valuation
  // Growth model
  annualGrowthRate: number; // percentage, e.g., 7 for 7% annual return
  // Derived monthly rate = (1 + annualRate/100)^(1/12) - 1
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvestmentContribution {
  id: string;
  investmentAccountId: string;
  type: 'contribution' | 'withdrawal';
  kind: 'one-off' | 'recurring';
  amount: number;
  description?: string;
  // For one-off
  scheduledDate?: YearMonth;
  // For recurring
  frequency?: Frequency;
  customIntervalMonths?: number;
  startDate?: YearMonth;
  endDate?: YearMonth;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvestmentAccountRequest {
  name: string;
  description?: string;
  currency: Currency;
  startingValuation: number;
  valuationDate: YearMonth;
  annualGrowthRate: number;
}

export interface UpdateInvestmentAccountRequest extends Partial<CreateInvestmentAccountRequest> {
  isArchived?: boolean;
  currentValuation?: number;
}

export interface CreateInvestmentContributionRequest {
  type: 'contribution' | 'withdrawal';
  kind: 'one-off' | 'recurring';
  amount: number;
  description?: string;
  scheduledDate?: YearMonth;
  frequency?: Frequency;
  customIntervalMonths?: number;
  startDate?: YearMonth;
  endDate?: YearMonth;
  isActive?: boolean;
}

export type UpdateInvestmentContributionRequest = Partial<CreateInvestmentContributionRequest>;

// ============================================================
// DEBTS / LIABILITIES
// ============================================================

export interface Debt {
  id: string;
  userId: string;
  name: string;
  description?: string;
  currency: Currency;
  debtType: DebtType;
  initialPrincipal: number;
  startDate: YearMonth;

  // For amortized loans (mortgage-like)
  interestModelType: InterestModelType;
  fixedInterestRate?: number; // Annual rate for fixed interest
  referenceRateMargin?: number; // Margin above reference rate (e.g., 1.5%)
  rateResetFrequency?: 'monthly' | 'quarterly' | 'yearly'; // How often rate resets
  monthlyPayment?: number; // Fixed monthly payment amount

  // For fixed-installment (no interest, like renovations financing)
  installmentAmount?: number;
  totalInstallments?: number;
  remainingInstallments?: number;

  // Link to cash account that pays this debt
  linkedAccountId?: string;

  isArchived: boolean;
  endDate?: YearMonth; // When debt will be fully paid
  createdAt: string;
  updatedAt: string;
}

export interface DebtReferenceRate {
  id: string;
  debtId: string;
  yearMonth: YearMonth;
  rate: number; // The reference rate for this period (e.g., Euribor)
  createdAt: string;
}

export interface DebtExtraPayment {
  id: string;
  debtId: string;
  date: YearMonth;
  amount: number;
  description?: string;
  note?: string;
  createdAt: string;
}

export interface CreateDebtRequest {
  name: string;
  description?: string;
  currency: Currency;
  debtType: DebtType;
  initialPrincipal: number;
  startDate: YearMonth;
  // For amortized
  interestModelType?: InterestModelType;
  fixedInterestRate?: number;
  referenceRateMargin?: number;
  rateResetFrequency?: 'monthly' | 'quarterly' | 'yearly';
  monthlyPayment?: number;
  // For fixed-installment
  installmentAmount?: number;
  totalInstallments?: number;
  // Link to cash account
  linkedAccountId?: string;
}

export interface UpdateDebtRequest extends Partial<CreateDebtRequest> {
  isArchived?: boolean;
  remainingInstallments?: number;
}

// ============================================================
// SHARED MORTGAGE
// A dedicated, multi-user-shared home loan. Unlike Debt (single owner,
// naïve monthly interest), this models a Finnish-style mortgage: one or
// more sub-loans (e.g. an interest-subsidized ASP loan + a regular loan),
// a yearly Euribor reset, actual/360 interest, time-effective fees, and a
// 50/50 ownership-balancing story between the members.
// Storage is shared (data/shared/mortgages); access is controlled by the
// `members` list, not a single `userId`.
// ============================================================

export type MortgageLoanKind = 'asp' | 'regular';
/** annuity-fixed-term: recompute the level payment at each rate reset to keep maturity fixed (Finnish tasaerä). */
export type MortgagePaymentMode = 'annuity-fixed-term' | 'fixed-payment';
export type MortgageDayCount = 'actual/360' | '30E/360';
export type MortgageMemberRole = 'owner' | 'member';
export type MortgageExtraPaymentMode = 'shorten-term' | 'lower-payment';
/** loan-insurance is per-loan (needs loanId); invoicing-fee and service-fee are mortgage-level. */
export type MortgageCostType = 'loan-insurance' | 'invoicing-fee' | 'service-fee';

/** Government ASP interest-subsidy parameters (Finnish first-home scheme). */
export interface MortgageAspSubsidyConfig {
  enabled: boolean;
  thresholdRate: number; // annual % above which the subsidy applies, e.g. 3.8
  subsidyShare: number; // fraction of the excess interest the state pays, e.g. 0.7
  eligibilityYears: number; // window from the loan start, e.g. 10
}

/** One sub-loan inside a shared mortgage (e.g. ASP vs regular). */
export interface MortgageLoan {
  id: string;
  label: string; // "ASP loan", "Regular loan"
  kind: MortgageLoanKind;
  initialPrincipal: number; // genesis principal, e.g. 100000 / 120000
  startDate: YearMonth; // first amortization month
  originalTermMonths: number; // used to recompute the annuity at each reset
  paymentMode: MortgagePaymentMode;
  margin: number; // pp added on top of Euribor, e.g. 0.4
  dayCount: MortgageDayCount;
  paymentDayOfMonth?: number; // day the bank debits (e.g. 14); drives exact actual/360 spans
  currentMonthlyPayment?: number; // last known principal+interest payment; seeds/overrides month 1
  aspSubsidy?: MortgageAspSubsidyConfig; // meaningful only when kind === 'asp'
}

/** A member of the shared mortgage and their ownership-balancing config. */
export interface MortgageMember {
  userId: string;
  email: string; // denormalized for display; resolved when added
  name: string; // denormalized for display
  role: MortgageMemberRole;
  initialPayment: number; // down payment this member contributed, e.g. 18000 / 12000
  loanSharePercent: number; // 0..1 share of the ongoing loan, e.g. 0.454 / 0.546
  ownershipTargetPercent: number; // 0..1 target share of the home; members' targets sum to 1
  linkedAccountId?: string; // this member's cash account the monthly transfer is paid from (drives cashflow)
}

/** Annual Euribor reset entry. Applies to the whole mortgage (every loan adds its own margin). */
export interface MortgageRateEntry {
  id: string;
  mortgageId: string;
  effectiveDate: YearMonth; // when this rate takes effect
  euriborRate: number; // Euribor 12m, EXCLUDING margin
  note?: string;
  createdAt: string;
}

/** Time-effective fee/insurance value, so a later change keeps the full history. */
export interface MortgageCostEntry {
  id: string;
  mortgageId: string;
  type: MortgageCostType;
  loanId?: string; // required for 'loan-insurance'
  effectiveDate: YearMonth;
  amount: number; // monthly amount (positive)
  note?: string;
  createdAt: string;
}

/** Manual early / extra payment against a specific sub-loan. */
export interface MortgageExtraPayment {
  id: string;
  mortgageId: string;
  loanId: string;
  date: YearMonth;
  amount: number;
  mode: MortgageExtraPaymentMode; // shorten-term (finish earlier) or lower-payment (smaller installments)
  note?: string;
  createdAt: string;
}

/** Drift re-anchor: an observed actual balance for one loan at a month. */
export interface MortgageBalanceSnapshot {
  id: string;
  mortgageId: string;
  loanId: string;
  yearMonth: YearMonth;
  actualBalance: number; // POSITIVE remaining principal
  note?: string;
  createdAt: string;
}

/**
 * A recorded ACTUAL monthly figure for one loan, imported from the bank's
 * statements (or the user's spreadsheet). When present for a loan-month, the
 * engine uses these verbatim instead of computing them — making the historical
 * ledger an exact match. Projection resumes from the latest actual balance.
 * All amounts are POSITIVE magnitudes.
 */
export interface MortgageActualEntry {
  id: string;
  mortgageId: string;
  loanId: string;
  yearMonth: YearMonth;
  remaining: number; // remaining balance at end of the month
  repayment: number; // the bank's total charge for the loan this month (incl insurance + invoicing share)
  interest: number; // interest paid this month (after any subsidy)
  insurance: number; // insurance paid this month
  subsidy: number; // government interest subsidy this month (e.g. ASP)
  createdAt: string;
}

export interface SharedMortgage {
  id: string;
  name: string;
  currency: Currency;
  housePrice: number;
  rateResetMonth: number; // 1-12, e.g. 12 (December)
  rateResetDay: number; // 1-31, e.g. 14
  loans: MortgageLoan[];
  members: MortgageMember[];
  isArchived: boolean;
  createdBy: string; // userId of creator (becomes an 'owner')
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

// ---------- Request types ----------
export interface CreateMortgageLoanInput {
  label: string;
  kind: MortgageLoanKind;
  initialPrincipal: number;
  startDate: YearMonth;
  originalTermMonths: number;
  paymentMode?: MortgagePaymentMode;
  margin: number;
  dayCount?: MortgageDayCount;
  paymentDayOfMonth?: number;
  currentMonthlyPayment?: number;
  aspSubsidy?: MortgageAspSubsidyConfig;
}

export interface CreateMortgageMemberInput {
  email: string;
  role?: MortgageMemberRole;
  initialPayment: number;
  loanSharePercent: number;
  ownershipTargetPercent: number;
}

export interface CreateMortgageRateInput {
  effectiveDate: YearMonth;
  euriborRate: number;
  note?: string;
}

export interface CreateMortgageCostInput {
  type: MortgageCostType;
  loanId?: string;
  effectiveDate: YearMonth;
  amount: number;
  note?: string;
}

export interface CreateMortgageRequest {
  name: string;
  currency: Currency;
  housePrice: number;
  rateResetMonth?: number;
  rateResetDay?: number;
  loans: CreateMortgageLoanInput[];
  creatorInitialPayment: number;
  creatorLoanSharePercent: number;
  creatorOwnershipTargetPercent: number;
  members?: CreateMortgageMemberInput[];
  // genesis schedules (optional) so the back-history amortizes correctly
  rates?: CreateMortgageRateInput[];
  costs?: CreateMortgageCostInput[];
}

export interface UpdateMortgageRequest {
  name?: string;
  housePrice?: number;
  rateResetMonth?: number;
  rateResetDay?: number;
  isArchived?: boolean;
}

export type UpdateMortgageLoanRequest = Partial<CreateMortgageLoanInput>;

export interface AddMortgageMemberRequest {
  email: string;
  initialPayment: number;
  loanSharePercent: number;
  ownershipTargetPercent: number;
  role?: MortgageMemberRole;
}

export interface UpdateMortgageMemberRequest {
  role?: MortgageMemberRole;
  initialPayment?: number;
  loanSharePercent?: number;
  ownershipTargetPercent?: number;
  linkedAccountId?: string; // omit/undefined clears the link
}

export interface SetMortgageRateRequest {
  effectiveDate: YearMonth;
  euriborRate: number;
  note?: string;
}

export interface SetMortgageCostRequest {
  type: MortgageCostType;
  loanId?: string;
  effectiveDate: YearMonth;
  amount: number;
  note?: string;
}

export interface CreateMortgageExtraPaymentRequest {
  loanId: string;
  date: YearMonth;
  amount: number;
  mode: MortgageExtraPaymentMode;
  note?: string;
}

export interface CreateMortgageBalanceSnapshotRequest {
  loanId: string;
  yearMonth: YearMonth;
  actualBalance: number;
  note?: string;
}

export interface MortgageActualInput {
  loanId: string;
  yearMonth: YearMonth;
  remaining: number;
  repayment: number;
  interest: number;
  insurance: number;
  subsidy?: number;
}

export interface ImportMortgageActualsRequest {
  entries: MortgageActualInput[];
  /** When true, replace all existing actuals; otherwise upsert by loan+month. */
  replaceAll?: boolean;
}

// ---------- Projection output types ----------
export interface MortgageLoanProjectionMonth {
  loanId: string;
  startingPrincipal: number;
  effectiveAnnualRate: number; // Euribor + margin, %
  periodDays: number;
  scheduledPayment: number; // principal + interest portion for the month
  interestAccrued: number;
  subsidy: number; // ASP subsidy applied this month (reduces interest paid)
  interestPaid: number; // interestAccrued - subsidy
  principalPaid: number;
  extraPayment: number;
  insurance: number; // monthly insurance for this loan
  invoicingFeeShare: number; // this loan's share of the invoicing fee
  monthlyCharge: number; // total bank charge for the loan = P+I + invoicing share + insurance + extra
  endingPrincipal: number;
  isActual: boolean; // true when this row came from a recorded actual
}

export interface MortgageMemberPosition {
  userId: string;
  stake: number; // initialPayment + loanShare*initialLoanTotal (≈ half the house)
  liability: number; // loanShare*remainingTotal
  equity: number; // stake - liability (== initialPayment + loanShare*principalPaid)
  ownershipPercent: number; // equity / housePrice (→ target at payoff)
  leftToOwnTarget: number; // member.ownershipTargetPercent*housePrice - equity
  monthlyDeposit: number; // loanShare*totalRepayment + serviceFee — amount to transfer to the loan account
}

export interface MortgageProjectionMonth {
  yearMonth: YearMonth;
  year: number;
  month: number;
  periodDays: number;
  isHistorical: boolean; // yearMonth <= current month
  loans: MortgageLoanProjectionMonth[]; // per-loan detail (the expandable columns)
  isAllActual: boolean; // every loan row this month is a recorded actual
  // Summary/total columns (sums of the per-loan values)
  totalRemaining: number;
  totalRepayment: number; // Σ principal+interest (the amortizing installment)
  totalCharge: number; // Σ monthlyCharge (full bank charge incl insurance + invoicing) = spreadsheet "total repayment"
  totalInterest: number;
  totalSubsidy: number;
  totalInsurance: number;
  invoicingFee: number; // mortgage-level
  serviceFee: number; // mortgage-level
  principalPaidTotal: number; // initialLoanTotal - totalRemaining
  // Running cumulative totals to date (for the ledger footer)
  cumPrincipalPaid: number;
  cumInterestPaid: number;
  cumInsurancePaid: number;
  cumFeesPaid: number;
  // Per-member ownership/equity positions
  members: MortgageMemberPosition[];
}

// ============================================================
// TAXED INCOME (Bonuses, Holiday Pay, etc.)
// ============================================================

export interface TaxedIncome {
  id: string;
  accountId: string; // Links to a cash account
  name: string;
  grossAmount: number;
  // Tax handling
  useSalaryTaxSettings: boolean; // If true, use the linked account's salary tax rate
  customTaxRate?: number; // percentage, used if useSalaryTaxSettings is false
  customContributionsRate?: number;
  customOtherDeductions?: number;
  // Calculated
  netAmount: number;
  taxAmount: number;
  contributionsAmount: number;
  // Schedule
  kind: 'one-off' | 'recurring';
  scheduledDate?: YearMonth; // For one-off
  frequency?: Frequency; // For recurring
  customIntervalMonths?: number;
  startDate?: YearMonth;
  endDate?: YearMonth;
  // Occurrence months to skip (recurring only) — e.g. a year the holiday bonus
  // isn't paid. The projection omits any occurrence whose month is listed here.
  skippedOccurrences?: YearMonth[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaxedIncomeRequest {
  accountId: string;
  name: string;
  grossAmount: number;
  useSalaryTaxSettings?: boolean;
  customTaxRate?: number;
  customContributionsRate?: number;
  customOtherDeductions?: number;
  kind: 'one-off' | 'recurring';
  scheduledDate?: YearMonth;
  frequency?: Frequency;
  customIntervalMonths?: number;
  startDate?: YearMonth;
  endDate?: YearMonth;
  skippedOccurrences?: YearMonth[]; // recurring only — see TaxedIncome.skippedOccurrences
  isActive?: boolean;
}

export type UpdateTaxedIncomeRequest = Partial<CreateTaxedIncomeRequest>;

// ============================================================
// GOALS
// ============================================================

export interface Goal {
  id: string;
  userId: string;
  name: string;
  description?: string;
  targetAmount: number;
  currency: Currency;
  targetDate?: string; // YYYY-MM
  trackingMethod: 'account-balance' | 'net-worth' | 'manual';
  linkedAccountId?: string;
  currentManualAmount?: number;
  /** 'reserve' (default, never spent — just sequestered wealth) or 'spend' (a
   * target amount you intend to actually spend at the target date). Readers
   * default missing values to 'reserve'; stored goals are never migrated. */
  goalType?: 'reserve' | 'spend';
  /** Lower funds first when goals compete for the same pool of money (account
   * balance or net worth). Missing/null sorts after every prioritized goal, by
   * target date. */
  priority?: number | null;
  /** When true (and the goal qualifies — see `goalInjectsIntoCashflow` in
   * `src/lib/goal-utils.ts`), the goal's target amount is injected as a
   * read-only expense line in the linked account's cashflow at the target
   * month, so the projection actually reflects the planned spend. */
  injectIntoCashflow?: boolean;
  isArchived?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGoalRequest {
  name: string;
  description?: string;
  targetAmount: number;
  currency: Currency;
  targetDate?: string;
  trackingMethod: 'account-balance' | 'net-worth' | 'manual';
  linkedAccountId?: string;
  currentManualAmount?: number;
  goalType?: 'reserve' | 'spend';
  priority?: number | null;
  injectIntoCashflow?: boolean;
}

export interface UpdateGoalRequest extends Partial<CreateGoalRequest> {
  isArchived?: boolean;
}

// ============================================================
// TRIPS (Vero.fi per-diem travel reimbursement calculator)
// ============================================================

export type TripStatus = 'planned' | 'completed' | 'reimbursed';

/** One 24h slice (or the trailing remainder slice) of a trip. `date` is the
 * calendar date the slice STARTS. `countryCode` is 'FI' for domestic, else a
 * `PER_DIEM_COUNTRIES_2026` slug — editable per day for multi-country trips. */
export interface TripDay {
  date: string; // YYYY-MM-DD
  countryCode: string;
  freeMeals: number;
  overrideAmount?: number;
}

/** Rates in effect for a trip, snapshotted at creation so later-year rate
 * changes never retroactively alter an already-planned/reimbursed trip. */
export interface TripRateSnapshot {
  domesticFull: number;
  domesticPartial: number;
  defaultForeign: number;
  countryRates: Record<string, number>;
}

export interface Trip {
  id: string;
  userId: string;
  name: string;
  destinationCountry: string; // 'FI' or a PER_DIEM_COUNTRIES_2026 code
  startDateTime: string; // 'YYYY-MM-DDTHH:mm' local
  endDateTime: string; // 'YYYY-MM-DDTHH:mm' local
  days: TripDay[];
  rates: TripRateSnapshot;
  linkedAccountId: string;
  expectedReimbursementMonth: YearMonth;
  status: TripStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTripRequest {
  name: string;
  destinationCountry: string;
  startDateTime: string;
  endDateTime: string;
  days: TripDay[];
  rates: TripRateSnapshot;
  linkedAccountId: string;
  expectedReimbursementMonth: YearMonth;
  status: TripStatus;
  notes?: string;
}

export type UpdateTripRequest = Partial<CreateTripRequest>;

// ============================================================
// BUDGETS (trip/project budgets with grant funding)
// ============================================================

export type BudgetStatus = 'draft' | 'confirmed';

export type BudgetLineKind = 'one-off' | 'monthly';

export interface BudgetLine {
  id: string;
  name: string; // "Rent", "Flight to Stockholm"
  category: string; // from BUDGET_CATEGORIES (free string)
  amount: number; // per occurrence, in the budget's currency
  kind: BudgetLineKind;
  month?: YearMonth; // one-off: which month (clamped to the budget period)
  startMonth?: YearMonth; // monthly: defaults to budget.startMonth
  endMonth?: YearMonth; // monthly: defaults to budget.endMonth
}

export type BudgetFundingType = 'grant' | 'per-diem' | 'other';

export type BudgetFundingTiming = 'upfront' | 'monthly' | 'specific-month';

export interface BudgetFundingSource {
  id: string;
  name: string; // "Research foundation grant"
  type: BudgetFundingType;
  amount: number; // total, in the budget's currency (per-diem: rate × days, recomputed on save)
  // Empty/undefined = the money can pay for anything. Restrictions match
  // categories by exact string; renaming a category does not follow.
  restrictedToCategories?: string[];
  timing: BudgetFundingTiming;
  receivedMonth?: YearMonth; // required when timing === 'specific-month'
  perDiemRate?: number; // kept for re-editing when type === 'per-diem'
  perDiemDays?: number;
  // Per-diem sources only: the funding comes from this Trip. When set, `amount`
  // is hydrated from calculatePerDiem(trip).total at read time
  // (hydrateBudgetFundingFromTrips); the stored amount is a write-time snapshot
  // used only if the trip has been deleted. A trip may fund at most ONE budget,
  // and linking requires an EUR budget (per diems are EUR by definition).
  linkedTripId?: string;
  note?: string;
}

export interface BudgetExpenseEntry {
  id: string;
  // Plain 'YYYY-MM-DD' string — derive the month with date.slice(0, 7),
  // never via new Date() (timezone safety).
  date: string;
  description: string;
  amount: number; // in the budget's currency
  category: string;
  fundingSourceId?: string; // which source this will be claimed against
  note?: string;
  createdAt: string;
}

export interface Budget {
  id: string;
  userId: string;
  name: string;
  destination?: string; // just a label; empty for non-travel budgets
  description?: string;
  currency: Currency;
  startMonth: YearMonth; // inclusive
  endMonth: YearMonth; // inclusive
  status: BudgetStatus; // changed only via confirm/unconfirm actions
  isArchived: boolean;
  linkedAccountId?: string; // cash account for cashflow injection + income pull
  exchangeRate?: number; // 1 unit of budget currency = X units of account currency
  includeRegularIncome: boolean; // display-only pull on the budget page
  // Split group whose expenses (the user's share) are shown read-only on the
  // budget page. Computed at read time — never copied into the budget doc,
  // never part of feasibility or cashflow injection.
  linkedSplitGroupId?: string;
  lines: BudgetLine[];
  fundingSources: BudgetFundingSource[];
  expenseEntries: BudgetExpenseEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBudgetRequest {
  name: string;
  destination?: string;
  description?: string;
  currency: Currency;
  startMonth: YearMonth;
  endMonth: YearMonth;
  linkedAccountId?: string;
  exchangeRate?: number;
  includeRegularIncome?: boolean;
}

// status is deliberately NOT updatable here — only confirmBudget/unconfirmBudget change it
export interface UpdateBudgetRequest extends Partial<CreateBudgetRequest> {
  isArchived?: boolean;
  linkedSplitGroupId?: string; // undefined-with-key clears the link
}

export interface CreateBudgetLineRequest {
  name: string;
  category: string;
  amount: number;
  kind: BudgetLineKind;
  month?: YearMonth;
  startMonth?: YearMonth;
  endMonth?: YearMonth;
}

export type UpdateBudgetLineRequest = Partial<CreateBudgetLineRequest>;

export interface CreateBudgetFundingSourceRequest {
  name: string;
  type: BudgetFundingType;
  amount: number;
  restrictedToCategories?: string[];
  timing: BudgetFundingTiming;
  receivedMonth?: YearMonth;
  perDiemRate?: number;
  perDiemDays?: number;
  linkedTripId?: string;
  note?: string;
}

export type UpdateBudgetFundingSourceRequest = Partial<CreateBudgetFundingSourceRequest>;

export interface CreateBudgetExpenseEntryRequest {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number;
  category: string;
  fundingSourceId?: string;
  note?: string;
}

export type UpdateBudgetExpenseEntryRequest = Partial<CreateBudgetExpenseEntryRequest>;

// ============================================================
// WEALTH PROJECTION TYPES
// ============================================================

export interface WealthProjectionMonth {
  yearMonth: YearMonth;
  year: number;
  month: number;
  // Cash accounts (from existing projection)
  cashAccountsTotal: number;
  cashAccountsBreakdown: { accountId: string; name: string; balance: number }[];
  // Investments
  investmentsTotal: number;
  investmentsBreakdown: { accountId: string; name: string; valuation: number }[];
  // Receivables
  receivablesTotal: number;
  receivablesBreakdown: { receivableId: string; name: string; balance: number }[];
  // Debts (negative values)
  debtsTotal: number;
  debtsBreakdown: { debtId: string; name: string; principal: number; interestPaid?: number }[];
  // Shared mortgage — the logged-in member's slice (optional / back-compatible).
  // equity is folded into netWorth; stake (home asset) and liability (loan share)
  // are exposed separately so the wealth chart can show them as distinct bands.
  mortgageEquityTotal?: number;
  mortgageLiabilityTotal?: number;
  mortgageStakeTotal?: number;
  mortgagesBreakdown?: { mortgageId: string; name: string; stake: number; liability: number; equity: number }[];
  // Linked credit cards — the outstanding owed but not yet paid as of this month
  // (drops to 0 once the bill is paid via the injected cashflow line, so there's
  // no double count). Optional / back-compatible.
  cardLiabilitiesTotal?: number;
  cardLiabilitiesBreakdown?: { linkId: string; name: string; outstanding: number }[];
  // Net worth
  netWorth: number;
}

export interface DebtAmortizationRow {
  yearMonth: YearMonth;
  startingPrincipal: number;
  interestPaid: number;
  principalPaid: number;
  totalPayment: number;
  endingPrincipal: number;
  interestRate: number; // The rate used for this period
}

export interface InvestmentProjectionRow {
  yearMonth: YearMonth;
  startingValuation: number;
  growth: number;
  contributions: number;
  withdrawals: number;
  endingValuation: number;
}

export interface ReceivableProjectionRow {
  yearMonth: YearMonth;
  startingBalance: number;
  repayments: number;
  interestAccrued: number;
  endingBalance: number;
}

// ============================================================
// RECONCILIATION & BALANCE SNAPSHOTS
// ============================================================

export type EntityType = 'cash-account' | 'investment' | 'receivable' | 'debt';

export type AdjustmentCategory =
  | 'untracked-income'
  | 'untracked-expense'
  | 'valuation-change'
  | 'interest-adjustment'
  | 'data-correction'
  | 'other';

export interface BalanceSnapshot {
  id: string;
  userId: string;
  entityType: EntityType;
  entityId: string;
  yearMonth: YearMonth;
  expectedBalance: number; // What the system projected
  actualBalance: number; // What user reported
  variance: number; // actualBalance - expectedBalance
  // Provenance: 'manual' (a user reconciliation, the default for all existing
  // snapshots) or 'bank-sync' (auto-written by the Enable Banking sync).
  // Last write wins per entity/month; bank sync only writes the current month.
  source?: 'manual' | 'bank-sync';
  createdAt: string;
}

export interface ReconciliationAdjustment {
  id: string;
  snapshotId: string;
  category: AdjustmentCategory;
  amount: number;
  description?: string;
  createdAt: string;
}

export interface ReconciliationSession {
  id: string;
  userId: string;
  yearMonth: YearMonth;
  status: 'in-progress' | 'completed';
  startedAt: string;
  completedAt?: string;
  snapshots: BalanceSnapshot[];
  adjustments: ReconciliationAdjustment[];
}

export interface CreateBalanceSnapshotRequest {
  entityType: EntityType;
  entityId: string;
  yearMonth: YearMonth;
  actualBalance: number;
}

export interface CreateAdjustmentRequest {
  snapshotId: string;
  category: AdjustmentCategory;
  amount: number;
  description?: string;
}

export interface ReconciliationSummary {
  yearMonth: YearMonth;
  totalVariance: number;
  adjustmentsByCategory: Record<AdjustmentCategory, number>;
  entitiesReconciled: number;
  lastReconciledAt?: string;
}

// ============================================================
// ENABLE BANKING (PSD2 AIS) — read-only bank-data sync
//
// Sampolio pulls balances + transactions from the user's banks via Enable
// Banking (a licensed aggregator) to auto-anchor forecasts and model cards.
// Everything is additive: the UI reads only the local encrypted cache; the
// bank API is touched only by a background sync + an on-demand "Refresh now".
// Phase 1 is per-user (data/users/{id}/bank/...); the model carries enough
// fields (applicationId, etc.) to later mirror the shared-mortgage pattern.
// ============================================================

export type BankConnectionStatus = 'pending' | 'active' | 'expired' | 'error' | 'revoked';
export type BankAccountRole = 'cash' | 'credit-card' | 'savings' | 'other';
export type BankTransactionStatus = 'booked' | 'pending' | 'other';
export type BankSyncTrigger = 'callback-backfill' | 'scheduled' | 'manual';
export type BankSyncStatus = 'ok' | 'partial' | 'error';

/** One real bank account exposed by a connection, and how Sampolio uses it. */
export interface BankAccountLink {
  id: string; // our uuid; STABLE across re-consent (re-matched by accountUid/iban)
  connectionId: string;
  accountUid: string; // Enable Banking account_id, used for data calls
  // Enable Banking's stable account identity — constant across sessions AND
  // users (per EB's FAQ); the primary re-consent matching key (accountUid/iban
  // are fallbacks — see reconcile-links.ts).
  identificationHash?: string;
  iban?: string; // stored; masked in UI, never logged
  name?: string; // bank-provided name (may be blank, e.g. cards); refreshed on re-consent
  customName?: string; // user-set display name; preserved across re-consent, wins over name
  currency: Currency;
  accountRole: BankAccountRole;
  // cash/savings: the FinancialAccount this balance ANCHORS.
  // credit-card: the cash account the bill is PAID FROM (like Debt.linkedAccountId).
  linkedFinancialAccountId?: string;
  // --- credit-card billing (accountRole === 'credit-card') ---
  statementDay?: number; // 1-31, manual config (AIS usually omits it)
  paymentDueDay?: number; // 1-31
  creditLimit?: number; // total limit; auto-derived as availableCredit + outstanding when the bank exposes both
  manualCreditLimit?: number; // user-entered limit; fallback when the bank reports none (e.g. OP)
  availableCredit?: number; // card: available-to-spend (EB ITAV), updates in real time
  // credit-card: forecast buffer for untracked future spend (per cycle).
  // Future statements are forecast as the sum of expenses tagged "paid by this
  // card" + this buffer; for the current OPEN cycle only the pro-rata share of
  // the days still ahead is added on top of the actual synced spend.
  expectedMonthlySpend?: number;
  lastStatementBalance?: number;
  lastStatementDate?: string; // 'YYYY-MM-DD'
  // --- balances / incremental cursor ---
  lastBalance?: number;
  lastBalanceType?: string; // e.g. 'closingBooked'
  lastBalanceAt?: string; // ISO timestamp of the last balance fetch
  outstanding?: number; // credit-card: amount owed (positive magnitude)
  syncCursor?: { lastBookingDate?: string; lastSeenEntryRefs?: string[]; backfilledThrough?: string };
  isExcluded?: boolean; // user opted this real account out of any modeling
  // ISO timestamp of the last successful data refresh for this link — either
  // fetched directly or received via cross-user fan-out (see link-identity.ts).
  lastSyncedAt?: string;
}

export interface BankConnection {
  id: string;
  userId: string;
  aspspName: string; // bank name, e.g. "Nordea"
  aspspCountry: string; // ISO country, e.g. "FI"
  applicationId?: string; // which Enable Banking app/key this consent belongs to
  status: BankConnectionStatus;
  psuType: 'personal';
  linkedAccounts: BankAccountLink[];
  consentGrantedAt?: string;
  consentExpiresAt?: string; // = the returned access.valid_until
  nextSyncDueAt?: string; // persisted scheduler cursor (restart-safe)
  lastSyncAt?: string;
  lastSyncStatus?: BankSyncStatus;
  lastError?: string; // error CODE only, never PII
  consecutiveSyncFailures?: number; // non-ok runs in a row; reset to 0 on a clean sync
  createdAt: string;
  updatedAt: string;
}

/** Live consent secrets — a SEPARATE file, never cached, never logged. */
export interface BankSessionSecret {
  connectionId: string;
  state: string; // single-use CSRF token matched at the callback
  authorizationId?: string;
  sessionId?: string;
  createdAt: string;
}

export interface BankTransaction {
  id: string;
  linkedAccountId: string; // BankAccountLink.id
  dedupKey: string; // entry_reference (booked) OR synthetic hash (pending)
  entryReference?: string;
  bookingDate: string; // 'YYYY-MM-DD' (or full ISO datetime if the bank provides a time)
  valueDate?: string;
  transactionDate?: string; // when the transaction actually occurred (may differ from booking)
  amount: number; // signed (credit +, debit -)
  currency: Currency;
  status: BankTransactionStatus;
  counterpartyName?: string;
  counterpartyAccount?: string; // counterparty IBAN (masked in UI, never logged)
  remittanceInfo?: string; // may be multi-line (joined with newlines)
  bankTransactionCode?: string; // bank's human label, e.g. "e-lasku"
  merchantCategoryCode?: string;
  balanceAfter?: number; // account balance after this transaction, if the bank returns it
  note?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface BankSyncRunAccountResult {
  linkedAccountId: string;
  balanceFetched: boolean;
  txAdded: number;
  txUpdated: number;
  txRemoved?: number; // stale pending rows pruned this run (optional: absent in old run history)
  pendingFetched?: number; // PDNG rows fetched this run (absent = pending fetch not attempted)
  pendingFetchOk?: boolean; // absent = not attempted; false = attempted, failed non-fatally
  fromDate?: string;
  toDate?: string;
  error?: string; // code only
  rateLimited?: boolean;
  // Scheduled runs only: the account had a stable identity, a completed
  // backfill, and a recent enough `lastSyncedAt` (ours or a sibling user's
  // fan-out) that the fetch was skipped entirely — 0 bank calls this run.
  skippedFresh?: true;
}

export interface BankSyncRun {
  id: string;
  connectionId: string;
  trigger: BankSyncTrigger;
  startedAt: string;
  finishedAt?: string;
  status: BankSyncStatus;
  perAccount: BankSyncRunAccountResult[];
  psuPresent: boolean; // whether PSU-IP-Address was sent (higher rate allowance)
  error?: string; // code only
}

// ---------- Request / input types ----------
export interface StartBankConnectionRequest {
  aspspName: string;
  aspspCountry: string;
}

export interface UpdateBankAccountLinkRequest {
  accountRole?: BankAccountRole;
  customName?: string | null; // null/empty clears the custom name
  linkedFinancialAccountId?: string | null; // null clears the link
  isExcluded?: boolean;
  // credit-card config
  statementDay?: number | null;
  paymentDueDay?: number | null;
  creditLimit?: number | null;
  expectedMonthlySpend?: number | null;
}

// ============================================================
// CASHFLOW VISUALIZATION TYPES
// ============================================================

export interface CashflowItem {
  id: string;
  name: string;
  amount: number;
  category?: string;
  type: 'income' | 'expense' | 'transfer' | 'adjustment';
  source: 'recurring' | 'planned' | 'salary' | 'taxed-income' | 'adjustment' | 'debt-payment' | 'mortgage-payment' | 'budget' | 'credit-card' | 'goal' | 'trip';
  isRecurring: boolean;
  linkedEntityId?: string; // For drill-down
  linkedEntityType?: string;
}

export interface MonthFlowData {
  yearMonth: YearMonth;
  accountId: string;
  startingBalance: number;
  endingBalance: number;
  inflows: CashflowItem[];
  outflows: CashflowItem[];
  totalInflows: number;
  totalOutflows: number;
  netChange: number;
  /** Actualized (current) month only: netChange − planned net. Positive = expenses already
   *  paid out of today's balance exceed income already received; the Sankey adds a balancing
   *  "Already paid" inflow (or "Already received" outflow when negative) so the Budget node's
   *  planned-amount flows reconcile with the adjusted netChange. */
  alreadySettledNet?: number;
  isReconciled: boolean;
  reconciledBalance?: number;
}

// ============================================================
// NAVIGATION & UI STATE TYPES
// ============================================================

export type NavigationPage = 'home' | 'overview' | 'cashflow' | 'mortgage' | 'budgets' | 'split' | 'goals' | 'playground' | 'bank' | 'settings';

export type TimeHorizon = '6m' | '1y' | '3y' | '5y' | 'custom';

export interface ChartInteraction {
  type: 'month-click' | 'entity-click' | 'segment-click';
  yearMonth?: YearMonth;
  entityId?: string;
  entityType?: EntityType;
}

export interface DrawerState {
  isOpen: boolean;
  mode: 'view' | 'edit' | 'create';
  entityType?: string;
  entityId?: string;
  yearMonth?: YearMonth;
}

// ============================================================
// COMMAND PALETTE TYPES
// ============================================================

export type CommandType = 'navigate' | 'add' | 'reconcile' | 'search' | 'action';

export interface Command {
  id: string;
  label: string;
  description?: string;
  type: CommandType;
  icon?: React.ReactNode;
  shortcut?: string;
  action: () => void;
  keywords?: string[];
}

// ============================================================
// SPLIT — shared expense-splitting groups (a Splitwise replacement)
// A shared, multi-user entity like SharedMortgage: stored under
// data/shared/split-groups, access controlled by the `members` list (not a
// single userId). Money is stored as INTEGER CENTS everywhere. Every row
// carries `netByUserId` (cents, sums to 0 across members) as the canonical
// balance contribution: net > 0 ⇒ that member is OWED, net < 0 ⇒ that member
// OWES — the same sign convention as the Splitwise CSV export and its
// "Total balance" footer, so import is a direct cents copy. A member's
// running balance is the sum of their net over all rows.
// ============================================================

export type SplitInterval = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly';

/**
 * How the user entered a split; stored on native rows so they can be edited.
 * - equal:   participants (incl. payer) owe an equal share
 * - full:    payer owes nothing; the other participants owe the whole amount
 * - exact:   splitConfig = owed cents per member
 * - percent: splitConfig = owed basis points (sum 10000) per member
 * - shares:  splitConfig = integer share weights per member
 */
export type SplitMode = 'equal' | 'full' | 'exact' | 'percent' | 'shares';

export type SplitGroupMemberRole = 'owner' | 'member';

/** A split spec the UI sends; the engine reduces it to per-member shares + net. */
export interface SplitSpec {
  paidByUserId: string;
  splitMode: SplitMode;
  /** meaning depends on splitMode (cents / basis points / share weights) */
  splitConfig?: Record<string, number>;
  /** members who share the cost; defaults to all group members */
  participantUserIds?: string[];
}

export interface SplitGroupMember {
  userId: string;
  email: string; // denormalized for display; resolved when added
  name: string; // denormalized for display
  role: SplitGroupMemberRole;
  color?: string; // optional avatar / feed accent
}

/** A recurring template that materializes a real expense each period. */
export interface SplitRecurrenceRule {
  id: string;
  title: string;
  category: string;
  amountCents: number;
  currency: Currency;
  note?: string;
  split: SplitSpec; // template split applied to every generated occurrence
  interval: SplitInterval;
  anchorDate: string; // YYYY-MM-DD — the first occurrence
  endDate?: string; // YYYY-MM-DD inclusive — recurrence stops after this
  isActive: boolean; // false = paused/stopped; past occurrences are kept
  lastGeneratedThrough?: string; // YYYY-MM-DD of the last materialized occurrence
  createdAt: string;
  updatedAt: string;
}

export interface SplitGroup {
  id: string;
  name: string;
  emoji?: string;
  currency: Currency;
  members: SplitGroupMember[];
  recurrenceRules: SplitRecurrenceRule[]; // embedded (few per group)
  isArchived: boolean;
  createdBy: string; // userId of creator (becomes an 'owner')
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** Per-member contribution to an expense (native rows only; integer cents). */
export interface SplitShare {
  userId: string;
  amountCents: number;
}

export type SplitExpenseSource = 'manual' | 'import' | 'recurring';

interface SplitRowBase {
  id: string;
  groupId: string;
  date: string; // YYYY-MM-DD
  currency: Currency;
  note?: string;
  /** CANONICAL balance contribution per member, integer cents, sums to 0. */
  netByUserId: Record<string, number>;
  source: SplitExpenseSource;
  generatedFromRuleId?: string; // set when source === 'recurring'
  occurrenceKey?: string; // `${ruleId}:${YYYY-MM-DD}` — recurrence dedup key
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Denormalized pointer from a split expense to the bank transaction it was created
 * from ("Split this" on the bank page). Denormalized so other group members can see
 * basic details without access to the owner's bank data. Never includes IBANs. */
export interface SplitExpenseBankLink {
  txId: string; // BankTransaction.id
  linkedAccountId: string; // BankAccountLink.id (owner's)
  ownerUserId: string; // whose bank connection — stamped server-side
  bookingDate: string; // 'YYYY-MM-DD'
  amount: number; // signed, account currency
  currency: Currency;
  counterpartyName?: string;
  bankName?: string; // aspspName
}

export interface SplitExpenseItem extends SplitRowBase {
  kind: 'expense';
  title: string;
  category: string;
  amountCents: number; // total bill, integer cents
  // Full-fidelity split, present for native rows; absent for imported rows
  // (imports only know per-member net).
  paidBy?: SplitShare[];
  owed?: SplitShare[];
  splitMode?: SplitMode;
  /** Set when this row originated from "Split this" on a bank transaction. */
  bankLink?: SplitExpenseBankLink;
}

export interface SplitPayment extends SplitRowBase {
  kind: 'payment';
  fromUserId: string; // who paid (reduces what they owe)
  toUserId: string; // who received
  amountCents: number;
}

export type SplitExpense = SplitExpenseItem | SplitPayment;

/** Maintained running summary (data/shared/split-groups/{id}/summary.enc). */
export interface SplitGroupSummary {
  groupId: string;
  netByUserId: Record<string, number>; // cents; net > 0 ⇒ that member is owed
  expenseCount: number;
  paymentCount: number;
  lastActivityAt?: string;
  monthsWithData: string[]; // sorted YYYY-MM (chunk index + recent-feed seek)
  updatedAt: string;
}

/** Derived (not stored) — one entry per row, for the activity feed. */
export interface SplitActivityEvent {
  id: string; // = row id
  groupId: string;
  groupName: string;
  groupEmoji?: string;
  kind: 'expense' | 'payment';
  title: string; // expense title, or "X paid Y" for payments
  category?: string;
  amountCents: number;
  viewerNetCents: number; // the viewing user's net for this row (>0 lent, <0 borrowed)
  actorUserId: string;
  actorName: string;
  date: string; // YYYY-MM-DD
  createdAt: string;
  source: SplitExpenseSource;
}

/** Aggregate net for a member across a group (derived). */
export interface SplitMemberBalance {
  userId: string;
  name: string;
  netCents: number; // >0 owed to them, <0 they owe
}

/** Lightweight cross-group projection used by the bank ledger's "already split" matching. */
export interface SplitLinkCandidate {
  expenseId: string;
  groupId: string;
  groupName: string;
  title: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  currency: Currency;
  bankLink?: { txId: string; linkedAccountId: string; ownerUserId: string };
}

// ---------- Split request types ----------
export interface CreateSplitGroupMemberInput {
  email: string;
  role?: SplitGroupMemberRole;
}

export interface CreateSplitGroupRequest {
  name: string;
  emoji?: string;
  currency: Currency;
  members?: CreateSplitGroupMemberInput[]; // besides the creator
}

export interface UpdateSplitGroupRequest {
  name?: string;
  emoji?: string;
  isArchived?: boolean;
}

export interface CreateSplitExpenseRequest {
  title: string;
  category: string;
  amountCents: number;
  date: string; // YYYY-MM-DD
  note?: string;
  split: SplitSpec;
}

export type UpdateSplitExpenseRequest = Partial<CreateSplitExpenseRequest>;

export interface QuickAddSplitExpenseRequest {
  title: string;
  amountCents: number;
  category?: string; // defaults via auto-guess, then "General"
  date?: string; // defaults to today
}

export interface RecordSettleUpRequest {
  fromUserId: string;
  toUserId: string;
  amountCents: number;
  date?: string; // defaults to today
  note?: string;
}

export interface CreateSplitRecurrenceRuleRequest {
  title: string;
  category: string;
  amountCents: number;
  note?: string;
  split: SplitSpec;
  interval: SplitInterval;
  anchorDate: string; // YYYY-MM-DD
  endDate?: string;
  isActive?: boolean;
}

export type UpdateSplitRecurrenceRuleRequest = Partial<CreateSplitRecurrenceRuleRequest>;

/** One parsed row from a Splitwise CSV export, ready to map to a group. */
export interface SplitwiseImportRow {
  date: string; // YYYY-MM-DD
  description: string;
  category: string;
  amountCents: number;
  currency: string;
  netByColumn: number[]; // signed cents per member column, in column order
  isPayment: boolean; // Splitwise "Payment" category
}

export interface ImportSplitwiseRequest {
  groupId: string;
  columnUserIds: string[]; // member column index → group member userId
  rows: SplitwiseImportRow[];
  replaceAll?: boolean;
}
