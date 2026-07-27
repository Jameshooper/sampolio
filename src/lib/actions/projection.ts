'use server';

import { auth } from '@/lib/auth';
import {
  calculateProjection,
  calculateYearlyRollups,
  getUniqueCategories,
  resolveAnchor,
} from '@/lib/projection';
import {
  gatherProjectionInputs,
  computeCardBillTransfersForAccount,
  getLinkedCashBankTransactions,
  getCardPaymentSourcesForAccount,
} from '@/lib/projection-inputs';
import { calculateRetrospective } from '@/lib/retrospective';
import type {
  ApiResponse,
  MonthlyProjection,
  YearlyRollup,
  ProjectionFilters,
  SalaryConfig,
  TaxedIncome,
  FinancialAccount,
  BalanceSnapshot,
} from '@/types';

interface ProjectionResponse {
  monthly: MonthlyProjection[];
  // Past months reconstructed purely from real booked bank transactions (no
  // Sampolio forecast items). Empty unless a bank cash/savings account is linked
  // and has synced data. Rendered to the LEFT of `monthly` on the cashflow page.
  retrospective: MonthlyProjection[];
  yearly: YearlyRollup[];
  categories: string[];
  salaryConfigs: SalaryConfig[];
  // Full taxed-income entities for the selected account — the cashflow page
  // uses them to draw the gross→deductions Sankey for `source: 'taxed-income'`.
  taxedIncomes: TaxedIncome[];
  account: {
    id: string;
    name: string;
    currency: string;
    startingBalance: number;
    startingDate: string;
  };
}

export async function getProjection(
  accountId: string,
  filters?: ProjectionFilters
): Promise<ApiResponse<ProjectionResponse>> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { success: false, error: 'Unauthorized' };
    }

    // Account, items, anchor snapshot, and the injected mortgage/budget
    // transfer lines — shared with the scenario action via projection-inputs.
    const inputs = await gatherProjectionInputs(session.user.id, accountId);
    if (!inputs) {
      return { success: false, error: 'Account not found' };
    }
    const {
      account,
      recurringItems,
      plannedItems,
      salaryConfigs,
      taxedIncomes,
      latestSnapshot,
      mortgageTransfers,
      budgetTransfers,
      goalTransfers,
      tripTransfers,
      currentMonthActuals,
      directRecurring,
      directPlanned,
    } = inputs;

    // Computed read-only credit-card bill lines (from the FULL item lists —
    // tagged card spend feeds the forecast cycles) plus the bank-actuals
    // retrospective.
    const [cardBillTransfers, retrospective] = await Promise.all([
      computeCardBillTransfersForAccount(session.user.id, accountId, account, recurringItems, plannedItems),
      getRetrospectiveForAccount(session.user.id, accountId, account, latestSnapshot),
    ]);

    const monthly = calculateProjection(account, directRecurring, directPlanned, taxedIncomes, filters, latestSnapshot, mortgageTransfers, budgetTransfers, cardBillTransfers, currentMonthActuals, goalTransfers, tripTransfers);
    const yearly = calculateYearlyRollups(monthly);
    const categories = getUniqueCategories(recurringItems, plannedItems);

    return {
      success: true,
      data: {
        monthly,
        retrospective,
        yearly,
        categories,
        salaryConfigs,
        taxedIncomes,
        account: {
          id: account.id,
          name: account.name,
          currency: account.currency,
          startingBalance: account.startingBalance,
          startingDate: account.startingDate,
        },
      },
    };
  } catch (error) {
    console.error('Get projection error:', error);
    return { success: false, error: 'Failed to calculate projection' };
  }
}

/**
 * Reconstruct up to `RETROSPECTIVE_MONTHS_BACK` (24) past months purely from
 * real booked bank transactions for
 * the cash/savings bank accounts that anchor this cash account. These sit to the
 * LEFT of the forecast on the cashflow page. Returns [] when no bank cash/savings
 * account is linked (so non-bank accounts are unaffected) or when there's no
 * usable history. A bank problem must never break the core cashflow projection.
 */
async function getRetrospectiveForAccount(
  userId: string,
  accountId: string,
  account: FinancialAccount,
  latestSnapshot: BalanceSnapshot | null
): Promise<MonthlyProjection[]> {
  try {
    const [transactions, cardPayments] = await Promise.all([
      getLinkedCashBankTransactions(userId, accountId),
      getCardPaymentSourcesForAccount(userId, accountId),
    ]);
    if (transactions.length === 0) return [];

    const anchor = resolveAnchor(account.startingDate, account.startingBalance, latestSnapshot);
    return calculateRetrospective({
      accountId,
      transactions,
      anchor,
      cardPayments,
    });
  } catch (error) {
    console.error('Retrospective reconstruction failed:', error);
    return [];
  }
}
