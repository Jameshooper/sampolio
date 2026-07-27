/**
 * Cached data access layer using Next.js 16 'use cache' directive.
 *
 * All read operations go through this module to benefit from in-memory caching.
 * Cache entries are tagged for granular invalidation when data is mutated.
 *
 * Tag convention:
 *   all-data                                          – admin force-revalidate
 *   user:{userId}                                     – per-user global
 *   user:{userId}:accounts                            – accounts collection
 *   user:{userId}:account:{accountId}:recurring       – recurring items
 *   user:{userId}:account:{accountId}:planned         – planned items
 *   user:{userId}:account:{accountId}:salary          – salary configs
 *   user:{userId}:account:{accountId}:taxed-income    – taxed income
 *   user:{userId}:investments                         – investment accounts
 *   user:{userId}:investment:{id}:contributions       – contributions
 *   user:{userId}:debts                               – debts
 *   user:{userId}:debt:{id}:rates                     – reference rates
 *   user:{userId}:debt:{id}:payments                  – extra payments
 *   user:{userId}:receivables                         – receivables
 *   user:{userId}:receivable:{id}:repayments          – repayments
 *   user:{userId}:preferences                         – user preferences
 *   user:{userId}:reconciliation                      – reconciliation data
 *   user:{userId}:goals                               – financial goals (single docs)
 *   user:{userId}:trips                               – per-diem trips (single docs)
 *   user:{userId}:budgets                             – trip/project budgets (single docs)
 *   user:{userId}:bank-connections                    – bank connection list
 *   user:{userId}:bank-connection:{id}                – one bank connection
 *   user:{userId}:bank-account:{linkedAccountId}:transactions – bank tx ledger
 *   user:{userId}:bank-connection:{id}:runs           – sync-run audit log
 *   app-settings                                      – global app settings
 *   users                                             – all users list
 *   mortgage:{mortgageId}                             – shared mortgage doc (loans + members)
 *   mortgage:{mortgageId}:rates                       – Euribor reset history
 *   mortgage:{mortgageId}:costs                       – fee/insurance history
 *   mortgage:{mortgageId}:payments                    – extra payments
 *   mortgage:{mortgageId}:snapshots                   – drift snapshots
 *   mortgage:{mortgageId}:actuals                     – imported actual monthly history
 *   user:{userId}:mortgages                           – a user's mortgage membership list
 *   split-group:{groupId}                             – shared split group doc (members + recurrence rules)
 *   split-group:{groupId}:summary                     – maintained running balances + month index
 *   split-group:{groupId}:expenses                    – the group's monthly expense chunks
 *   user:{userId}:split-groups                        – a user's split-group membership list
 */

import { cacheTag, cacheLife } from 'next/cache';

// DB layer imports
import { getAccounts, getAccountById } from './accounts';
import { getRecurringItems, getRecurringItemById } from './recurring-items';
import { getPlannedItems, getPlannedItemById } from './planned-items';
import { getSalaryConfigs, getSalaryConfigById } from './salary-configs';
import { getTaxedIncomes, getTaxedIncomeById } from './taxed-income';
import {
  getInvestmentAccounts,
  getInvestmentAccountById,
  getContributions,
} from './investments';
import { getDebts, getDebtById, getReferenceRates, getExtraPayments } from './debts';
import {
  getMortgageById as dbGetMortgageById,
  getMortgagesForUser as dbGetMortgagesForUser,
  getRates as dbGetMortgageRates,
  getCosts as dbGetMortgageCosts,
  getExtraPayments as dbGetMortgageExtraPayments,
  getBalanceSnapshots as dbGetMortgageSnapshots,
  getActuals as dbGetMortgageActuals,
} from './shared-mortgages';
import {
  getSplitGroupsForUser as dbGetSplitGroupsForUser,
  getSplitGroupById as dbGetSplitGroupById,
  getSplitGroupSummary as dbGetSplitGroupSummary,
  getExpenseMonths as dbGetExpenseMonths,
  getExpensesForMonths as dbGetExpensesForMonths,
  getAllExpenses as dbGetAllExpenses,
} from './split-groups';
import { getReceivables, getReceivableById, getRepayments } from './receivables';
import { getGoals, getGoalById } from './goals';
import { getTrips, getTripById } from './trips';
import { getBudgets, getBudgetById } from './budgets';
import { getUserPreferences } from './user-preferences';
import { getAppSettings } from './app-settings';
import { getAllUsers } from './users';
import { getBankConnections, getBankConnectionById } from './bank-connections';
import { getBankTransactions } from './bank-transactions';
import { getBankSyncRuns, getLatestBankSyncRun } from './bank-sync-runs';
import {
  getBalanceSnapshots,
  getReconciliationSessions,
  getSnapshotsForEntity,
  getSnapshotsForMonth,
  getLatestSnapshot,
  getLatestCompletedSession,
  getSessionForMonth,
} from './reconciliation';

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
  Trip,
  Budget,
  UserPreferences,
  AppSettings,
  User,
  BalanceSnapshot,
  ReconciliationSession,
  EntityType,
  SharedMortgage,
  MortgageRateEntry,
  MortgageCostEntry,
  MortgageExtraPayment,
  MortgageBalanceSnapshot,
  MortgageActualEntry,
  BankConnection,
  BankTransaction,
  BankSyncRun,
  SplitGroup,
  SplitGroupSummary,
  SplitExpense,
} from '@/types';

// ============================================================
// CASHFLOW DOMAIN
// ============================================================

export async function cachedGetAccounts(userId: string): Promise<FinancialAccount[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:accounts`);
  cacheLife('indefinite');
  return getAccounts(userId);
}

export async function cachedGetAccountById(
  userId: string,
  accountId: string
): Promise<FinancialAccount | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:accounts`);
  cacheLife('indefinite');
  return getAccountById(userId, accountId);
}

export async function cachedGetRecurringItems(
  userId: string,
  accountId: string
): Promise<RecurringItem[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:recurring`);
  cacheLife('indefinite');
  return getRecurringItems(userId, accountId);
}

export async function cachedGetRecurringItemById(
  userId: string,
  accountId: string,
  itemId: string
): Promise<RecurringItem | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:recurring`);
  cacheLife('indefinite');
  return getRecurringItemById(userId, accountId, itemId);
}

export async function cachedGetPlannedItems(
  userId: string,
  accountId: string
): Promise<PlannedItem[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:planned`);
  cacheLife('indefinite');
  return getPlannedItems(userId, accountId);
}

export async function cachedGetPlannedItemById(
  userId: string,
  accountId: string,
  itemId: string
): Promise<PlannedItem | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:planned`);
  cacheLife('indefinite');
  return getPlannedItemById(userId, accountId, itemId);
}

export async function cachedGetSalaryConfigs(
  userId: string,
  accountId: string
): Promise<SalaryConfig[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:salary`);
  cacheLife('indefinite');
  return getSalaryConfigs(userId, accountId);
}

export async function cachedGetSalaryConfigById(
  userId: string,
  accountId: string,
  configId: string
): Promise<SalaryConfig | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:salary`);
  cacheLife('indefinite');
  return getSalaryConfigById(userId, accountId, configId);
}

export async function cachedGetTaxedIncomes(
  userId: string,
  accountId: string
): Promise<TaxedIncome[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:taxed-income`);
  cacheLife('indefinite');
  return getTaxedIncomes(userId, accountId);
}

export async function cachedGetTaxedIncomeById(
  userId: string,
  accountId: string,
  incomeId: string
): Promise<TaxedIncome | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:account:${accountId}:taxed-income`);
  cacheLife('indefinite');
  return getTaxedIncomeById(userId, accountId, incomeId);
}

// ============================================================
// INVESTMENTS
// ============================================================

export async function cachedGetInvestmentAccounts(userId: string): Promise<InvestmentAccount[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:investments`);
  cacheLife('indefinite');
  return getInvestmentAccounts(userId);
}

export async function cachedGetInvestmentAccountById(
  userId: string,
  investmentId: string
): Promise<InvestmentAccount | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:investments`);
  cacheLife('indefinite');
  return getInvestmentAccountById(userId, investmentId);
}

export async function cachedGetContributions(
  userId: string,
  investmentId: string
): Promise<InvestmentContribution[]> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:investment:${investmentId}:contributions`
  );
  cacheLife('indefinite');
  return getContributions(userId, investmentId);
}

// ============================================================
// DEBTS
// ============================================================

export async function cachedGetDebts(userId: string): Promise<Debt[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:debts`);
  cacheLife('indefinite');
  return getDebts(userId);
}

export async function cachedGetDebtById(
  userId: string,
  debtId: string
): Promise<Debt | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:debts`);
  cacheLife('indefinite');
  return getDebtById(userId, debtId);
}

export async function cachedGetReferenceRates(
  userId: string,
  debtId: string
): Promise<DebtReferenceRate[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:debt:${debtId}:rates`);
  cacheLife('indefinite');
  return getReferenceRates(userId, debtId);
}

export async function cachedGetExtraPayments(
  userId: string,
  debtId: string
): Promise<DebtExtraPayment[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:debt:${debtId}:payments`);
  cacheLife('indefinite');
  return getExtraPayments(userId, debtId);
}

// ============================================================
// RECEIVABLES
// ============================================================

export async function cachedGetReceivables(userId: string): Promise<Receivable[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:receivables`);
  cacheLife('indefinite');
  return getReceivables(userId);
}

export async function cachedGetReceivableById(
  userId: string,
  receivableId: string
): Promise<Receivable | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:receivables`);
  cacheLife('indefinite');
  return getReceivableById(userId, receivableId);
}

export async function cachedGetRepayments(
  userId: string,
  receivableId: string
): Promise<ReceivableRepayment[]> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:receivable:${receivableId}:repayments`
  );
  cacheLife('indefinite');
  return getRepayments(userId, receivableId);
}

// ============================================================
// GOALS
// ============================================================

export async function cachedGetGoals(userId: string): Promise<Goal[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:goals`);
  cacheLife('indefinite');
  return getGoals(userId);
}

export async function cachedGetGoalById(
  userId: string,
  goalId: string
): Promise<Goal | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:goals`);
  cacheLife('indefinite');
  return getGoalById(userId, goalId);
}

// ============================================================
// TRIPS
// ============================================================

export async function cachedGetTrips(userId: string): Promise<Trip[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:trips`);
  cacheLife('indefinite');
  return getTrips(userId);
}

export async function cachedGetTripById(
  userId: string,
  tripId: string
): Promise<Trip | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:trips`);
  cacheLife('indefinite');
  return getTripById(userId, tripId);
}

// ============================================================
// BUDGETS
// ============================================================

export async function cachedGetBudgets(userId: string): Promise<Budget[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:budgets`);
  cacheLife('indefinite');
  return getBudgets(userId);
}

export async function cachedGetBudgetById(
  userId: string,
  budgetId: string
): Promise<Budget | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:budgets`);
  cacheLife('indefinite');
  return getBudgetById(userId, budgetId);
}

// ============================================================
// USER PREFERENCES
// ============================================================

export async function cachedGetUserPreferences(userId: string): Promise<UserPreferences> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:preferences`);
  cacheLife('indefinite');
  return getUserPreferences(userId);
}

// ============================================================
// ADMIN / GLOBAL
// ============================================================

export async function cachedGetAppSettings(): Promise<AppSettings> {
  'use cache';
  cacheTag('all-data', 'app-settings');
  cacheLife('indefinite');
  return getAppSettings();
}

export async function cachedGetAllUsers(): Promise<User[]> {
  'use cache';
  cacheTag('all-data', 'users');
  cacheLife('indefinite');
  return getAllUsers();
}

// ============================================================
// RECONCILIATION
// ============================================================

export async function cachedGetBalanceSnapshots(userId: string): Promise<BalanceSnapshot[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getBalanceSnapshots(userId);
}

export async function cachedGetSnapshotsForEntity(
  userId: string,
  entityType: EntityType,
  entityId: string
): Promise<BalanceSnapshot[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getSnapshotsForEntity(userId, entityType, entityId);
}

export async function cachedGetSnapshotsForMonth(
  userId: string,
  yearMonth: string
): Promise<BalanceSnapshot[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getSnapshotsForMonth(userId, yearMonth);
}

export async function cachedGetLatestSnapshot(
  userId: string,
  entityType: EntityType,
  entityId: string
): Promise<BalanceSnapshot | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  // 'synced' (not 'indefinite'): a bank sync writes a `source:'bank-sync'`
  // anchor snapshot from the background scheduler (no request scope), so its
  // tag invalidation is swallowed. A short revalidate lets the projection
  // anchor catch up to the real bank balance without a manual action.
  cacheLife('synced');
  return getLatestSnapshot(userId, entityType, entityId);
}

export async function cachedGetReconciliationSessions(
  userId: string
): Promise<ReconciliationSession[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getReconciliationSessions(userId);
}

export async function cachedGetSessionForMonth(
  userId: string,
  yearMonth: string
): Promise<ReconciliationSession | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getSessionForMonth(userId, yearMonth);
}

export async function cachedGetLatestCompletedSession(
  userId: string
): Promise<ReconciliationSession | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:reconciliation`);
  cacheLife('indefinite');
  return getLatestCompletedSession(userId);
}

// ============================================================
// SHARED MORTGAGES
// Tags are keyed by mortgageId (not userId) so a single invalidation reaches
// every member. Only the membership list is user-scoped.
// ============================================================

export async function cachedGetMortgagesForUser(userId: string): Promise<SharedMortgage[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}:mortgages`);
  cacheLife('indefinite');
  return dbGetMortgagesForUser(userId);
}

export async function cachedGetMortgageById(mortgageId: string): Promise<SharedMortgage | null> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}`);
  cacheLife('indefinite');
  return dbGetMortgageById(mortgageId);
}

export async function cachedGetMortgageRates(mortgageId: string): Promise<MortgageRateEntry[]> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}:rates`);
  cacheLife('indefinite');
  return dbGetMortgageRates(mortgageId);
}

export async function cachedGetMortgageCosts(mortgageId: string): Promise<MortgageCostEntry[]> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}:costs`);
  cacheLife('indefinite');
  return dbGetMortgageCosts(mortgageId);
}

export async function cachedGetMortgageExtraPayments(
  mortgageId: string
): Promise<MortgageExtraPayment[]> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}:payments`);
  cacheLife('indefinite');
  return dbGetMortgageExtraPayments(mortgageId);
}

export async function cachedGetMortgageBalanceSnapshots(
  mortgageId: string
): Promise<MortgageBalanceSnapshot[]> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}:snapshots`);
  cacheLife('indefinite');
  return dbGetMortgageSnapshots(mortgageId);
}

export async function cachedGetMortgageActuals(mortgageId: string): Promise<MortgageActualEntry[]> {
  'use cache';
  cacheTag('all-data', `mortgage:${mortgageId}:actuals`);
  cacheLife('indefinite');
  return dbGetMortgageActuals(mortgageId);
}

/**
 * Fetch everything needed to project one mortgage in a single cached call.
 * Returns null if the mortgage no longer exists.
 */
export async function cachedGetMortgageProjectionData(mortgageId: string): Promise<{
  mortgage: SharedMortgage;
  rates: MortgageRateEntry[];
  costs: MortgageCostEntry[];
  extraPayments: MortgageExtraPayment[];
  snapshots: MortgageBalanceSnapshot[];
  actuals: MortgageActualEntry[];
} | null> {
  'use cache';
  cacheTag(
    'all-data',
    `mortgage:${mortgageId}`,
    `mortgage:${mortgageId}:rates`,
    `mortgage:${mortgageId}:costs`,
    `mortgage:${mortgageId}:payments`,
    `mortgage:${mortgageId}:snapshots`,
    `mortgage:${mortgageId}:actuals`
  );
  cacheLife('indefinite');

  const [mortgage, rates, costs, extraPayments, snapshots, actuals] = await Promise.all([
    dbGetMortgageById(mortgageId),
    dbGetMortgageRates(mortgageId),
    dbGetMortgageCosts(mortgageId),
    dbGetMortgageExtraPayments(mortgageId),
    dbGetMortgageSnapshots(mortgageId),
    dbGetMortgageActuals(mortgageId),
  ]);

  if (!mortgage) return null;
  return { mortgage, rates, costs, extraPayments, snapshots, actuals };
}

// ============================================================
// SPLIT GROUPS (shared expense splitting)
// Tags are keyed by groupId so one invalidation reaches every member; only the
// membership list is user-scoped. The summary is tagged separately so balance /
// KPI reads never re-decrypt the expense chunks.
// ============================================================

export async function cachedGetSplitGroupsForUser(userId: string): Promise<SplitGroup[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}:split-groups`);
  cacheLife('indefinite');
  return dbGetSplitGroupsForUser(userId);
}

export async function cachedGetSplitGroupById(groupId: string): Promise<SplitGroup | null> {
  'use cache';
  cacheTag('all-data', `split-group:${groupId}`);
  cacheLife('indefinite');
  return dbGetSplitGroupById(groupId);
}

export async function cachedGetSplitGroupSummary(groupId: string): Promise<SplitGroupSummary> {
  'use cache';
  cacheTag('all-data', `split-group:${groupId}:summary`);
  cacheLife('indefinite');
  return dbGetSplitGroupSummary(groupId);
}

export async function cachedGetSplitExpenseMonths(groupId: string): Promise<string[]> {
  'use cache';
  cacheTag('all-data', `split-group:${groupId}:expenses`);
  cacheLife('indefinite');
  return dbGetExpenseMonths(groupId);
}

export async function cachedGetSplitExpensesForMonths(groupId: string, months: string[]): Promise<SplitExpense[]> {
  'use cache';
  cacheTag('all-data', `split-group:${groupId}:expenses`);
  cacheLife('indefinite');
  return dbGetExpensesForMonths(groupId, months);
}

export async function cachedGetAllSplitExpenses(groupId: string): Promise<SplitExpense[]> {
  'use cache';
  cacheTag('all-data', `split-group:${groupId}:expenses`);
  cacheLife('indefinite');
  return dbGetAllExpenses(groupId);
}

// ============================================================
// ENABLE BANKING (PSD2 AIS)
// All reads here are cache-first: the UI only ever reads these wrappers; the
// bank API is touched solely by the background sync + "Refresh now". The live
// session secret is NEVER cached (read directly via the db layer).
// ============================================================

export async function cachedGetBankConnections(userId: string): Promise<BankConnection[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:bank-connections`);
  // 'synced': refreshed by the background scheduler, whose tag invalidation is
  // swallowed (no request scope). See the 'synced' profile in next.config.ts.
  cacheLife('synced');
  return getBankConnections(userId);
}

export async function cachedGetBankConnectionById(
  userId: string,
  connectionId: string
): Promise<BankConnection | null> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:bank-connections`,
    `user:${userId}:bank-connection:${connectionId}`
  );
  cacheLife('synced'); // background-synced — see next.config.ts
  return getBankConnectionById(userId, connectionId);
}

export async function cachedGetBankTransactions(
  userId: string,
  linkedAccountId: string
): Promise<BankTransaction[]> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:bank-account:${linkedAccountId}:transactions`
  );
  cacheLife('synced'); // background-synced — see next.config.ts
  return getBankTransactions(userId, linkedAccountId);
}

export async function cachedGetBankSyncRuns(
  userId: string,
  connectionId: string
): Promise<BankSyncRun[]> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:bank-connection:${connectionId}:runs`);
  cacheLife('synced'); // background-synced — see next.config.ts
  return getBankSyncRuns(userId, connectionId);
}

export async function cachedGetLatestBankSyncRun(
  userId: string,
  connectionId: string
): Promise<BankSyncRun | null> {
  'use cache';
  cacheTag('all-data', `user:${userId}`, `user:${userId}:bank-connection:${connectionId}:runs`);
  cacheLife('synced'); // background-synced — see next.config.ts
  return getLatestBankSyncRun(userId, connectionId);
}

// ============================================================
// BATCH READS — reduce waterfall for page-level data fetching
// ============================================================

/**
 * Fetch all data needed to compute cashflow projection for one account.
 * Called from the projection server action.
 */
export async function cachedGetAccountProjectionData(
  userId: string,
  accountId: string
): Promise<{
  recurringItems: RecurringItem[];
  plannedItems: PlannedItem[];
  salaryConfigs: SalaryConfig[];
  taxedIncomes: TaxedIncome[];
}> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:account:${accountId}:recurring`,
    `user:${userId}:account:${accountId}:planned`,
    `user:${userId}:account:${accountId}:salary`,
    `user:${userId}:account:${accountId}:taxed-income`
  );
  cacheLife('indefinite');

  const [recurringItems, plannedItems, salaryConfigs, taxedIncomes] = await Promise.all([
    getRecurringItems(userId, accountId),
    getPlannedItems(userId, accountId),
    getSalaryConfigs(userId, accountId),
    getTaxedIncomes(userId, accountId),
  ]);

  return { recurringItems, plannedItems, salaryConfigs, taxedIncomes };
}

/**
 * Fetch all wealth-related data (investments + debts + receivables)
 * with nested details, in a single cached call.
 */
export async function cachedGetWealthData(userId: string): Promise<{
  investments: Array<InvestmentAccount & { contributions: InvestmentContribution[] }>;
  debts: Array<Debt & { referenceRates: DebtReferenceRate[]; extraPayments: DebtExtraPayment[] }>;
  receivables: Array<Receivable & { repayments: ReceivableRepayment[] }>;
}> {
  'use cache';
  cacheTag(
    'all-data',
    `user:${userId}`,
    `user:${userId}:investments`,
    `user:${userId}:debts`,
    `user:${userId}:receivables`
  );
  cacheLife('indefinite');

  const [rawInvestments, rawDebts, rawReceivables] = await Promise.all([
    getInvestmentAccounts(userId),
    getDebts(userId),
    getReceivables(userId),
  ]);

  // Fetch nested data in parallel
  const [investmentDetails, debtDetails, receivableDetails] = await Promise.all([
    Promise.all(
      rawInvestments.map(async (inv) => ({
        ...inv,
        contributions: await getContributions(userId, inv.id),
      }))
    ),
    Promise.all(
      rawDebts.map(async (debt) => {
        const [referenceRates, extraPayments] = await Promise.all([
          getReferenceRates(userId, debt.id),
          getExtraPayments(userId, debt.id),
        ]);
        return { ...debt, referenceRates, extraPayments };
      })
    ),
    Promise.all(
      rawReceivables.map(async (rec) => ({
        ...rec,
        repayments: await getRepayments(userId, rec.id),
      }))
    ),
  ]);

  return {
    investments: investmentDetails,
    debts: debtDetails,
    receivables: receivableDetails,
  };
}
