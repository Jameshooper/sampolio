'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useSession } from 'next-auth/react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import { SelectButton } from 'primereact/selectbutton';
import { TabView, TabPanel } from 'primereact/tabview';
import { ChartsPageSkeleton } from '@/components/ui/skeletons';
import { AlertBanner } from '@/components/ui/alert-banner';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { MdHouse, MdPercent, MdMoreVert, MdFlag } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { useTheme } from '@/components/providers/theme-provider';
import { useToast } from '@/components/providers/toast-provider';
import { getMyMortgages, getMortgageProjectionInputs, deleteMortgage, revertMortgageMonth } from '@/lib/actions/shared-mortgages';
import type { MortgageProjectionInputsResult } from '@/lib/actions/shared-mortgages';
import { calculateMortgageProjection, getMortgageStartDate, getPayoffMonth } from '@/lib/mortgage-projection';
import { isEuriborUpdateDue } from '@/lib/mortgage-utils';
import { addMonths, compareYearMonths, getCurrentYearMonth, getMonthsBetween } from '@/lib/projection';
import type { TimeHorizon } from '@/types';
import { MortgageHeroCard, MyMortgageSummaryCard, OwnershipBalancePanel, SubLoanCard } from '@/components/mortgage/mortgage-panels';
import { MortgageLedgerTable } from '@/components/mortgage/mortgage-ledger-table';
import { MortgageHistoryStrips } from '@/components/mortgage/mortgage-history-strips';
import { MortgageTransferComparison } from '@/components/mortgage/mortgage-transfer-comparison';
import { MortgageSetupWizard } from '@/components/mortgage/mortgage-setup-wizard';
import { MortgageImportDialog } from '@/components/mortgage/mortgage-import-dialog';
import { MortgageReconcileDialog } from '@/components/mortgage/mortgage-reconcile-dialog';
import { EuriborUpdateDialog, DriftAdjustmentDialog, ExtraPaymentDialog, MortgageMembersDialog } from '@/components/mortgage/mortgage-dialogs';
// The mortgage page renders seven Chart.js charts. Code-split them into a single
// shared lazy chunk (same module specifier → one shared chunk) so they don't
// inflate the page's initial JS; a short placeholder holds each chart's height.
const MortgageChartLoading = () => <div className="h-[320px] rounded-lg bg-gray-100 dark:bg-gray-800/50 animate-pulse" />;
const chartModule = () => import('@/components/mortgage/mortgage-charts');
const MortgageBalanceChart = dynamic(() => chartModule().then((m) => m.MortgageBalanceChart), { ssr: false, loading: MortgageChartLoading });
const OwnershipProgressChart = dynamic(() => chartModule().then((m) => m.OwnershipProgressChart), { ssr: false, loading: MortgageChartLoading });
const PrincipalInterestChart = dynamic(() => chartModule().then((m) => m.PrincipalInterestChart), { ssr: false, loading: MortgageChartLoading });
const CumulativeCostChart = dynamic(() => chartModule().then((m) => m.CumulativeCostChart), { ssr: false, loading: MortgageChartLoading });
const RateHistoryChart = dynamic(() => chartModule().then((m) => m.RateHistoryChart), { ssr: false, loading: MortgageChartLoading });
const PaymentBreakdownChart = dynamic(() => chartModule().then((m) => m.PaymentBreakdownChart), { ssr: false, loading: MortgageChartLoading });
const EquityBuildupChart = dynamic(() => chartModule().then((m) => m.EquityBuildupChart), { ssr: false, loading: MortgageChartLoading });

const HORIZON_OPTIONS = [
  { label: '1Y', value: '1y' },
  { label: '3Y', value: '3y' },
  { label: '5Y', value: '5y' },
  { label: 'All', value: 'custom' },
];
const HORIZON_MONTHS: Record<string, number> = { '6m': 6, '1y': 12, '3y': 36, '5y': 60 };

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="text-base font-semibold mb-3">{title}</h3>
      {children}
    </Card>
  );
}

export default function MortgagePage() {
  const { data: session } = useSession();
  const appContext = useAppContext();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const isSimple = appContext?.displayMode === 'simple';
  const userId = session?.user?.id;
  const appToast = useToast();
  const menuRef = useRef<Menu>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [inputs, setInputs] = useState<MortgageProjectionInputsResult | null>(null);
  const [horizon, setHorizon] = useState<TimeHorizon>('5y');
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [euriborOpen, setEuriborOpen] = useState(false);
  const [driftOpen, setDriftOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [reconcileYM, setReconcileYM] = useState<string | null>(null);
  // In-page tab (Overview / Charts / Schedule / Tools) — segments the former
  // ~7 000px mobile scroll.
  const [activeTab, setActiveTab] = useState(0);

  const currentMonth = getCurrentYearMonth();
  const hasLoadedOnce = useRef(false);

  const fetchData = useCallback(async () => {
    if (!hasLoadedOnce.current) setIsLoading(true);
    try {
      const res = await getMyMortgages();
      const active = res.success && res.data ? res.data.filter((m) => !m.isArchived) : [];
      if (active.length === 0) {
        setInputs(null);
      } else {
        const inputRes = await getMortgageProjectionInputs(active[0].id);
        if (inputRes.success && inputRes.data) setInputs(inputRes.data);
      }
    } catch (err) {
      console.error('Failed to load mortgage:', err);
    } finally {
      hasLoadedOnce.current = true;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { if (appContext) appContext.setRefreshCallback(fetchData); }, [appContext, fetchData]);

  const toast = (msg: string, severity: 'success' | 'error' = 'success') =>
    severity === 'success' ? appToast.success('Done', msg) : appToast.error('Error', msg);

  // Compute the full schedule.
  const { months, payoffMonth } = useMemo(() => {
    if (!inputs) return { months: [], payoffMonth: null as string | null };
    const genesis = getMortgageStartDate(inputs.mortgage);
    const maxTerm = Math.max(...inputs.mortgage.loans.map((l) => l.originalTermMonths), 12);
    const end = addMonths(genesis, maxTerm + 24);
    const m = calculateMortgageProjection(inputs, end);
    return { months: m, payoffMonth: getPayoffMonth(m) };
  }, [inputs]);

  const euriborDue = useMemo(
    () => (inputs ? isEuriborUpdateDue(inputs.mortgage, inputs.rates) : null),
    [inputs]
  );

  // Time-windowed slice for the forward-looking charts.
  const windowedMonths = useMemo(() => {
    if (horizon === 'custom') return months;
    const end = addMonths(currentMonth, HORIZON_MONTHS[horizon] ?? 60);
    return months.filter((m) => compareYearMonths(m.yearMonth, end) <= 0);
  }, [months, horizon, currentMonth]);

  const currentRow = useMemo(
    () => months.find((m) => m.yearMonth === currentMonth) ?? [...months].reverse().find((m) => m.isHistorical),
    [months, currentMonth]
  );

  const previewLoans = useMemo(() => {
    if (!inputs || !currentRow) return [];
    return inputs.mortgage.loans.map((loan) => {
      const lr = currentRow.loans.find((l) => l.loanId === loan.id);
      const monthsSinceStart = getMonthsBetween(loan.startDate, currentMonth);
      return {
        label: loan.label,
        balance: lr?.endingPrincipal ?? loan.initialPrincipal,
        remainingMonths: Math.max(1, loan.originalTermMonths - monthsSinceStart),
        margin: loan.margin,
      };
    });
  }, [inputs, currentRow, currentMonth]);

  const expectedByLoan = useMemo(() => {
    const map: Record<string, number> = {};
    if (currentRow) for (const l of currentRow.loans) map[l.loanId] = l.endingPrincipal;
    return map;
  }, [currentRow]);

  const handleDelete = async () => {
    if (!inputs) return;
    if (!confirm('Delete this mortgage for all members? This cannot be undone.')) return;
    const res = await deleteMortgage(inputs.mortgage.id);
    if (res.success) { toast('Mortgage deleted'); fetchData(); }
    else toast(res.error ?? 'Failed to delete', 'error');
  };

  const reconcileMonth = useMemo(
    () => (reconcileYM ? months.find((m) => m.yearMonth === reconcileYM) ?? null : null),
    [reconcileYM, months]
  );

  const handleRevert = async (yearMonth: string) => {
    if (!inputs) return;
    if (!confirm(`Revert ${yearMonth} back to a forecast? Its recorded figures will be removed.`)) return;
    const res = await revertMortgageMonth(inputs.mortgage.id, yearMonth);
    if (res.success) { toast(`${yearMonth} reverted to forecast`); fetchData(); }
    else toast(res.error ?? 'Failed to revert', 'error');
  };

  if (isLoading) {
    return <ChartsPageSkeleton />;
  }

  // Empty state
  if (!inputs) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className={`inline-flex p-4 rounded-full mb-4 ${isDark ? 'bg-gray-800' : 'bg-gray-100'} text-blue-500 text-3xl`}>
          <MdHouse />
        </div>
        <h1 className="text-3xl font-bold mb-2">Track your home loan together</h1>
        <p className="opacity-70 mb-6 max-w-md mx-auto">
          Set up your mortgage once — its loans, the yearly Euribor rate, and your down payments — and Sampolio shows
          the full payment schedule, who owns how much, and your path to an equal split. Share it with your partner so
          you both see the same picture.
        </p>
        <Button label="Set up your mortgage" icon={<MdHouse />} onClick={() => setSetupOpen(true)} />
        <MortgageSetupWizard visible={setupOpen} isSimple={!!isSimple} onClose={() => setSetupOpen(false)} onCreated={() => { setSetupOpen(false); toast('Mortgage created'); fetchData(); }} />
      </div>
    );
  }

  const mortgage = inputs.mortgage;
  const partner = mortgage.members.find((m) => m.userId !== userId);

  // Single "Manage" menu with grouped sections (Loan · Members · Data). The two
  // lifecycle actions stay where they are: the header Euribor button appears
  // only while an update is due, and Reconcile lives on the ledger rows.
  const menuItems = [
    {
      label: 'Loan',
      items: [
        { label: 'Update Euribor rate', icon: 'pi pi-percentage', command: () => setEuriborOpen(true) },
        { label: 'Make an extra payment', icon: 'pi pi-plus-circle', command: () => setExtraOpen(true) },
        { label: 'Correct a balance', icon: 'pi pi-sync', command: () => setDriftOpen(true) },
      ],
    },
    {
      label: 'Members',
      items: [{ label: 'Manage members', icon: 'pi pi-users', command: () => setMembersOpen(true) }],
    },
    {
      label: 'Data',
      items: [
        { label: 'Import actual history', icon: 'pi pi-upload', command: () => setImportOpen(true) },
        { label: 'Delete mortgage', icon: 'pi pi-trash', command: handleDelete },
      ],
    },
  ];

  return (
    <div className="space-y-4 lg:space-y-6 max-w-360 mx-auto py-4 lg:py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className={`text-3xl sm:text-4xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>{mortgage.name}</h1>
          <p className="text-sm opacity-60 mt-1">
            {partner ? `Shared with ${partner.name}` : 'Not shared yet — invite your partner'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {euriborDue?.due && (
            <Button
              label="Update Euribor rate"
              icon={<MdPercent />}
              severity="warning"
              className="flex-1 sm:flex-none"
              onClick={() => setEuriborOpen(true)}
            />
          )}
          <Button label="Manage" icon={<MdMoreVert />} outlined severity="secondary" onClick={(e) => menuRef.current?.toggle(e)} aria-label="Manage mortgage" />
          <Menu model={menuItems} popup ref={menuRef} />
        </div>
      </div>

      {/* Euribor reminder banner */}
      {euriborDue?.due && (
        <AlertBanner
          severity="warn"
          icon={<MdPercent size={20} />}
          action={{ label: 'Update rate', onClick: () => setEuriborOpen(true) }}
        >
          Your mortgage interest rate is due for its yearly update — the bank resets it (the 12-month Euribor reference rate) around {euriborDue.lastResetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Enter the new rate from your bank so your payments stay accurate.
        </AlertBanner>
      )}

      {/* Segmented content: the page was a ~7 000px mobile scroll — tabs keep
          each concern reachable in one tap. Hidden tabs cost nothing: TabView
          renders active-only and every chart is lazy-loaded. */}
      <TabView activeIndex={activeTab} onTabChange={(e) => setActiveTab(e.index)} scrollable>
        <TabPanel header="Overview">
          <div className="space-y-4 lg:space-y-6">
            {/* Simple mode leads with the member's personal picture; the per-loan
                detail cards stay in Advanced (the Charts/Schedule tabs cover them). */}
            {isSimple && (
              <MyMortgageSummaryCard months={months} mortgage={mortgage} currency={mortgage.currency} currentMonth={currentMonth} currentUserId={userId} />
            )}
            <MortgageHeroCard months={months} mortgage={mortgage} currency={mortgage.currency} currentMonth={currentMonth} nextResetDate={euriborDue?.nextResetDate ?? new Date()} payoffMonth={payoffMonth} />
            <OwnershipBalancePanel months={months} mortgage={mortgage} currency={mortgage.currency} currentUserId={userId} currentMonth={currentMonth} isSimple={!!isSimple} />
            {!isSimple && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {mortgage.loans.map((loan) => (
                  <SubLoanCard key={loan.id} loan={loan} months={months} currency={mortgage.currency} currentMonth={currentMonth} isSimple={!!isSimple} />
                ))}
              </div>
            )}
          </div>
        </TabPanel>

        <TabPanel header="Charts">
          <div className="space-y-4 lg:space-y-6">
            <div className="flex items-center justify-end">
              <SelectButton value={horizon} options={HORIZON_OPTIONS} onChange={(e) => e.value && setHorizon(e.value)} className="text-sm" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title="What you still owe, over time"><MortgageBalanceChart months={windowedMonths} mortgage={mortgage} currency={mortgage.currency} /></ChartCard>
              <ChartCard title={`Path to owning the home ${mortgage.members.map((m) => Math.round(m.ownershipTargetPercent * 100)).join('/')}`}><OwnershipProgressChart months={windowedMonths} mortgage={mortgage} currency={mortgage.currency} /></ChartCard>
              {!isSimple && (
                <>
                  <ChartCard title="Where each payment goes"><PrincipalInterestChart months={months} currency={mortgage.currency} /></ChartCard>
                  <ChartCard title="What the loan has cost you so far"><CumulativeCostChart months={windowedMonths} currency={mortgage.currency} /></ChartCard>
                  <ChartCard title="How your rate has changed"><RateHistoryChart months={windowedMonths} mortgage={mortgage} /></ChartCard>
                  <ChartCard title="This month's payment, broken down"><PaymentBreakdownChart month={currentRow} currency={mortgage.currency} /></ChartCard>
                </>
              )}
              <ChartCard title="Your home equity, growing"><EquityBuildupChart months={windowedMonths} mortgage={mortgage} currency={mortgage.currency} /></ChartCard>
              {/* Payoff summary — fills the chart grid's odd cell with the numbers
                  people scroll the charts for. */}
              <Card>
                <h3 className="text-base font-semibold mb-3 flex items-center gap-2"><MdFlag className="text-green-500" />Payoff at a glance</h3>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm opacity-70">Debt-free</span>
                    <span className="font-semibold">{payoffMonth ? formatYearMonth(payoffMonth) : '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm opacity-70">Still owed today</span>
                    <span className="font-semibold">
                      {formatCurrency(Object.values(expectedByLoan).reduce((s, v) => s + v, 0), mortgage.currency)}
                    </span>
                  </div>
                  {euriborDue?.nextResetDate && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm opacity-70">Next Euribor reset</span>
                      <span className="font-semibold">{euriborDue.nextResetDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
                    </div>
                  )}
                  {payoffMonth && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm opacity-70">Months to go</span>
                      <span className="font-semibold">{Math.max(0, getMonthsBetween(currentMonth, payoffMonth))}</span>
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </TabPanel>

        <TabPanel header="Schedule">
          <div className="space-y-4 lg:space-y-6">
            <Card>
              <MortgageLedgerTable
                months={months}
                mortgage={mortgage}
                currency={mortgage.currency}
                showBreakdown={showBreakdown}
                onToggleBreakdown={setShowBreakdown}
                isSimple={!!isSimple}
                onReconcile={setReconcileYM}
                onRevert={handleRevert}
              />
            </Card>
            {!isSimple && (
              <MortgageHistoryStrips
                mortgage={mortgage}
                rates={inputs.rates}
                costs={inputs.costs}
                currency={mortgage.currency}
                onChanged={(msg) => { toast(msg); fetchData(); }}
              />
            )}
          </div>
        </TabPanel>

        <TabPanel header="Tools">
          <MortgageTransferComparison
            inputs={inputs}
            months={months}
            currentRow={currentRow}
            currentMonth={currentMonth}
            currency={mortgage.currency}
          />
        </TabPanel>
      </TabView>

      {/* Dialogs */}
      <EuriborUpdateDialog
        visible={euriborOpen}
        mortgageId={mortgage.id}
        defaultEffectiveMonth={euriborDue?.resetYearMonth ?? currentMonth}
        lastEuribor={inputs.rates[inputs.rates.length - 1]?.euriborRate ?? 0}
        previewLoans={previewLoans}
        currency={mortgage.currency}
        onClose={() => setEuriborOpen(false)}
        onSaved={(msg) => { setEuriborOpen(false); toast(msg); fetchData(); }}
      />
      <DriftAdjustmentDialog
        visible={driftOpen}
        mortgageId={mortgage.id}
        loans={mortgage.loans.map((l) => ({ id: l.id, label: l.label }))}
        expectedByLoan={expectedByLoan}
        currency={mortgage.currency}
        onClose={() => setDriftOpen(false)}
        onSaved={(msg) => { setDriftOpen(false); toast(msg); fetchData(); }}
      />
      <ExtraPaymentDialog
        visible={extraOpen}
        mortgageId={mortgage.id}
        loans={mortgage.loans.map((l) => ({ id: l.id, label: l.label }))}
        currency={mortgage.currency}
        onClose={() => setExtraOpen(false)}
        onSaved={(msg) => { setExtraOpen(false); toast(msg); fetchData(); }}
      />
      <MortgageMembersDialog
        visible={membersOpen}
        mortgage={mortgage}
        currentUserId={userId}
        onClose={() => setMembersOpen(false)}
        onChanged={(msg) => { toast(msg); fetchData(); }}
      />
      <MortgageImportDialog
        visible={importOpen}
        mortgage={mortgage}
        hasActuals={inputs.actuals.length > 0}
        onClose={() => setImportOpen(false)}
        onImported={(msg) => { setImportOpen(false); toast(msg); fetchData(); }}
      />
      <MortgageReconcileDialog
        visible={reconcileYM !== null}
        month={reconcileMonth}
        mortgage={mortgage}
        currency={mortgage.currency}
        onClose={() => setReconcileYM(null)}
        onSaved={(msg) => { setReconcileYM(null); toast(msg); fetchData(); }}
      />
    </div>
  );
}
