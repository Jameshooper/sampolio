'use client';

import { useState, useEffect, useCallback, useMemo, useRef, startTransition } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Dialog } from 'primereact/dialog';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { helpText } from '@/lib/plain-language';
import type { CardFlowBreakdown } from '@/components/charts/monthly-flow-chart';
// The ECharts-based charts are large; code-split them into their own chunk so
// they don't bloat the cashflow page's initial JS (ssr:false — charts are
// client-only anyway). A short-delayed placeholder holds their layout height.
const ChartLoading = () => <div className="h-72 lg:h-96 rounded-lg bg-gray-100 dark:bg-gray-800/50 animate-pulse" />;
const MonthlyFlowChart = dynamic(
    () => import('@/components/charts/monthly-flow-chart').then((m) => m.MonthlyFlowChart),
    { ssr: false, loading: ChartLoading },
);
const CashflowWaterfallChart = dynamic(
    () => import('@/components/charts/cashflow-waterfall-chart').then((m) => m.CashflowWaterfallChart),
    { ssr: false, loading: ChartLoading },
);
const ExpenseTreemapChart = dynamic(
    () => import('@/components/charts/expense-treemap-chart').then((m) => m.ExpenseTreemapChart),
    { ssr: false, loading: ChartLoading },
);
import { getAccounts } from '@/lib/actions/accounts';
import { getProjection } from '@/lib/actions/projection';
import { getCardStatementBreakdownForAccount } from '@/lib/actions/bank';
import { getReconciliationSessions } from '@/lib/actions/reconciliation';
import { OccurrenceOverrideDialog } from '@/components/modals/occurrence-override-dialog';
import { ChartsPageSkeleton } from '@/components/ui/skeletons';
import { CashflowHeader } from '@/components/cashflow/cashflow-header';
import { MonthDetailsPanel } from '@/components/cashflow/month-details-panel';
import { ProjectionTable } from '@/components/cashflow/projection-table';
import { useMonthSelection } from '@/lib/hooks/use-month-selection';
import type { FinancialAccount, MonthFlowData, CashflowItem, Currency, SalaryConfig, TaxedIncome, MonthlyProjection } from '@/types';
import { MdAccountBalanceWallet, MdAdd, MdAccountTree, MdBarChart, MdTableChart, MdInfoOutline, MdHistory } from 'react-icons/md';
import { Tooltip } from 'primereact/tooltip';

export default function CashflowPage() {
    const appContext = useAppContext();
    const router = useRouter();
    const { theme } = useTheme();
    const isDark = theme === 'dark';

    const [isLoading, setIsLoading] = useState(true);
    const hasLoadedOnce = useRef(false);
    const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
    const [selectedAccountId, setSelectedAccountId] = useState<string>('');
    const [projection, setProjection] = useState<MonthlyProjection[]>([]);
    // Past months reconstructed from real bank transactions (rendered to the left
    // of the forecast). Empty unless a bank cash/savings account is linked.
    const [retrospective, setRetrospective] = useState<MonthlyProjection[]>([]);
    const [salaryConfigs, setSalaryConfigs] = useState<SalaryConfig[]>([]);
    // Full taxed-income entities for the selected account — used to draw the
    // gross→deductions Sankey for `source: 'taxed-income'` inflows.
    const [taxedIncomes, setTaxedIncomes] = useState<TaxedIncome[]>([]);
    const [reconciledMonths, setReconciledMonths] = useState<Set<string>>(new Set());
    // Per-card statement breakdown for the selected month (drills the Sankey's
    // card bill into individual purchases), keyed by the bank link id.
    const [cardBreakdowns, setCardBreakdowns] = useState<Map<string, CardFlowBreakdown>>(new Map());

    // Occurrence override dialog state
    const [overrideDialogVisible, setOverrideDialogVisible] = useState(false);
    const [overrideRecurringItemId, setOverrideRecurringItemId] = useState('');

    // Edit choice dialog state (for recurring items: edit occurrence vs series)
    const [editChoiceVisible, setEditChoiceVisible] = useState(false);
    const [editChoiceItemId, setEditChoiceItemId] = useState('');
    const [editChoiceItemType, setEditChoiceItemType] = useState('');

    // Fetch accounts
    useEffect(() => {
        async function fetchAccounts() {
            const result = await getAccounts();
            if (result.success && result.data) {
                const active = result.data.filter((a: FinancialAccount) => !a.isArchived);
                if (hasLoadedOnce.current) {
                    // Smooth update without flash for refreshes
                    startTransition(() => {
                        setAccounts(active);
                        if (active.length > 0 && !selectedAccountId) {
                            setSelectedAccountId(active[0].id);
                        }
                    });
                } else {
                    setAccounts(active);
                    if (active.length > 0 && !selectedAccountId) {
                        setSelectedAccountId(active[0].id);
                    }
                }
            }
            if (!hasLoadedOnce.current) {
                hasLoadedOnce.current = true;
                setIsLoading(false);
            }
        }
        fetchAccounts();
    }, [selectedAccountId]);

    // Fetch projection when account changes
    const fetchProjection = useCallback(async () => {
        if (!selectedAccountId) return;

        try {
            const result = await getProjection(selectedAccountId);
            if (result.success && result.data) {
                // Use startTransition to avoid UI flash during refresh
                const monthly = result.data.monthly;
                const retro = result.data.retrospective ?? [];
                const configs = result.data.salaryConfigs ?? [];
                const taxed = result.data.taxedIncomes ?? [];
                startTransition(() => {
                    setProjection(monthly);
                    setRetrospective(retro);
                    setSalaryConfigs(configs);
                    setTaxedIncomes(taxed);
                });
            }
        } catch (err) {
            console.error('Failed to fetch projection:', err);
        }
    }, [selectedAccountId]);

    useEffect(() => {
        if (selectedAccountId) {
            fetchProjection();
        }
    }, [selectedAccountId, fetchProjection]);

    // Register refresh callback
    useEffect(() => {
        if (appContext) {
            appContext.setRefreshCallback(fetchProjection);
        }
    }, [appContext, fetchProjection]);

    // Fetch reconciliation sessions to determine which months are reconciled
    useEffect(() => {
        async function fetchReconciliationStatus() {
            const result = await getReconciliationSessions();
            if (result.success && result.data) {
                const completed = result.data
                    .filter(s => s.status === 'completed')
                    .map(s => s.yearMonth);
                setReconciledMonths(new Set(completed));
            }
        }
        fetchReconciliationStatus();
    }, []);

    // Display mode
    const displayMode = appContext?.displayMode ?? 'advanced';
    const isSimple = displayMode === 'simple';
    const [showMoreCharts, setShowMoreCharts] = useState(false);

    // Get selected account
    const selectedAccount = accounts.find(a => a.id === selectedAccountId);
    const currency = selectedAccount?.currency || 'EUR';

    // Real bank-actual past months sit to the LEFT of the forecast; everything
    // downstream (strip, table, cards, chart, selected-month lookup) renders this
    // merged list. The yearly rollups stay forecast-only (server-side).
    const displayMonths = useMemo(() => [...retrospective, ...projection], [retrospective, projection]);
    const actualMonths = useMemo(() => new Set(retrospective.map(m => m.yearMonth)), [retrospective]);

    // Single source of truth for month selection — the strip, the table rows and
    // the mobile cards all read/write through this hook.
    const { selectedMonth, setSelectedMonth, months, selectedProjection, nowMonth } =
        useMonthSelection(displayMonths, projection);

    // Card statement breakdown for the selected month (for the Sankey drill-down)
    useEffect(() => {
        if (!selectedAccountId) return;
        getCardStatementBreakdownForAccount(selectedAccountId, selectedMonth).then((res) => {
            setCardBreakdowns(
                res.success && res.data
                    ? new Map(res.data.map((b) => [b.linkId, { cardName: b.cardName, transactions: b.transactions }]))
                    : new Map()
            );
        });
    }, [selectedAccountId, selectedMonth]);

    // Current balance for the account selector affordance ("Everyday · €1 234"):
    // the anchor month's starting balance for the selected account.
    const accountBalances = useMemo(() => {
        const map = new Map<string, number>();
        const nowRow = projection.find((m) => m.yearMonth === nowMonth) ?? projection[0];
        if (selectedAccountId && nowRow) map.set(selectedAccountId, nowRow.startingBalance);
        return map;
    }, [projection, nowMonth, selectedAccountId]);

    // Convert projection to flow data
    // For salary items, show gross salary as income with tax/contributions as deduction outflows
    const flowData: MonthFlowData | null = useMemo(() => {
        if (!selectedProjection) return null;

        const mapSource = (src: string): CashflowItem['source'] => {
            if (src === 'planned-one-off' || src === 'planned-repeating') return 'planned';
            return src as CashflowItem['source'];
        };

        // Build salary config lookup: linkedRecurringItemId -> SalaryConfig
        const salaryByRecurringId = new Map<string, SalaryConfig>();
        for (const config of salaryConfigs) {
            if (config.isLinkedToRecurring && config.linkedRecurringItemId && config.isActive) {
                salaryByRecurringId.set(config.linkedRecurringItemId, config);
            }
        }

        // Taxed-income lookup by entity id (a taxed-income projection line carries
        // the TaxedIncome's own id as itemId).
        const taxedById = new Map<string, TaxedIncome>();
        for (const ti of taxedIncomes) taxedById.set(ti.id, ti);

        const inflows: CashflowItem[] = [];
        const syntheticOutflows: CashflowItem[] = [];

        for (const item of selectedProjection.incomeBreakdown) {
            const salaryConfig = salaryByRecurringId.get(item.itemId);
            const taxedIncome = item.source === 'taxed-income' ? taxedById.get(item.itemId) : undefined;
            if (salaryConfig) {
                // Compute ratio to handle shared expenses correctly
                const ratio = salaryConfig.netSalary > 0 ? item.amount / salaryConfig.netSalary : 1;
                const taxableBenefitsTotal = (salaryConfig.benefits || [])
                    .filter(b => b.isTaxable)
                    .reduce((sum, b) => sum + b.amount, 0);
                const taxableBase = salaryConfig.grossSalary + taxableBenefitsTotal;
                const taxAmount = taxableBase * (salaryConfig.taxRate / 100) * ratio;
                const contributionsAmount = taxableBase * (salaryConfig.contributionsRate / 100) * ratio;
                const otherDeductions = salaryConfig.otherDeductions * ratio;

                // Show gross salary as income
                inflows.push({
                    id: item.itemId,
                    name: item.name.replace('Salary:', 'Gross Salary:'),
                    amount: salaryConfig.grossSalary * ratio,
                    category: item.category,
                    type: 'income',
                    source: 'salary',
                    isRecurring: true,
                    linkedEntityId: salaryConfig.id,
                    linkedEntityType: 'salary',
                });

                // Add deduction outflows
                if (taxAmount > 0) {
                    syntheticOutflows.push({
                        id: `${salaryConfig.id}-tax`,
                        name: `Tax (${salaryConfig.taxRate}%)`,
                        amount: Math.round(taxAmount * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'salary',
                        isRecurring: true,
                        linkedEntityId: salaryConfig.id,
                        linkedEntityType: 'salary',
                    });
                }
                if (contributionsAmount > 0) {
                    syntheticOutflows.push({
                        id: `${salaryConfig.id}-contributions`,
                        name: `Contributions (${salaryConfig.contributionsRate}%)`,
                        amount: Math.round(contributionsAmount * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'salary',
                        isRecurring: true,
                        linkedEntityId: salaryConfig.id,
                        linkedEntityType: 'salary',
                    });
                }
                if (otherDeductions > 0) {
                    syntheticOutflows.push({
                        id: `${salaryConfig.id}-other-deductions`,
                        name: 'Other Deductions',
                        amount: Math.round(otherDeductions * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'salary',
                        isRecurring: true,
                        linkedEntityId: salaryConfig.id,
                        linkedEntityType: 'salary',
                    });
                }
            } else if (taxedIncome) {
                // Taxed income (bonus / holiday pay): mirror the salary treatment —
                // show the GROSS as income and split tax / contributions / other
                // deductions off as their own outflows. `ratio` scales everything
                // when the projected line differs from the stored net (shared/edge
                // cases); for the normal case it is 1.
                const ti = taxedIncome;
                const ratio = ti.netAmount > 0 ? item.amount / ti.netAmount : 1;
                const taxAmount = ti.taxAmount * ratio;
                const contributionsAmount = ti.contributionsAmount * ratio;
                const otherDeductions =
                    Math.max(0, ti.grossAmount - ti.taxAmount - ti.contributionsAmount - ti.netAmount) * ratio;
                // Effective rates derived from the frozen amounts (works for both
                // custom rates and salary-linked settings).
                const taxPct = ti.grossAmount > 0 ? Math.round((ti.taxAmount / ti.grossAmount) * 1000) / 10 : 0;
                const contribPct = ti.grossAmount > 0 ? Math.round((ti.contributionsAmount / ti.grossAmount) * 1000) / 10 : 0;

                inflows.push({
                    id: item.itemId,
                    name: `Gross: ${item.name}`,
                    amount: ti.grossAmount * ratio,
                    category: item.category,
                    type: 'income',
                    source: 'taxed-income',
                    isRecurring: ti.kind === 'recurring',
                    linkedEntityId: ti.id,
                    linkedEntityType: 'taxed-income',
                });

                if (taxAmount > 0) {
                    syntheticOutflows.push({
                        id: `${ti.id}-tax`,
                        name: `Tax (${taxPct}%)`,
                        amount: Math.round(taxAmount * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'taxed-income',
                        isRecurring: ti.kind === 'recurring',
                        linkedEntityId: ti.id,
                        linkedEntityType: 'taxed-income',
                    });
                }
                if (contributionsAmount > 0) {
                    syntheticOutflows.push({
                        id: `${ti.id}-contributions`,
                        name: `Contributions (${contribPct}%)`,
                        amount: Math.round(contributionsAmount * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'taxed-income',
                        isRecurring: ti.kind === 'recurring',
                        linkedEntityId: ti.id,
                        linkedEntityType: 'taxed-income',
                    });
                }
                if (otherDeductions > 0) {
                    syntheticOutflows.push({
                        id: `${ti.id}-other-deductions`,
                        name: 'Other Deductions',
                        amount: Math.round(otherDeductions * 100) / 100,
                        category: 'Taxes',
                        type: 'expense',
                        source: 'taxed-income',
                        isRecurring: ti.kind === 'recurring',
                        linkedEntityId: ti.id,
                        linkedEntityType: 'taxed-income',
                    });
                }
            } else {
                // Non-salary income — pass through unchanged
                inflows.push({
                    id: item.itemId,
                    name: item.name,
                    amount: item.amount,
                    category: item.category,
                    type: 'income',
                    source: mapSource(item.source),
                    isRecurring: item.source === 'recurring' || item.source === 'salary',
                });
            }
        }

        const outflows: CashflowItem[] = [
            ...syntheticOutflows,
            ...selectedProjection.expenseBreakdown.map(item => ({
                id: item.itemId,
                name: item.name,
                amount: item.amount,
                category: item.category,
                type: 'expense' as const,
                source: mapSource(item.source),
                isRecurring: item.source === 'recurring',
            })),
        ];

        const totalInflows = inflows.reduce((sum, i) => sum + i.amount, 0);
        const totalOutflows = outflows.reduce((sum, o) => sum + o.amount, 0);

        // Actualized month: the flows above are planned amounts, but netChange is
        // the adjusted (still-ahead) net — the gap is what already settled out of
        // today's balance. Pass it so the Sankey can add a balancing flow.
        const alreadySettledNet =
            selectedProjection.isActualized
                && selectedProjection.plannedTotalIncome !== undefined
                && selectedProjection.plannedTotalExpenses !== undefined
                ? selectedProjection.netChange - (selectedProjection.plannedTotalIncome - selectedProjection.plannedTotalExpenses)
                : undefined;

        return {
            yearMonth: selectedMonth,
            accountId: selectedAccountId,
            startingBalance: selectedProjection.startingBalance,
            endingBalance: selectedProjection.endingBalance,
            inflows,
            outflows,
            totalInflows,
            totalOutflows,
            netChange: selectedProjection.netChange, // preserve real net change for balance
            alreadySettledNet,
            isReconciled: reconciledMonths.has(selectedMonth),
        };
    }, [selectedProjection, selectedMonth, selectedAccountId, reconciledMonths, salaryConfigs, taxedIncomes]);

    // Whether the Sankey shows a gross figure (salary or taxed income) — drives
    // the gross-vs-net caption.
    const flowShowsGross = useMemo(
        () => !!flowData?.inflows.some((i) => (i.source === 'salary' || i.source === 'taxed-income') && i.linkedEntityId),
        [flowData]
    );

    const handleEditItem = (itemId: string, source: string, itemType?: string) => {
        // Mortgage transfers are computed from the mortgage (single source of truth);
        // editing happens on the mortgage page, not here.
        if (source === 'mortgage-payment') {
            router.push('/mortgage');
            return;
        }

        // Budget transfers likewise: the itemId is the budgetId, edited on its own page.
        if (source === 'budget') {
            router.push(`/budgets/${itemId}`);
            return;
        }

        // Goal transfers: the itemId is the goalId, edited on /goals.
        if (source === 'goal') {
            router.push('/goals');
            return;
        }

        // Trip transfers: the itemId is the tripId, edited on the Trips & Budgets page.
        if (source === 'trip') {
            router.push('/budgets#trips');
            return;
        }

        // Credit-card bills are computed from the bank sync; manage them on /bank.
        if (source === 'credit-card') {
            router.push('/bank');
            return;
        }

        // Retrospective lines are real, read-only bank transactions; the full
        // ledger lives on /bank.
        if (source === 'bank-actual') {
            router.push('/bank');
            return;
        }

        // For recurring items, ask whether to edit this occurrence or the entire series
        if (source === 'recurring') {
            setEditChoiceItemId(itemId);
            setEditChoiceItemType(itemType || '');
            setEditChoiceVisible(true);
            return;
        }

        // Map CashflowItem source to EntityModalRouter entityType
        let entityType = source;
        if (source === 'planned-one-off' || source === 'planned-repeating' || source === 'planned') {
            entityType = 'planned';
        } else if (source === 'salary') {
            entityType = 'salary';
        } else if (source === 'taxed-income') {
            entityType = 'taxed-income';
        } else if (source === 'debt-payment') {
            entityType = 'debt';
        }
        appContext?.openDrawer({
            mode: 'edit',
            entityType,
            entityId: itemId,
            yearMonth: selectedMonth,
        });
    };

    const handleAddItem = (type: 'income' | 'expense') => {
        appContext?.openDrawer({
            mode: 'create',
            entityType: type,
            yearMonth: selectedMonth,
        });
    };

    const handleManageItems = () => {
        appContext?.openDrawer({
            mode: 'view',
            entityType: 'cashflow-item',
            yearMonth: selectedMonth,
        });
    };

    if (isLoading) {
        return <ChartsPageSkeleton />;
    }

    if (accounts.length === 0) {
        return (
            <Card>
                <div className={`text-center py-12 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    <MdAccountBalanceWallet size={48} className="mb-4" />
                    <h2 className={`text-xl font-semibold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        No Cash Accounts
                    </h2>
                    <p className="mb-4">Create a cash account to start tracking your cashflow.</p>
                    <Button
                        label="Create Account"
                        icon={<MdAdd />}
                        onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'account' })}
                    />
                </div>
            </Card>
        );
    }

    return (
        <div>
            <Dialog
                header="Edit Recurring Item"
                visible={editChoiceVisible}
                onHide={() => setEditChoiceVisible(false)}
                style={{ width: '420px' }}
                modal
            >
                <p className="mb-6">Do you want to edit just this month&apos;s occurrence, or the entire recurring series?</p>
                <div className="flex justify-end gap-2">
                    <Button
                        label="Entire Series"
                        severity="secondary"
                        outlined
                        onClick={() => {
                            setEditChoiceVisible(false);
                            const entityType = editChoiceItemType === 'income' ? 'income' : 'expense';
                            appContext?.openDrawer({
                                mode: 'edit',
                                entityType,
                                entityId: editChoiceItemId,
                                yearMonth: selectedMonth,
                            });
                        }}
                    />
                    <Button
                        label="This Occurrence"
                        outlined
                        onClick={() => {
                            setEditChoiceVisible(false);
                            setOverrideRecurringItemId(editChoiceItemId);
                            setOverrideDialogVisible(true);
                        }}
                    />
                </div>
            </Dialog>
            <OccurrenceOverrideDialog
                visible={overrideDialogVisible}
                onHide={() => setOverrideDialogVisible(false)}
                recurringItemId={overrideRecurringItemId}
                accountId={selectedAccountId}
                yearMonth={selectedMonth}
                onDataChange={fetchProjection}
            />

            <CashflowHeader
                accounts={accounts}
                selectedAccountId={selectedAccountId}
                onSelectAccount={setSelectedAccountId}
                accountBalances={accountBalances}
                months={months}
                selectedMonth={selectedMonth}
                onSelectMonth={setSelectedMonth}
                reconciledMonths={reconciledMonths}
                actualMonths={actualMonths}
                addDisabled={!!selectedProjection?.isActual}
                onAddItem={handleAddItem}
                onManageItems={handleManageItems}
            />

            <div className="space-y-4 lg:space-y-6 max-w-360 mx-auto py-4 lg:py-8">
                {/* Selected Month Banner */}
                {selectedProjection && (
                    <Card className="bg-linear-to-r! from-accent-600/10 to-accent-400/10 border border-accent-500/20">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className={`text-xs uppercase tracking-wider mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Selected Month</p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <h2 className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                        {formatYearMonth(selectedMonth)}
                                    </h2>
                                    {selectedProjection.isActual && (
                                        <Tag
                                            icon={<MdHistory className="mr-1" size={13} />}
                                            value={isSimple ? 'From your bank' : 'Actual'}
                                            className="!bg-purple-500/15 !text-purple-500"
                                            data-pr-tooltip="Figures from real bank transactions, not a forecast"
                                        />
                                    )}
                                    {selectedProjection.isActualized && (
                                        <Tag
                                            value="adjusted for what's already happened"
                                            className="!bg-blue-500/15 !text-blue-500"
                                            data-pr-tooltip={helpText('stillAhead')}
                                        />
                                    )}
                                </div>
                                {/* Simple mode leads with a sentence, not numbers. */}
                                {isSimple && (
                                    <p className={`text-sm mt-1 font-medium ${selectedProjection.netChange >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                        {selectedProjection.isActualized ? (
                                            selectedProjection.netChange >= 0
                                                ? <>You&apos;re on track to end the month with {formatCurrency(selectedProjection.netChange, currency as Currency)} more than you have today.</>
                                                : <>You&apos;re on track to end the month with {formatCurrency(Math.abs(selectedProjection.netChange), currency as Currency)} less than you have today.</>
                                        ) : (
                                            selectedProjection.netChange >= 0
                                                ? <>You&apos;re set to keep {formatCurrency(selectedProjection.netChange, currency as Currency)} this month.</>
                                                : <>You&apos;re set to spend {formatCurrency(Math.abs(selectedProjection.netChange), currency as Currency)} more than comes in this month.</>
                                        )}
                                    </p>
                                )}
                            </div>
                            <div className="flex items-center gap-6 text-sm">
                                <div className="text-center">
                                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {isSimple ? 'Money in' : selectedProjection.isActualized ? 'Income left' : 'Income'}
                                    </div>
                                    <div className="text-green-500 font-semibold">+{formatCurrency(selectedProjection.totalIncome, currency as Currency)}</div>
                                    {!isSimple && selectedProjection.isActualized
                                        && selectedProjection.plannedTotalIncome !== undefined
                                        && selectedProjection.plannedTotalIncome !== selectedProjection.totalIncome && (
                                            <div className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                                of {formatCurrency(selectedProjection.plannedTotalIncome, currency as Currency)} planned
                                            </div>
                                        )}
                                </div>
                                <div className="text-center">
                                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {isSimple ? 'Money out' : selectedProjection.isActualized ? 'Expenses left' : 'Expenses'}
                                    </div>
                                    <div className="text-red-500 font-semibold">-{formatCurrency(selectedProjection.totalExpenses, currency as Currency)}</div>
                                    {!isSimple && selectedProjection.isActualized
                                        && selectedProjection.plannedTotalExpenses !== undefined
                                        && selectedProjection.plannedTotalExpenses !== selectedProjection.totalExpenses && (
                                            <div className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                                of {formatCurrency(selectedProjection.plannedTotalExpenses, currency as Currency)} planned
                                            </div>
                                        )}
                                </div>
                                <div className="text-center">
                                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {isSimple ? 'Left over' : selectedProjection.isActualized ? 'Net left' : 'Net'}
                                    </div>
                                    <div className={`font-semibold ${selectedProjection.netChange >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                        {selectedProjection.netChange >= 0 ? '+' : ''}{formatCurrency(selectedProjection.netChange, currency as Currency)}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Card>
                )}

                {/* Charts: Left 2/3 (Flow + Projection stacked) | Right 1/3 (Details + Treemap stacked) */}
                <div className={`grid grid-cols-1 ${isSimple && !showMoreCharts ? '' : 'lg:grid-cols-3'} gap-6`}>
                    {/* Left column: 2/3 width — hidden in simple mode unless "Show more" */}
                    <div className={`lg:col-span-2 space-y-6 ${isSimple && !showMoreCharts ? 'hidden' : ''}`}>
                        <Card>
                            <Tooltip target=".info-monthly-flow" position="top" />
                            <h3 className={`flex items-center font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                <MdAccountTree className="mr-2" />Monthly Flow
                                <MdInfoOutline
                                    className="info-monthly-flow ml-auto opacity-40 cursor-help"
                                    size={16}
                                    data-pr-tooltip="Sankey diagram showing how your income flows into expenses. Left side shows individual income sources, center aggregates into your budget, right side breaks down expenses by category and individual items."
                                />
                            </h3>
                            {/* The Sankey uses GROSS salary and taxed income with
                                taxes/deductions as outflows, so its income figure is
                                deliberately higher than the (net) Selected Month card
                                above — say so instead of confusing. */}
                            {flowShowsGross && (
                                <p className={`text-xs mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                    Shows gross salary and taxed income — taxes &amp; deductions appear as
                                    outflows, so income here is higher than the net figure above. Click a
                                    deduction to open its source.
                                </p>
                            )}
                            {selectedProjection?.isActualized && (
                                <p className={`text-xs mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                    Some items are already paid — balance figures account for that.
                                </p>
                            )}
                            {!flowShowsGross && !selectedProjection?.isActualized && <div className="mb-3" />}
                            {flowData ? (
                                <MonthlyFlowChart
                                    data={flowData}
                                    currency={currency as Currency}
                                    height="350px"
                                    cardBreakdowns={cardBreakdowns}
                                    onClickItem={(item) => {
                                        if (item.id === 'new') {
                                            handleAddItem(item.type as 'income' | 'expense');
                                        } else {
                                            const entityId = item.linkedEntityId || item.id;
                                            handleEditItem(entityId, item.source, item.type);
                                        }
                                    }}
                                />
                            ) : (
                                <div className={`text-center py-12 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                                    No data for selected month
                                </div>
                            )}
                        </Card>

                        <Card>
                            <Tooltip target=".info-waterfall" position="top" />
                            <h3 className={`flex items-center font-semibold mb-3 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                <MdBarChart className="mr-2" />Cashflow Projection
                                <MdInfoOutline
                                    className="info-waterfall ml-auto opacity-40 cursor-help"
                                    size={16}
                                    data-pr-tooltip="Waterfall chart showing your projected balance over time. Green bars represent income, red bars represent expenses, and the line tracks your running balance across months."
                                />
                            </h3>
                            <CashflowWaterfallChart
                                data={displayMonths}
                                currency={currency as Currency}
                                height="350px"
                                nowMonth={nowMonth}
                            />
                        </Card>
                    </div>

                    {/* Right column: 1/3 width */}
                    <div className="space-y-6">
                        <Card>
                            <Tooltip target=".info-month-details" position="top" />
                            <h3 className={`flex items-center font-semibold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                Month Details
                                <MdInfoOutline
                                    className="info-month-details ml-auto opacity-40 cursor-help"
                                    size={16}
                                    data-pr-tooltip="Detailed breakdown of all income and expense items for the selected month. Shows starting and ending balance with the net change. Click any item to edit it."
                                />
                            </h3>
                            {/* Keyed on the month so switching months fade-rises the panel in
                                (cheap remount — the heavy projection table below is NOT keyed). */}
                            <div key={selectedMonth} className="animate-rise-in">
                                <MonthDetailsPanel
                                    projection={selectedProjection}
                                    currency={currency as Currency}
                                    onEditItem={handleEditItem}
                                    isSimple={isSimple}
                                />
                            </div>
                        </Card>

                        {selectedProjection && selectedProjection.expenseBreakdown.length > 0 && (!isSimple || showMoreCharts) && (
                            <Card className="overflow-visible">
                                <Tooltip target=".info-treemap" position="top" />
                                <h3 className={`flex items-center font-semibold mb-3 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                    <MdBarChart className="mr-2" />Expenses Breakdown
                                    <MdInfoOutline
                                        className="info-treemap ml-auto opacity-40 cursor-help"
                                        size={16}
                                        data-pr-tooltip="Treemap showing the proportional size of each expense category and item for the selected month. Larger blocks represent bigger expenses, making it easy to spot where most money goes."
                                    />
                                </h3>
                                <ExpenseTreemapChart
                                    expenses={selectedProjection.expenseBreakdown}
                                    currency={currency as Currency}
                                    height="350px"
                                    cardBreakdowns={cardBreakdowns}
                                    onClickItem={(item) => handleEditItem(item.itemId, item.source, 'expense')}
                                />
                            </Card>
                        )}
                    </div>
                </div>

                {/* Details toggle for simple mode (charts + the all-months table) */}
                {isSimple && (
                    <div className="text-center">
                        <Button
                            label={showMoreCharts ? 'Hide details' : 'Show details'}
                            text
                            severity="secondary"
                            onClick={() => setShowMoreCharts(!showMoreCharts)}
                        />
                    </div>
                )}

                {/* Data Table */}
                <div className={isSimple && !showMoreCharts ? 'hidden' : ''}>
                    <div className={`mt-4 pt-6 border-t-2 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                        <p className={`text-xs uppercase tracking-wider mb-3 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>All Months Overview</p>
                    </div>
                    <Card>
                        <Tooltip target=".info-projection" position="top" />
                        <h3 className={`flex items-center font-semibold mb-3 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            <MdTableChart className="mr-2" />Projection Data
                            <MdInfoOutline
                                className="info-projection ml-auto opacity-40 cursor-help"
                                size={16}
                                data-pr-tooltip="Table showing the full projection across all months — not just the selected one. Displays income, expenses, net change, and running balance. Click any row to jump to that month."
                            />
                        </h3>
                        <ProjectionTable
                            displayMonths={displayMonths}
                            nowMonth={nowMonth}
                            selectedMonth={selectedMonth}
                            selectedProjection={selectedProjection}
                            onSelectMonth={setSelectedMonth}
                            currency={currency as Currency}
                            isSimple={isSimple}
                        />
                    </Card>
                </div>
            </div>
        </div>
    );
}
