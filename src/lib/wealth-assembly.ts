'use client';

/**
 * Client-side assembly of the full wealth projection: fetches every input the
 * engine needs (accounts + cash projections, investments + contributions,
 * receivables + repayments, debts + rates/extra payments, latest snapshots,
 * shared-mortgage projections, card liabilities, split net) via server actions
 * and runs `calculateWealthProjection`. Mirrors the Overview page's assembly so
 * other consumers (e.g. net-worth goals) can't drift from what Overview shows.
 */

import { getAccounts } from '@/lib/actions/accounts';
import { getInvestmentAccounts, getContributions } from '@/lib/actions/investments';
import { getReceivables, getRepayments } from '@/lib/actions/receivables';
import { getDebts, getReferenceRates, getExtraPayments } from '@/lib/actions/debts';
import { getMyMortgages, getMortgageProjectionInputs } from '@/lib/actions/shared-mortgages';
import { getProjection } from '@/lib/actions/projection';
import { getLatestSnapshot } from '@/lib/actions/reconciliation';
import { getCardLiabilities } from '@/lib/actions/bank';
import { getMySplitNetBalance } from '@/lib/actions/split-groups';
import { calculateWealthProjection, getLatestEndDate } from '@/lib/wealth-projection';
import { calculateMortgageProjection } from '@/lib/mortgage-projection';
import type {
  FinancialAccount,
  InvestmentAccount,
  InvestmentContribution,
  Receivable,
  ReceivableRepayment,
  Debt,
  DebtReferenceRate,
  DebtExtraPayment,
  MonthlyProjection,
  BalanceSnapshot,
  MortgageProjectionMonth,
  WealthProjectionMonth,
} from '@/types';

export async function fetchWealthProjectionMonths(
  currentUserId: string | undefined,
  horizonMonths = 60
): Promise<WealthProjectionMonth[]> {
  const [accountsRes, investmentsRes, receivablesRes, debtsRes, mortgagesRes, cardLiabRes, splitRes] =
    await Promise.all([
      getAccounts(),
      getInvestmentAccounts(),
      getReceivables(),
      getDebts(),
      getMyMortgages(),
      getCardLiabilities(),
      getMySplitNetBalance(),
    ]);

  const activeAccounts = accountsRes.success && accountsRes.data
    ? accountsRes.data.filter((a: FinancialAccount) => !a.isArchived)
    : [];
  const activeInvestments = investmentsRes.success && investmentsRes.data
    ? investmentsRes.data.filter((i: InvestmentAccount) => !i.isArchived)
    : [];
  const activeReceivables = receivablesRes.success && receivablesRes.data
    ? receivablesRes.data.filter((r: Receivable) => !r.isArchived)
    : [];
  const activeDebts = debtsRes.success && debtsRes.data
    ? debtsRes.data.filter((d: Debt) => !d.isArchived)
    : [];

  const [contributionsResults, repaymentsResults, ratesResults, extraPaymentsResults, cashProjectionsResults, investmentSnapshotResults, receivableSnapshotResults, debtSnapshotResults] = await Promise.all([
    Promise.all(activeInvestments.map((inv) => getContributions(inv.id).then(r => [inv.id, r.success && r.data ? r.data : []] as [string, InvestmentContribution[]]))),
    Promise.all(activeReceivables.map((rec) => getRepayments(rec.id).then(r => [rec.id, r.success && r.data ? r.data : []] as [string, ReceivableRepayment[]]))),
    Promise.all(activeDebts.map((d) => getReferenceRates(d.id).then(r => [d.id, r.success && r.data ? r.data : []] as [string, DebtReferenceRate[]]))),
    Promise.all(activeDebts.map((d) => getExtraPayments(d.id).then(r => [d.id, r.success && r.data ? r.data : []] as [string, DebtExtraPayment[]]))),
    Promise.all(activeAccounts.map((a) => getProjection(a.id).then(r => [a.id, r.success && r.data ? r.data.monthly : []] as [string, MonthlyProjection[]]))),
    Promise.all(activeInvestments.map((inv) => getLatestSnapshot('investment', inv.id).then(r => [inv.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
    Promise.all(activeReceivables.map((rec) => getLatestSnapshot('receivable', rec.id).then(r => [rec.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
    Promise.all(activeDebts.map((d) => getLatestSnapshot('debt', d.id).then(r => [d.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
  ]);

  const now = new Date();
  const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const mortgageProjections: MortgageProjectionMonth[][] = [];
  const mortgageNames: string[] = [];

  const wealthData = {
    cashAccounts: activeAccounts,
    cashProjections: new Map<string, MonthlyProjection[]>(cashProjectionsResults),
    investments: activeInvestments,
    investmentContributions: new Map<string, InvestmentContribution[]>(contributionsResults),
    receivables: activeReceivables,
    receivableRepayments: new Map<string, ReceivableRepayment[]>(repaymentsResults),
    debts: activeDebts,
    debtReferenceRates: new Map<string, DebtReferenceRate[]>(ratesResults),
    debtExtraPayments: new Map<string, DebtExtraPayment[]>(extraPaymentsResults),
    investmentSnapshots: new Map<string, BalanceSnapshot | null>(investmentSnapshotResults),
    receivableSnapshots: new Map<string, BalanceSnapshot | null>(receivableSnapshotResults),
    debtSnapshots: new Map<string, BalanceSnapshot | null>(debtSnapshotResults),
    mortgageProjections,
    mortgageNames,
    currentUserId,
    cardLiabilities: cardLiabRes.success && cardLiabRes.data ? cardLiabRes.data : [],
    splitNetTotal: splitRes.success && splitRes.data ? splitRes.data.netCents / 100 : 0,
  };

  const endDate = getLatestEndDate(wealthData, horizonMonths);

  const activeMortgages = mortgagesRes.success && mortgagesRes.data
    ? mortgagesRes.data.filter((m) => !m.isArchived)
    : [];
  if (activeMortgages.length > 0) {
    const inputs = await Promise.all(activeMortgages.map((m) => getMortgageProjectionInputs(m.id)));
    inputs.forEach((res, idx) => {
      if (res.success && res.data) {
        mortgageProjections.push(calculateMortgageProjection(res.data, endDate));
        mortgageNames.push(activeMortgages[idx].name);
      }
    });
  }

  return calculateWealthProjection(wealthData, startDate, endDate);
}
