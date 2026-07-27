'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { MdArrowBack, MdArrowForward, MdCheck, MdError } from 'react-icons/md';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Steps } from 'primereact/steps';
import { InputNumber } from 'primereact/inputnumber';
import { Dropdown } from 'primereact/dropdown';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { ProgressSpinner } from 'primereact/progressspinner';
import { useTheme } from '@/components/providers/theme-provider';
import { useToast } from '@/components/providers/toast-provider';
import { formatCurrency, formatYearMonth, MONTHS } from '@/lib/constants';
import { getCurrentYearMonth } from '@/lib/projection';
import { getAccounts } from '@/lib/actions/accounts';
import { getInvestmentAccounts } from '@/lib/actions/investments';
import { getReceivables } from '@/lib/actions/receivables';
import { getDebts } from '@/lib/actions/debts';
import { getProjection } from '@/lib/actions/projection';
import {
    startReconciliationSession,
    createBalanceSnapshot,
    completeReconciliationSession,
    applyReconciliationBalances,
} from '@/lib/actions/reconciliation';
import { useAppContext } from '@/components/layout/app-layout';
import type { FinancialAccount, InvestmentAccount, Receivable, Debt, EntityType, Currency } from '@/types';

interface ReconcileWizardProps {
    visible: boolean;
    onHide: () => void;
    onComplete?: () => void;
    initialYearMonth?: string;
}

interface EntityRow {
    entityType: EntityType;
    entityId: string;
    name: string;
    currency: Currency;
    expectedBalance: number;
    actualBalance: number | null;
    variance: number;
    // Debt-specific reconciliation fields
    remainingInstallments?: number | null;
    installmentAmount?: number | null;
}

// Short labels so all three steps fit the width on a phone (each Steps item is
// flex:1 with a nowrap title — long labels overflow their slot and clip).
const WIZARD_STEPS = [
    { label: 'Month' },
    { label: 'Balances' },
    { label: 'Review' },
];

export function ReconcileWizard({
    visible,
    onHide,
    onComplete,
    initialYearMonth,
}: ReconcileWizardProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const appContext = useAppContext();
    const isSimple = appContext?.displayMode === 'simple';

    const [activeStep, setActiveStep] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState('');

    // Step 1: Month selection
    const [selectedYearMonth, setSelectedYearMonth] = useState(initialYearMonth || getCurrentYearMonth());
    const [selectedYear, setSelectedYear] = useState(parseInt(selectedYearMonth.split('-')[0]));
    const [selectedMonth, setSelectedMonth] = useState(parseInt(selectedYearMonth.split('-')[1]));

    // Entity data
    const [entities, setEntities] = useState<EntityRow[]>([]);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const toast = useToast();

    // Fetch all entities
    const fetchEntities = useCallback(async () => {
        setIsLoading(true);
        setError('');

        try {
            const [accountsResult, investmentsResult, receivablesResult, debtsResult] = await Promise.all([
                getAccounts(),
                getInvestmentAccounts(),
                getReceivables(),
                getDebts(),
            ]);

            const rows: EntityRow[] = [];

            // Cash accounts
            if (accountsResult.success && accountsResult.data) {
                for (const account of accountsResult.data.filter((a: FinancialAccount) => !a.isArchived)) {
                    const balance = account.startingBalance;
                    rows.push({
                        entityType: 'cash-account',
                        entityId: account.id,
                        name: account.name,
                        currency: account.currency,
                        expectedBalance: balance,
                        actualBalance: balance,
                        variance: 0,
                    });
                }
            }

            // Investments
            if (investmentsResult.success && investmentsResult.data) {
                for (const investment of investmentsResult.data.filter((i: InvestmentAccount) => !i.isArchived)) {
                    const balance = investment.currentValuation || investment.startingValuation;
                    rows.push({
                        entityType: 'investment',
                        entityId: investment.id,
                        name: investment.name,
                        currency: investment.currency,
                        expectedBalance: balance,
                        actualBalance: balance,
                        variance: 0,
                    });
                }
            }

            // Receivables
            if (receivablesResult.success && receivablesResult.data) {
                for (const receivable of receivablesResult.data.filter((r: Receivable) => !r.isArchived)) {
                    const balance = receivable.currentBalance;
                    rows.push({
                        entityType: 'receivable',
                        entityId: receivable.id,
                        name: receivable.name,
                        currency: receivable.currency,
                        expectedBalance: balance,
                        actualBalance: balance,
                        variance: 0,
                    });
                }
            }

            // Debts – stored and displayed as positive values;
            // the system handles the negative wealth impact internally.
            if (debtsResult.success && debtsResult.data) {
                for (const debt of debtsResult.data.filter((d: Debt) => !d.isArchived)) {
                    rows.push({
                        entityType: 'debt',
                        entityId: debt.id,
                        name: debt.name,
                        currency: debt.currency,
                        expectedBalance: debt.initialPrincipal,
                        actualBalance: debt.initialPrincipal,
                        variance: 0,
                        remainingInstallments: debt.remainingInstallments ?? null,
                        installmentAmount: debt.installmentAmount ?? null,
                    });
                }
            }

            setEntities(rows);
        } catch (err) {
            setError('Failed to load entities');
            console.error(err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (visible) {
            fetchEntities();
            setActiveStep(0);
            setSessionId(null);
            autoStartedRef.current = false;
        }
    }, [visible, fetchEntities]);

    // Update yearMonth when year/month changes
    useEffect(() => {
        setSelectedYearMonth(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}`);
    }, [selectedYear, selectedMonth]);

    const handleActualBalanceChange = (entityId: string, value: number | null) => {
        setEntities(prev => prev.map(e => {
            if (e.entityId === entityId) {
                const actual = value ?? 0;
                // For debts, a decrease is positive for wealth
                const variance = e.entityType === 'debt'
                    ? e.expectedBalance - actual
                    : actual - e.expectedBalance;
                return {
                    ...e,
                    actualBalance: value,
                    variance,
                };
            }
            return e;
        }));
    };

    const handleDebtFieldChange = (entityId: string, field: 'remainingInstallments' | 'installmentAmount', value: number | null) => {
        setEntities(prev => prev.map(e => {
            if (e.entityId === entityId) {
                return { ...e, [field]: value };
            }
            return e;
        }));
    };

    // Refine the "expected" balance for cash accounts to the projected balance
    // for the chosen month, so the variance shown reflects the actual forecast for
    // that month (not just the last stored starting balance). Other entity types
    // keep their current stored value as the expected baseline.
    const refineExpectedBalances = useCallback(async () => {
        const cashRows = entities.filter(e => e.entityType === 'cash-account');
        if (cashRows.length === 0) return;

        const expectedById = new Map<string, number>();
        await Promise.all(cashRows.map(async (row) => {
            try {
                const res = await getProjection(row.entityId);
                if (res.success && res.data) {
                    const month = res.data.monthly.find(m => m.yearMonth === selectedYearMonth);
                    if (month) expectedById.set(row.entityId, month.startingBalance);
                }
            } catch {
                // Non-fatal: fall back to the stored expected balance for this row
            }
        }));

        if (expectedById.size === 0) return;

        setEntities(prev => prev.map(e => {
            if (e.entityType === 'cash-account' && expectedById.has(e.entityId)) {
                const expected = expectedById.get(e.entityId)!;
                // The user hasn't edited anything yet at this point, so pre-fill the
                // actual to the projected value (zero variance until they change it).
                return { ...e, expectedBalance: expected, actualBalance: expected, variance: 0 };
            }
            return e;
        }));
    }, [entities, selectedYearMonth]);

    const handleStartSession = async () => {
        const result = await startReconciliationSession(selectedYearMonth);
        if (result.success && result.data) {
            setSessionId(result.data.id);
            await refineExpectedBalances();
            setActiveStep(1);
        } else {
            setError(result.error || 'Failed to start session');
        }
    };

    // Simple mode is a one-question check-in: skip the month step (current month)
    // and start the session as soon as the entities are loaded. The ref guards
    // against double-starting (React strict-mode re-runs effects in dev).
    const autoStartedRef = useRef(false);
    useEffect(() => {
        if (visible && isSimple && !isLoading && entities.length > 0 && activeStep === 0 && !autoStartedRef.current) {
            autoStartedRef.current = true;
            handleStartSession();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, isSimple, isLoading, entities.length, activeStep]);

    const handleComplete = async () => {
        if (!sessionId) return;

        setIsSaving(true);
        setError('');

        try {
            // Create a snapshot for every confirmed balance (non-null), not only
            // changed ones. The confirmed balance is the anchor projections re-base
            // on, so recording it every month keeps forecasts correct even when a
            // balance happens to match the projection (zero variance).
            for (const entity of entities) {
                if (entity.actualBalance !== null) {
                    // Store debt snapshots as negative values for historical consistency
                    const sign = entity.entityType === 'debt' ? -1 : 1;
                    await createBalanceSnapshot({
                        entityType: entity.entityType,
                        entityId: entity.entityId,
                        yearMonth: selectedYearMonth,
                        expectedBalance: entity.expectedBalance * sign,
                        actualBalance: entity.actualBalance * sign,
                    });
                }
            }

            // Apply actual balances to the entities so current-state displays use
            // the reconciled values going forward
            const entriesToApply = entities
                .filter(e => e.actualBalance !== null)
                .map(e => ({
                    entityType: e.entityType,
                    entityId: e.entityId,
                    // Debts are stored as positive in UI; negate for the action
                    // (which calls Math.abs internally, so sign doesn't matter)
                    actualBalance: e.entityType === 'debt' ? -e.actualBalance! : e.actualBalance!,
                    // Include debt-specific fields when present
                    ...(e.entityType === 'debt' && e.remainingInstallments != null
                        ? { remainingInstallments: e.remainingInstallments }
                        : {}),
                    ...(e.entityType === 'debt' && e.installmentAmount != null
                        ? { installmentAmount: e.installmentAmount }
                        : {}),
                }));

            if (entriesToApply.length > 0) {
                const applyResult = await applyReconciliationBalances(entriesToApply);
                if (!applyResult.success) {
                    setError(applyResult.error || 'Failed to apply balances');
                    setIsSaving(false);
                    return;
                }
            }

            // Complete the session
            await completeReconciliationSession(sessionId);

            // Confirm to the user that the check-in landed and projections moved.
            const changedCount = entities.filter(e => e.actualBalance !== null && e.variance !== 0).length;
            toast.show({
                severity: 'success',
                summary: 'Check-in saved',
                detail: changedCount > 0
                    ? `${formatYearMonth(selectedYearMonth)}: ${changedCount} ${changedCount === 1 ? 'balance' : 'balances'} updated — your forecasts are now anchored here.`
                    : `${formatYearMonth(selectedYearMonth)}: balances confirmed — your forecasts are now anchored here.`,
                life: 4000,
            });

            onComplete?.();
            onHide();
        } catch (err) {
            setError('Failed to complete reconciliation');
            console.error(err);
        } finally {
            setIsSaving(false);
        }
    };

    const entitiesWithVariance = entities.filter(e => e.actualBalance !== null && e.variance !== 0);
    const entitiesChanged = entitiesWithVariance;
    const totalVariance = entitiesWithVariance.reduce((sum, e) => sum + e.variance, 0);

    const yearOptions = Array.from({ length: 5 }, (_, i) => {
        const year = new Date().getFullYear() - 2 + i;
        return { label: String(year), value: year };
    });

    const monthOptions = MONTHS.map((name, i) => ({
        label: name,
        value: i + 1,
    }));

    const renderEntityTypeLabel = (type: EntityType) => {
        const labels: Record<EntityType, { label: string; severity: 'info' | 'success' | 'warning' | 'danger' }> = {
            'cash-account': { label: 'Cash', severity: 'info' },
            'investment': { label: 'Investment', severity: 'success' },
            'receivable': { label: 'Receivable', severity: 'warning' },
            'debt': { label: 'Debt', severity: 'danger' },
        };
        const config = labels[type];
        return <Tag value={config.label} severity={config.severity} />;
    };

    const renderStep = () => {
        if (isLoading) {
            return (
                <div className="flex items-center justify-center py-12">
                    <ProgressSpinner style={{ width: '50px', height: '50px' }} />
                </div>
            );
        }

        switch (activeStep) {
            case 0: // Select Month
                // Simple mode auto-starts on the current month; show a brief
                // spinner instead of flashing the month picker.
                if (isSimple) {
                    return (
                        <div className="flex items-center justify-center py-12">
                            <ProgressSpinner style={{ width: '50px', height: '50px' }} />
                        </div>
                    );
                }
                return (
                    <div className="space-y-6">
                        <p className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                            Time for a quick check-in! Pick the month you want to review.
                            We&apos;ll compare what we expected with what actually happened, so your projections stay accurate.
                        </p>

                        <div className="flex gap-4">
                            <div className="flex-1 min-w-0">
                                <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Year
                                </label>
                                <Dropdown
                                    value={selectedYear}
                                    options={yearOptions}
                                    onChange={(e) => setSelectedYear(e.value)}
                                    className="w-full"
                                />
                            </div>
                            <div className="flex-1 min-w-0">
                                <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Month
                                </label>
                                <Dropdown
                                    value={selectedMonth}
                                    options={monthOptions}
                                    onChange={(e) => setSelectedMonth(e.value)}
                                    className="w-full"
                                />
                            </div>
                        </div>

                        <Card className="mt-6">
                            <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                <p className="font-medium mb-2">What we&apos;ll check:</p>
                                <ul className="list-disc list-inside space-y-1">
                                    <li>{entities.filter(e => e.entityType === 'cash-account').length} Cash Accounts</li>
                                    <li>{entities.filter(e => e.entityType === 'investment').length} Investments</li>
                                    <li>{entities.filter(e => e.entityType === 'receivable').length} Receivables</li>
                                    <li>{entities.filter(e => e.entityType === 'debt').length} Debts</li>
                                </ul>
                            </div>
                        </Card>
                    </div>
                );

            case 1: // Enter Balances
                return (
                    <div className="space-y-4">
                        <p className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                            {isSimple
                                ? <>Enter what your bank shows for {formatYearMonth(selectedYearMonth)} — that&apos;s the whole check-in. We&apos;ve pre-filled what we expect, so only change what&apos;s different. Nothing is deleted or changed elsewhere; this just keeps your forecast accurate.</>
                                : <>Check your actual balances for {formatYearMonth(selectedYearMonth)}. We&apos;ve pre-filled what we expect — just update anything that&apos;s different.</>}
                        </p>

                        {['cash-account', 'investment', 'receivable', 'debt'].map((type) => {
                            const typeEntities = entities.filter(e => e.entityType === type);
                            if (typeEntities.length === 0) return null;

                            return (
                                <div key={type} className="mb-6">
                                    <h3 className={`text-sm font-semibold uppercase tracking-wide mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        {type === 'cash-account' ? 'Cash Accounts' :
                                            type === 'investment' ? 'Investments' :
                                                type === 'receivable' ? 'Receivables' : 'Debts'}
                                    </h3>
                                    <div className="space-y-3">
                                        {typeEntities.map((entity) => (
                                            <div
                                                key={entity.entityId}
                                                className={`p-4 rounded-lg border ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
                                            >
                                                <div className="flex items-center justify-between mb-2">
                                                    <span className={`font-medium ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                                        {entity.name}
                                                    </span>
                                                    {renderEntityTypeLabel(entity.entityType)}
                                                </div>
                                                <div className={`flex items-center flex-wrap gap-x-3 gap-y-1 mb-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                    <span>Expected: <strong className={isDark ? 'text-gray-200' : 'text-gray-700'}>{formatCurrency(entity.expectedBalance, entity.currency)}</strong></span>
                                                    {entity.actualBalance !== null && entity.variance !== 0 && (
                                                        <>
                                                            <span className={isDark ? 'text-gray-600' : 'text-gray-300'}>&rarr;</span>
                                                            <span>Actual: <strong className={isDark ? 'text-gray-200' : 'text-gray-700'}>{formatCurrency(entity.actualBalance, entity.currency)}</strong></span>
                                                            <Tag
                                                                value={`${entity.variance >= 0 ? '+' : ''}${formatCurrency(entity.variance, entity.currency)}`}
                                                                severity={entity.variance >= 0 ? 'success' : 'danger'}
                                                            />
                                                        </>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-4">
                                                    <div className="flex-1">
                                                        <InputNumber
                                                            value={entity.actualBalance}
                                                            onValueChange={(e) => handleActualBalanceChange(entity.entityId, e.value ?? null)}
                                                            mode="currency"
                                                            currency={entity.currency}
                                                            locale="fi-FI"
                                                            placeholder="Enter actual balance"
                                                            className="w-full"
                                                        />
                                                    </div>
                                                </div>
                                                {entity.entityType === 'debt' && !isSimple && (
                                                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 mt-3">
                                                        <div className="flex-1 min-w-0">
                                                            <label className={`text-xs mb-1 block ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                                Remaining Installments
                                                            </label>
                                                            <InputNumber
                                                                value={entity.remainingInstallments}
                                                                onValueChange={(e) => handleDebtFieldChange(entity.entityId, 'remainingInstallments', e.value ?? null)}
                                                                locale="fi-FI"
                                                                placeholder="Remaining installments"
                                                                className="w-full"
                                                                min={0}
                                                            />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <label className={`text-xs mb-1 block ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                                Installment Amount
                                                            </label>
                                                            <InputNumber
                                                                value={entity.installmentAmount}
                                                                onValueChange={(e) => handleDebtFieldChange(entity.entityId, 'installmentAmount', e.value ?? null)}
                                                                mode="currency"
                                                                currency={entity.currency}
                                                                locale="fi-FI"
                                                                placeholder="Installment amount"
                                                                className="w-full"
                                                                min={0}
                                                            />
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                );

            case 2: // Review & Confirm
                return (
                    <div className="space-y-6">
                        <div className={`p-6 rounded-lg ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
                            <h3 className={`text-lg font-semibold mb-4 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                Reconciliation Summary for {formatYearMonth(selectedYearMonth)}
                            </h3>

                            <div className="grid grid-cols-2 gap-4 mb-6">
                                <div>
                                    <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        Entities Changed
                                    </span>
                                    <p className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                        {entitiesChanged.length}
                                    </p>
                                </div>
                                <div>
                                    <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                        Total Variance
                                    </span>
                                    <p className={`text-2xl font-bold ${totalVariance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                        {totalVariance >= 0 ? '+' : ''}{formatCurrency(totalVariance, entities[0]?.currency || 'EUR')}
                                    </p>
                                </div>
                            </div>

                            {entitiesChanged.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                        Changes
                                    </h4>
                                    {entitiesChanged.map((entity) => (
                                        <div key={entity.entityId} className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
                                            <div className="flex items-center gap-2">
                                                {renderEntityTypeLabel(entity.entityType)}
                                                <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                                                    {entity.name}
                                                </span>
                                            </div>
                                            <div className="text-right">
                                                <span className={isDark ? 'text-gray-100' : 'text-gray-900'}>
                                                    {formatCurrency(entity.actualBalance || 0, entity.currency)}
                                                </span>
                                                <span className={`ml-2 text-sm ${entity.variance >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                    ({entity.variance >= 0 ? '+' : ''}{formatCurrency(entity.variance, entity.currency)})
                                                </span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {entitiesChanged.length === 0 && (
                            <div className={`flex items-center justify-center py-4 ${isDark ? 'text-green-400' : 'text-green-600'}`}>
                                <MdCheck className="mr-2" />
                                All balances match — we&apos;ll still record this check-in to keep your forecasts anchored.
                            </div>
                        )}
                    </div>
                );

            default:
                return null;
        }
    };

    const renderFooter = () => {
        const canProceed = () => {
            switch (activeStep) {
                case 0: return entities.length > 0;
                case 1: return true; // Can proceed without entering all balances
                // Allow completing even when nothing changed — recording the
                // check-in still anchors this month's balances for projections.
                case 2: return entities.some(e => e.actualBalance !== null);
                default: return false;
            }
        };

        // Simple mode: one screen, one button — enter balances, save.
        if (isSimple) {
            return (
                <div className="flex justify-end pt-4">
                    <Button
                        label="Save check-in"
                        icon={<MdCheck />}
                        severity="success"
                        onClick={handleComplete}
                        loading={isSaving}
                        disabled={activeStep === 0 || !sessionId || !entities.some(e => e.actualBalance !== null)}
                    />
                </div>
            );
        }

        return (
            <div className="flex justify-between pt-4">
                <Button
                    label="Back"
                    icon={<MdArrowBack />}
                    text
                    onClick={() => setActiveStep(s => s - 1)}
                    disabled={activeStep === 0}
                />
                {activeStep < 2 ? (
                    <Button
                        label="Continue"
                        icon={<MdArrowForward />}
                        iconPos="right"
                        onClick={() => {
                            if (activeStep === 0) {
                                handleStartSession();
                            } else {
                                setActiveStep(s => s + 1);
                            }
                        }}
                        disabled={!canProceed()}
                    />
                ) : (
                    <Button
                        label="Save check-in"
                        icon={<MdCheck />}
                        severity="success"
                        onClick={handleComplete}
                        loading={isSaving}
                        disabled={!canProceed()}
                    />
                )}
            </div>
        );
    };

    return (
        <>
        <Dialog
            visible={visible}
            onHide={onHide}
            header="Monthly Check-in"
            style={{ width: '700px', maxWidth: '95vw' }}
            modal
            dismissableMask
            footer={renderFooter()}
        >
            <div className="space-y-6">
                {!isSimple && <Steps model={WIZARD_STEPS} activeIndex={activeStep} readOnly />}

                {error && (
                    <div className="flex items-center p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500">
                        <MdError className="mr-2" />
                        {error}
                    </div>
                )}

                <div className="min-h-100">
                    {renderStep()}
                </div>
            </div>
        </Dialog>
        </>
    );
}
