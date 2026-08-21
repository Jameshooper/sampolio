'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { SelectButton } from 'primereact/selectbutton';
import { KpiGridSkeleton } from '@/components/ui/skeletons';
import { Tag } from 'primereact/tag';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { getAccounts } from '@/lib/actions/accounts';
import { getInvestmentAccounts, getContributions } from '@/lib/actions/investments';
import { getReceivables, getRepayments } from '@/lib/actions/receivables';
import { getDebts, getReferenceRates, getExtraPayments } from '@/lib/actions/debts';
import { getMyMortgages, getMortgageProjectionInputs } from '@/lib/actions/shared-mortgages';
import { getProjection } from '@/lib/actions/projection';
import { getLatestCompletedSession, getLatestSnapshot } from '@/lib/actions/reconciliation';
import { calculateWealthProjection, getLatestEndDate } from '@/lib/wealth-projection';
import { calculateMortgageProjection } from '@/lib/mortgage-projection';
import { isEuriborUpdateDue } from '@/lib/mortgage-utils';
import { addMonths, compareYearMonths } from '@/lib/projection';
import { getBudgets } from '@/lib/actions/budgets';
import { getBankConnectionsNeedingAttention, getCardLiabilities, type ConnectionAttention } from '@/lib/actions/bank';
import { getMySplitNetBalance } from '@/lib/actions/split-groups';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { computeActualsRollup } from '@/lib/budget-utils';
import type { FinancialAccount, InvestmentAccount, Receivable, Debt, TimeHorizon, WealthProjectionMonth, Currency, InvestmentContribution, ReceivableRepayment, DebtReferenceRate, DebtExtraPayment, MonthlyProjection, BalanceSnapshot, MortgageProjectionMonth, Budget } from '@/types';
import { NetWorthChart, WealthChart } from '@/components/charts';
import { EntityListDrawer } from '@/components/ui/entity-list-drawer';
import { StatusHeroCard } from '@/components/ui/status-hero-card';
import { KpiTile } from '@/components/ui/kpi-tile';
import { BannerStack, isCheckInBannerVisible } from '@/components/overview/banner-stack';
import { KpiGroup } from '@/components/overview/kpi-group';
import { NetWorthExplainDialog } from '@/components/overview/net-worth-explain-dialog';
import { WealthDistribution } from '@/components/overview/wealth-distribution';
import { plainTerm, helpText } from '@/lib/plain-language';
import { PlanCheckCard } from '@/components/overview/forecast-vs-actual-card';
import { MdSync, MdShowChart, MdEuro, MdAccountBalanceWallet, MdBarChart, MdGroup, MdCreditCard, MdArrowForward, MdAddCircle, MdRemoveCircle, MdHouse, MdHomeWork } from 'react-icons/md';

type EntityCategory = 'cash' | 'investments' | 'receivables' | 'debts';

/** Derive the display currency from the primary (first non-archived) account, default EUR */
function getPrimaryCurrency(accounts: FinancialAccount[]): Currency {
    const primary = accounts.find(a => !a.isArchived);
    return primary?.currency ?? 'EUR';
}

/** Check if accounts span multiple currencies */
function hasMixedCurrencies(accounts: FinancialAccount[]): boolean {
    const currencies = new Set(accounts.filter(a => !a.isArchived).map(a => a.currency));
    return currencies.size > 1;
}

const HORIZON_OPTIONS = [
    { label: '6M', value: '6m' },
    { label: '1Y', value: '1y' },
    { label: '3Y', value: '3y' },
    { label: '5Y', value: '5y' },
];

const SCOPE_OPTIONS = [
    { label: 'Total assets', value: 'total' },
    { label: 'Liquid', value: 'liquid' },
];

export default function OverviewPage() {
    const router = useRouter();
    const { data: session } = useSession();
    const appContext = useAppContext();
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const [isLoading, setIsLoading] = useState(true);
    const [horizon, setHorizon] = useState<TimeHorizon>('1y');
    const [showBreakdown, setShowBreakdown] = useState(true);
    // 'total' folds in mortgage equity/split balance; 'liquid' is cash + investments only.
    const [wealthScope, setWealthScope] = useState<'liquid' | 'total'>('total');
    // Simple mode: the grouped KPI grid stays collapsed behind "See all balances".
    const [showAllKpis, setShowAllKpis] = useState(false);
    const [entityDrawer, setEntityDrawer] = useState<{ visible: boolean; category: EntityCategory }>({ visible: false, category: 'cash' });
    // Plain-words net-worth breakdown, opened by tapping the Net Worth KPI.
    const [explainNetWorthVisible, setExplainNetWorthVisible] = useState(false);
    const displayMode = appContext?.displayMode ?? 'advanced';
    const isSimple = displayMode === 'simple';

    // Data states
    const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
    const [investments, setInvestments] = useState<InvestmentAccount[]>([]);
    const [receivables, setReceivables] = useState<Receivable[]>([]);
    const [debts, setDebts] = useState<Debt[]>([]);
    const [projection, setProjection] = useState<WealthProjectionMonth[]>([]);
    const [lastReconciled, setLastReconciled] = useState<string | null>(null);
    // The logged-in member's slice of any shared mortgage(s), for the current month.
    const [mortgageSummary, setMortgageSummary] = useState<{ equity: number; liability: number; stake: number } | null>(null);
    // Set when a mortgage's yearly Euribor rate is due for an update (drives the reminder banner).
    const [euriborDue, setEuriborDue] = useState<{ name: string; lastResetDate: Date } | null>(null);
    const [bankAttention, setBankAttention] = useState<ConnectionAttention[]>([]);
    const [cardLiabilitiesTotal, setCardLiabilitiesTotal] = useState(0);
    // Available credit vs total limit across cards (null when no limits known).
    const [cardCredit, setCardCredit] = useState<{ available: number; limit: number } | null>(null);
    // Logged-in user's net split balance (Splitwise replacement), in display currency.
    const [splitNetTotal, setSplitNetTotal] = useState(0);
    // Per-account current cash balance: bank snapshot when synced, else manual start.
    const [cashCurrentBalances, setCashCurrentBalances] = useState<Map<string, number>>(new Map());
    // At most one budget reminder: an over-budget category beats an upcoming trip.
    const [budgetBanner, setBudgetBanner] = useState<{ type: 'upcoming' | 'over-budget'; budget: Budget; category?: string } | null>(null);
    // User preference: show the "time to check in" reminder banner (default on).
    const [checkInRemindersEnabled, setCheckInRemindersEnabled] = useState(true);
    // Primary account's plan + bank-actual history, for the "Plan check" card.
    const [planCheck, setPlanCheck] = useState<{ monthly: MonthlyProjection[]; retrospective: MonthlyProjection[] } | null>(null);

    const userId = session?.user?.id;

    const displayCurrency = useMemo(() => getPrimaryCurrency(accounts), [accounts]);
    const isMixedCurrency = useMemo(() => hasMixedCurrencies(accounts), [accounts]);

    const hasLoadedOnce = useRef(false);

    const fetchData = useCallback(async () => {
        if (!hasLoadedOnce.current) {
            setIsLoading(true);
        }
        try {
            const [accountsRes, investmentsRes, receivablesRes, debtsRes, sessionRes, mortgagesRes, budgetsRes, cardLiabRes, splitRes, prefsRes] = await Promise.all([
                getAccounts(),
                getInvestmentAccounts(),
                getReceivables(),
                getDebts(),
                getLatestCompletedSession(),
                getMyMortgages(),
                getBudgets(),
                getCardLiabilities(),
                getMySplitNetBalance(),
                getUserPreferences(),
            ]);
            setCheckInRemindersEnabled(prefsRes.success && prefsRes.data ? prefsRes.data.checkInRemindersEnabled !== false : true);
            const splitNet = splitRes.success && splitRes.data ? splitRes.data.netCents / 100 : 0;
            setSplitNetTotal(splitNet);

            // Budget reminders: an over-budget category on an active confirmed
            // budget, or a confirmed budget starting this/next month.
            {
                const now = new Date();
                const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                const confirmed = budgetsRes.success && budgetsRes.data
                    ? budgetsRes.data.filter((b) => b.status === 'confirmed' && !b.isArchived)
                    : [];
                let banner: { type: 'upcoming' | 'over-budget'; budget: Budget; category?: string } | null = null;
                for (const b of confirmed) {
                    const isActive = compareYearMonths(b.startMonth, cur) <= 0 && compareYearMonths(cur, b.endMonth) <= 0;
                    if (isActive) {
                        const over = computeActualsRollup(b).perCategory.find((c) => c.planned > 0 && c.actual > c.planned);
                        if (over) { banner = { type: 'over-budget', budget: b, category: over.category }; break; }
                    }
                }
                if (!banner) {
                    const next = addMonths(cur, 1);
                    const upcoming = confirmed.find((b) => b.startMonth === cur || b.startMonth === next);
                    if (upcoming && compareYearMonths(cur, upcoming.endMonth) <= 0) banner = { type: 'upcoming', budget: upcoming };
                }
                setBudgetBanner(banner);
            }

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

            setAccounts(activeAccounts);
            setInvestments(activeInvestments);
            setReceivables(activeReceivables);
            setDebts(activeDebts);

            if (sessionRes.success && sessionRes.data) {
                setLastReconciled(sessionRes.data.yearMonth);
            }

            // Fetch sub-data for wealth projection in parallel
            const [contributionsResults, repaymentsResults, ratesResults, extraPaymentsResults, cashProjectionsResults, investmentSnapshotResults, receivableSnapshotResults, debtSnapshotResults, cashSnapshotResults] = await Promise.all([
                Promise.all(activeInvestments.map((inv: InvestmentAccount) => getContributions(inv.id).then(r => [inv.id, r.success && r.data ? r.data : []] as [string, InvestmentContribution[]]))),
                Promise.all(activeReceivables.map((rec: Receivable) => getRepayments(rec.id).then(r => [rec.id, r.success && r.data ? r.data : []] as [string, ReceivableRepayment[]]))),
                Promise.all(activeDebts.map((d: Debt) => getReferenceRates(d.id).then(r => [d.id, r.success && r.data ? r.data : []] as [string, DebtReferenceRate[]]))),
                Promise.all(activeDebts.map((d: Debt) => getExtraPayments(d.id).then(r => [d.id, r.success && r.data ? r.data : []] as [string, DebtExtraPayment[]]))),
                Promise.all(activeAccounts.map((a: FinancialAccount) => getProjection(a.id).then(r => [a.id, {
                    monthly: r.success && r.data ? r.data.monthly : [],
                    retrospective: r.success && r.data ? (r.data.retrospective ?? []) : [],
                }] as [string, { monthly: MonthlyProjection[]; retrospective: MonthlyProjection[] }]))),
                Promise.all(activeInvestments.map((inv: InvestmentAccount) => getLatestSnapshot('investment', inv.id).then(r => [inv.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
                Promise.all(activeReceivables.map((rec: Receivable) => getLatestSnapshot('receivable', rec.id).then(r => [rec.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
                Promise.all(activeDebts.map((d: Debt) => getLatestSnapshot('debt', d.id).then(r => [d.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
                Promise.all(activeAccounts.map((a: FinancialAccount) => getLatestSnapshot('cash-account', a.id).then(r => [a.id, r.success && r.data ? r.data : null] as [string, BalanceSnapshot | null]))),
            ]);

            const investmentContributions = new Map<string, InvestmentContribution[]>(contributionsResults);
            const receivableRepayments = new Map<string, ReceivableRepayment[]>(repaymentsResults);
            const debtReferenceRates = new Map<string, DebtReferenceRate[]>(ratesResults);
            const debtExtraPayments = new Map<string, DebtExtraPayment[]>(extraPaymentsResults);
            const cashProjections = new Map<string, MonthlyProjection[]>(
                cashProjectionsResults.map(([id, p]) => [id, p.monthly] as [string, MonthlyProjection[]])
            );
            // The "Plan check" card compares the primary account's plan against
            // its bank-actual history.
            const primaryAccountId: string | undefined = activeAccounts[0]?.id;
            setPlanCheck(
                (primaryAccountId ? cashProjectionsResults.find(([id]) => id === primaryAccountId)?.[1] : undefined) ?? null
            );
            const investmentSnapshots = new Map<string, BalanceSnapshot | null>(investmentSnapshotResults);
            const receivableSnapshots = new Map<string, BalanceSnapshot | null>(receivableSnapshotResults);
            const debtSnapshots = new Map<string, BalanceSnapshot | null>(debtSnapshotResults);
            // Latest real balance per cash account (bank-sync snapshot when available,
            // else a manual reconciliation) — used as the account's current value so
            // the bank balance supersedes the manually-entered starting value.
            const cashSnapshots = new Map<string, BalanceSnapshot | null>(cashSnapshotResults);
            setCashCurrentBalances(
                new Map(activeAccounts.map((a: FinancialAccount) => [a.id, cashSnapshots.get(a.id)?.actualBalance ?? a.startingBalance] as [string, number]))
            );

            const now = new Date();
            const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

            // Shared mortgages the logged-in member belongs to: project each and fold
            // the member's equity (asset) and loan-share (liability) into net worth.
            const activeMortgages = mortgagesRes.success && mortgagesRes.data
                ? mortgagesRes.data.filter((m) => !m.isArchived)
                : [];
            const mortgageProjections: MortgageProjectionMonth[][] = [];
            const mortgageNames: string[] = [];

            const wealthData = {
                cashAccounts: activeAccounts,
                cashProjections,
                investments: activeInvestments,
                investmentContributions,
                receivables: activeReceivables,
                receivableRepayments,
                debts: activeDebts,
                debtReferenceRates,
                debtExtraPayments,
                investmentSnapshots,
                receivableSnapshots,
                debtSnapshots,
                mortgageProjections,
                mortgageNames,
                currentUserId: userId,
                cardLiabilities: cardLiabRes.success && cardLiabRes.data ? cardLiabRes.data : [],
                splitNetTotal: splitNet,
            };
            setCardLiabilitiesTotal(
                cardLiabRes.success && cardLiabRes.data
                    ? cardLiabRes.data.reduce((s, c) => s + c.outstanding, 0)
                    : 0
            );
            // Available credit vs total limit across cards (only cards where the
            // bank exposes a limit contribute, so the ratio stays meaningful).
            if (cardLiabRes.success && cardLiabRes.data) {
                const withLimit = cardLiabRes.data.filter((c) => typeof c.creditLimit === 'number' && c.creditLimit! > 0);
                const limit = withLimit.reduce((s, c) => s + (c.creditLimit ?? 0), 0);
                const available = withLimit.reduce(
                    (s, c) => s + (c.availableCredit ?? Math.max(0, (c.creditLimit ?? 0) - c.outstanding)),
                    0
                );
                setCardCredit(limit > 0 ? { available, limit } : null);
            } else {
                setCardCredit(null);
            }

            const endDate = getLatestEndDate(wealthData, 60);

            let dueBanner: { name: string; lastResetDate: Date } | null = null;
            if (activeMortgages.length > 0) {
                const inputs = await Promise.all(
                    activeMortgages.map((m) => getMortgageProjectionInputs(m.id))
                );
                inputs.forEach((res, idx) => {
                    if (res.success && res.data) {
                        mortgageProjections.push(calculateMortgageProjection(res.data, endDate));
                        mortgageNames.push(activeMortgages[idx].name);
                        // Surface a reminder if this mortgage's yearly Euribor reset is due.
                        const due = isEuriborUpdateDue(res.data.mortgage, res.data.rates);
                        if (due.due && !dueBanner) dueBanner = { name: activeMortgages[idx].name, lastResetDate: due.lastResetDate };
                    }
                });
            }
            setEuriborDue(dueBanner);

            const projectionMonths = calculateWealthProjection(wealthData, startDate, endDate);
            setProjection(projectionMonths);

            // Current-month mortgage slice for the logged-in member (drives the KPIs + net worth).
            if (mortgageProjections.length > 0 && userId) {
                let equity = 0, liability = 0, stake = 0;
                for (const proj of mortgageProjections) {
                    const row = proj.find((p) => p.yearMonth === startDate) ?? proj[proj.length - 1];
                    const pos = row?.members.find((p) => p.userId === userId);
                    if (pos) { equity += pos.equity; liability += pos.liability; stake += pos.stake; }
                }
                setMortgageSummary({ equity, liability, stake });
            } else {
                setMortgageSummary(null);
            }
        } catch (err) {
            console.error('Failed to fetch data:', err);
        } finally {
            if (!hasLoadedOnce.current) {
                hasLoadedOnce.current = true;
                setIsLoading(false);
            }
        }
    }, [userId]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    // Bank consent-expiry check (cheap, cache-first) — feeds the reconnect banner.
    useEffect(() => {
        getBankConnectionsNeedingAttention().then((res) => {
            if (res.success && res.data) setBankAttention(res.data);
        });
    }, []);

    // Register refresh callback
    useEffect(() => {
        if (appContext) {
            appContext.setRefreshCallback(fetchData);
        }
    }, [appContext, fetchData]);

    // Current month
    const currentYearMonth = useMemo(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }, []);

    // While the check-in reminder banner shows, it is the single check-in entry
    // point — the header button hides to avoid duplicate affordances.
    const checkInBannerVisible = isCheckInBannerVisible(checkInRemindersEnabled, lastReconciled, currentYearMonth);

    // Filter projection based on horizon
    const filteredProjection = useMemo(() => {
        const now = new Date();
        let endDate: Date;

        switch (horizon) {
            case '6m':
                endDate = new Date(now.getFullYear(), now.getMonth() + 6, 1);
                break;
            case '1y':
                endDate = new Date(now.getFullYear() + 1, now.getMonth(), 1);
                break;
            case '3y':
                endDate = new Date(now.getFullYear() + 3, now.getMonth(), 1);
                break;
            case '5y':
                endDate = new Date(now.getFullYear() + 5, now.getMonth(), 1);
                break;
            default:
                endDate = new Date(now.getFullYear() + 1, now.getMonth(), 1);
        }

        const endYearMonth = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}`;
        return projection.filter(p => p.yearMonth <= endYearMonth);
    }, [projection, horizon]);

    // Calculate KPI values
    const kpiValues = useMemo(() => {
        const prevMonth = projection.find(p => {
            const [year, month] = currentYearMonth.split('-').map(Number);
            const prevDate = new Date(year, month - 2, 1);
            return p.yearMonth === `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
        });
        const endMonth = filteredProjection[filteredProjection.length - 1];

        // Prefer the latest real balance (bank sync / reconciliation) over the
        // manually-entered starting value, so the bank value is the source of truth.
        const cashTotal = accounts.reduce((sum, a) => sum + (cashCurrentBalances.get(a.id) ?? a.startingBalance), 0);
        const investmentsTotal = investments.reduce((sum, i) => sum + (i.currentValuation || i.startingValuation), 0);
        const receivablesTotal = receivables.reduce((sum, r) => sum + r.currentBalance, 0);
        const debtsTotal = debts.reduce((sum, d) => sum + d.initialPrincipal, 0);

        // Member's home equity (stake − loan-share liability) adds to net worth.
        const mortgageEquity = mortgageSummary?.equity ?? 0;
        const mortgageLiability = mortgageSummary?.liability ?? 0;

        // Linked credit-card outstanding is a real liability (read live from the bank).
        // Split balance (Splitwise replacement) adds when owed, subtracts when owing.
        const netWorth = cashTotal + investmentsTotal + receivablesTotal - debtsTotal - cardLiabilitiesTotal + mortgageEquity + splitNetTotal;
        const prevNetWorth = prevMonth?.netWorth || netWorth;
        const projectedNetWorth = endMonth?.netWorth || netWorth;

        const liquidAssets = cashTotal + investmentsTotal;

        return {
            netWorth,
            netWorthChange: netWorth - prevNetWorth,
            projectedNetWorth,
            cashTotal,
            investmentsTotal,
            liquidAssets,
            receivablesTotal,
            debtsTotal,
            cardLiabilitiesTotal,
            splitNetTotal,
            mortgageEquity,
            mortgageLiability,
        };
    }, [accounts, investments, receivables, debts, projection, currentYearMonth, filteredProjection, mortgageSummary, cardLiabilitiesTotal, splitNetTotal, cashCurrentBalances]);

    // Hero card projections: find current and previous month from the first account's cash projection
    const heroProjections = useMemo(() => {
        if (projection.length === 0) return { current: undefined, previous: undefined };
        // Use the wealth projection's cash totals to approximate per-month data
        const currentMonth = projection.find(p => p.yearMonth === currentYearMonth);
        const prevMonthDate = new Date();
        prevMonthDate.setMonth(prevMonthDate.getMonth() - 1);
        const prevYM = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
        const prevMonth = projection.find(p => p.yearMonth === prevYM);
        return { current: currentMonth, previous: prevMonth };
    }, [projection, currentYearMonth]);

    // Utilization ratio for the credit-card KPI's progress bar; drives its
    // color (green/yellow/red) independently of the tile's own `severity`.
    const cardUtilization = cardCredit ? (cardCredit.limit - cardCredit.available) / cardCredit.limit : null;

    if (isLoading) {
        return <KpiGridSkeleton />;
    }

    return (
        <div className="space-y-4 lg:space-y-6 max-w-360 mx-auto py-4 lg:py-8">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                    <h1 className={`text-3xl sm:text-4xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        Overview
                    </h1>
                    {lastReconciled && (
                        <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Last check-in: {formatYearMonth(lastReconciled)}
                        </p>
                    )}
                </div>
                {/* Hidden while the reminder banner shows — the banner is the
                    single entry point then (no duplicate affordances). */}
                {!checkInBannerVisible && (
                    <Button
                        label="Monthly check-in"
                        icon={<MdSync />}
                        severity="success"
                        className="shrink-0 self-start sm:self-auto"
                        onClick={() => appContext?.openReconcile()}
                    />
                )}
            </div>

            <BannerStack
                checkInRemindersEnabled={checkInRemindersEnabled}
                lastReconciled={lastReconciled}
                currentYearMonth={currentYearMonth}
                onStartCheckIn={() => appContext?.openReconcile()}
                euriborDue={euriborDue}
                onUpdateEuribor={() => router.push('/mortgage')}
                bankAttention={bankAttention}
                onReconnectBank={() => router.push('/settings?tab=banking')}
                budgetBanner={budgetBanner}
                onOpenBudget={(id) => router.push(`/budgets/${id}`)}
            />

            {/* Hero Card */}
            <StatusHeroCard
                userName={session?.user?.name || 'there'}
                currentMonthProjection={heroProjections.current ? {
                    yearMonth: currentYearMonth,
                    year: parseInt(currentYearMonth.split('-')[0]),
                    month: parseInt(currentYearMonth.split('-')[1]),
                    startingBalance: heroProjections.current.cashAccountsTotal,
                    totalIncome: 0,
                    totalExpenses: 0,
                    netChange: heroProjections.current.netWorth - (heroProjections.previous?.netWorth ?? heroProjections.current.netWorth),
                    endingBalance: heroProjections.current.cashAccountsTotal,
                    incomeBreakdown: [],
                    expenseBreakdown: [],
                } : undefined}
                previousMonthProjection={heroProjections.previous ? {
                    yearMonth: '',
                    year: 0,
                    month: 0,
                    startingBalance: 0,
                    totalIncome: 0,
                    totalExpenses: 0,
                    netChange: 0,
                    endingBalance: heroProjections.previous.cashAccountsTotal,
                    incomeBreakdown: [],
                    expenseBreakdown: [],
                } : undefined}
                currency={displayCurrency}
            />

            {/* KPI tiles, grouped Net / Assets / Debts & liabilities. Simple mode
                shows just Net Worth + Cash with a "See all" expander. */}
            {isSimple && !showAllKpis && (
                <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-3 sm:gap-4">
                        <KpiTile
                            title={plainTerm('netWorth', isSimple)}
                            help={helpText('netWorth')}
                            value={kpiValues.netWorth}
                            currency={displayCurrency}
                            change={kpiValues.netWorthChange}
                            changeLabel="vs last month"
                            icon={<MdShowChart />}
                            severity="info"
                            onClick={() => setExplainNetWorthVisible(true)}
                        />
                        <KpiTile
                            title="Cash"
                            value={kpiValues.cashTotal}
                            currency={displayCurrency}
                            icon={<MdAccountBalanceWallet />}
                            severity="success"
                            onClick={() => setEntityDrawer({ visible: true, category: 'cash' })}
                        />
                    </div>
                    <div className="text-center">
                        <Button label="See all balances" text size="small" severity="secondary" onClick={() => setShowAllKpis(true)} />
                    </div>
                </div>
            )}
            {(!isSimple || showAllKpis) && (
                <div className={`space-y-4 ${isSimple ? 'animate-fade-in' : ''}`}>
                    <KpiGroup title="Net">
                        <KpiTile
                            title={plainTerm('netWorth', isSimple)}
                            help={helpText('netWorth')}
                            value={kpiValues.netWorth}
                            currency={displayCurrency}
                            change={kpiValues.netWorthChange}
                            changeLabel="vs last month"
                            icon={<MdShowChart />}
                            severity="info"
                            onClick={() => setExplainNetWorthVisible(true)}
                        />
                        <KpiTile
                            title={plainTerm('liquidAssets', isSimple)}
                            help={helpText('liquidAssets')}
                            value={kpiValues.liquidAssets}
                            currency={displayCurrency}
                            icon={<MdEuro />}
                            severity="info"
                        />
                    </KpiGroup>
                    <KpiGroup title="Assets">
                        <KpiTile
                            title="Cash"
                            value={kpiValues.cashTotal}
                            currency={displayCurrency}
                            icon={<MdAccountBalanceWallet />}
                            severity="success"
                            onClick={() => setEntityDrawer({ visible: true, category: 'cash' })}
                        />
                        <KpiTile
                            title="Investments"
                            value={kpiValues.investmentsTotal}
                            currency={displayCurrency}
                            icon={<MdBarChart />}
                            severity="success"
                            onClick={() => setEntityDrawer({ visible: true, category: 'investments' })}
                        />
                        <KpiTile
                            title={plainTerm('receivables', isSimple)}
                            help={helpText('receivables')}
                            value={kpiValues.receivablesTotal}
                            currency={displayCurrency}
                            icon={<MdGroup />}
                            severity="warning"
                            onClick={() => setEntityDrawer({ visible: true, category: 'receivables' })}
                        />
                        {mortgageSummary && (
                            <KpiTile
                                title={plainTerm('homeEquity', isSimple)}
                                help={helpText('homeEquity')}
                                value={kpiValues.mortgageEquity}
                                currency={displayCurrency}
                                icon={<MdHouse />}
                                severity="success"
                                onClick={() => router.push('/mortgage')}
                            />
                        )}
                        {kpiValues.splitNetTotal > 0 && (
                            <KpiTile
                                title="Split balance"
                                help={helpText('splitBalance')}
                                value={kpiValues.splitNetTotal}
                                currency={displayCurrency}
                                icon={<MdGroup />}
                                severity="warning"
                                onClick={() => router.push('/split')}
                            />
                        )}
                    </KpiGroup>
                    <KpiGroup title="Debts & liabilities">
                        <KpiTile
                            title="Debts"
                            value={-kpiValues.debtsTotal}
                            currency={displayCurrency}
                            icon={<MdCreditCard />}
                            severity="danger"
                            onClick={() => setEntityDrawer({ visible: true, category: 'debts' })}
                        />
                        {kpiValues.cardLiabilitiesTotal > 0 && (
                            <KpiTile
                                title={plainTerm('creditCards', isSimple)}
                                help={helpText('creditCards')}
                                value={-kpiValues.cardLiabilitiesTotal}
                                currency={displayCurrency}
                                subline={cardCredit
                                    ? `${formatCurrency(cardCredit.available, displayCurrency)} available of ${formatCurrency(cardCredit.limit, displayCurrency)} limit`
                                    : undefined}
                                progress={cardUtilization ?? undefined}
                                progressSeverity={cardUtilization === null ? undefined : cardUtilization >= 0.8 ? 'danger' : cardUtilization >= 0.5 ? 'warning' : 'success'}
                                icon={<MdCreditCard />}
                                severity="danger"
                                onClick={() => router.push('/bank')}
                            />
                        )}
                        {mortgageSummary && (
                            <KpiTile
                                title="Mortgage (your share)"
                                value={-kpiValues.mortgageLiability}
                                currency={displayCurrency}
                                icon={<MdHomeWork />}
                                severity="danger"
                                onClick={() => router.push('/mortgage')}
                            />
                        )}
                        {kpiValues.splitNetTotal < 0 && (
                            <KpiTile
                                title="Split balance"
                                value={kpiValues.splitNetTotal}
                                currency={displayCurrency}
                                icon={<MdGroup />}
                                severity="danger"
                                onClick={() => router.push('/split')}
                            />
                        )}
                    </KpiGroup>
                </div>
            )}

            {/* Where the wealth currently sits — shown in BOTH display modes
                (deliberately outside the chart grid, which Simple mode hides). */}
            <WealthDistribution
                values={kpiValues}
                currency={displayCurrency}
                isMixedCurrency={isMixedCurrency}
                isSimple={isSimple}
            />

            {/* Main Chart Section */}
            <div className={`grid grid-cols-1 lg:grid-cols-3 gap-6 ${isSimple ? 'hidden' : ''}`}>
                {/* Net Worth Chart */}
                <div className="lg:col-span-2">
                    <Card>
                        <div className="flex flex-col gap-3 mb-4">
                            <div className="flex items-center justify-between gap-2">
                                <h2 className={`text-lg font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                    Net Worth Projection
                                </h2>
                                <Button
                                    icon={showBreakdown ? <MdShowChart /> : <MdBarChart />}
                                    text
                                    severity="secondary"
                                    tooltip={showBreakdown ? 'Show net worth only' : 'Show breakdown'}
                                    onClick={() => setShowBreakdown(!showBreakdown)}
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <SelectButton
                                    value={horizon}
                                    options={HORIZON_OPTIONS}
                                    onChange={(e) => e.value && setHorizon(e.value)}
                                    className="text-sm"
                                />
                                <SelectButton
                                    value={wealthScope}
                                    options={SCOPE_OPTIONS}
                                    onChange={(e) => e.value && setWealthScope(e.value)}
                                    className="text-sm"
                                />
                            </div>
                        </div>

                        {showBreakdown ? (
                            <WealthChart data={filteredProjection} currency={displayCurrency} scope={wealthScope} />
                        ) : (
                            <NetWorthChart data={filteredProjection} currency={displayCurrency} scope={wealthScope} />
                        )}
                    </Card>
                </div>

                {/* Plan-vs-reality feedback loop */}
                <div className="space-y-6">
                    {planCheck && (
                        <PlanCheckCard
                            monthly={planCheck.monthly}
                            retrospective={planCheck.retrospective}
                            currency={displayCurrency}
                        />
                    )}
                    <Button
                        label="View month details"
                        icon={<MdArrowForward />}
                        iconPos="right"
                        text
                        className="w-full"
                        onClick={() => router.push('/cashflow')}
                    />
                </div>
            </div>

            {/* Projected Net Worth at Horizon */}
            <Card className={isSimple ? 'hidden' : ''}>
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className={`text-lg font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            Projected Net Worth
                        </h2>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            At end of selected horizon ({horizon.toUpperCase()})
                        </p>
                    </div>
                    <div className="text-right">
                        <p className={`text-3xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            {formatCurrency(kpiValues.projectedNetWorth, displayCurrency)}
                            {isMixedCurrency && <span className={`text-sm font-normal ml-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>(mixed currencies)</span>}
                        </p>
                        <Tag
                            value={`${kpiValues.projectedNetWorth >= kpiValues.netWorth ? '+' : ''}${formatCurrency(kpiValues.projectedNetWorth - kpiValues.netWorth, displayCurrency)}`}
                            severity={kpiValues.projectedNetWorth >= kpiValues.netWorth ? 'success' : 'danger'}
                        />
                    </div>
                </div>
            </Card>

            {/* Quick Actions */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Button
                    label="Add Income"
                    icon={<MdAddCircle />}
                    severity="success"
                    outlined
                    className="justify-center"
                    onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'income' })}
                />
                <Button
                    label="Add Expense"
                    icon={<MdRemoveCircle />}
                    severity="danger"
                    outlined
                    className="justify-center"
                    onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'expense' })}
                />
                <Button
                    label="Add Receivable"
                    icon={<MdGroup />}
                    severity="warning"
                    outlined
                    className="justify-center"
                    onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'receivable' })}
                />
                <Button
                    label="Add Debt"
                    icon={<MdCreditCard />}
                    severity="danger"
                    outlined
                    className="justify-center"
                    onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'debt' })}
                />
            </div>

            <EntityListDrawer
                visible={entityDrawer.visible}
                category={entityDrawer.category}
                onClose={() => setEntityDrawer(prev => ({ ...prev, visible: false }))}
                onRefresh={fetchData}
            />

            <NetWorthExplainDialog
                visible={explainNetWorthVisible}
                onHide={() => setExplainNetWorthVisible(false)}
                values={kpiValues}
                currency={displayCurrency}
            />
        </div>
    );
}
