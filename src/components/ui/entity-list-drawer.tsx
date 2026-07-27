'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { Sidebar } from 'primereact/sidebar';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown, DropdownChangeEvent } from 'primereact/dropdown';
import { Checkbox } from 'primereact/checkbox';
import { ProgressSpinner } from 'primereact/progressspinner';
import { Message } from 'primereact/message';
import { Tooltip } from 'primereact/tooltip';
import { MdAccountBalanceWallet, MdBarChart, MdGroup, MdCreditCard, MdAdd, MdCheck, MdInfo, MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { formatCurrency, formatYearMonth, CURRENCIES, FREQUENCIES, PLANNING_HORIZONS } from '@/lib/constants';
import { getCurrentYearMonth, addMonths } from '@/lib/projection';
import { getDebtPayoffInfo } from '@/lib/debt-utils';
import { calculateDebtAmortization } from '@/lib/wealth-projection';
import { DebtProgressCard } from '@/components/ui/debt-progress-card';
import { useAppContext } from '@/components/layout/app-layout';
import { HelpTip, MonthPicker, ItemCard, SubEntityList } from '@/components/ui/form-primitives';
import { useToast } from '@/components/providers/toast-provider';
import {
    getAccounts,
    createAccount,
    updateAccount,
    deleteAccount as deleteAccountAction,
} from '@/lib/actions/accounts';
import {
    getInvestmentAccounts,
    createInvestmentAccount,
    updateInvestmentAccount,
    deleteInvestmentAccount,
    getContributions,
    createContribution,
    updateContribution,
    deleteContribution,
} from '@/lib/actions/investments';
import {
    getReceivables,
    createReceivable,
    updateReceivable,
    deleteReceivable as deleteReceivableAction,
    getRepayments,
    createRepayment,
    deleteRepayment as deleteRepaymentAction,
} from '@/lib/actions/receivables';
import {
    getDebts,
    createDebt,
    updateDebt,
    deleteDebt as deleteDebtAction,
    getReferenceRates,
    setReferenceRate,
    deleteReferenceRate as deleteReferenceRateAction,
    getExtraPayments,
    createExtraPayment,
    deleteExtraPayment as deleteExtraPaymentAction,
} from '@/lib/actions/debts';
import type {
    FinancialAccount,
    InvestmentAccount,
    InvestmentContribution,
    Receivable,
    ReceivableRepayment,
    Debt,
    DebtReferenceRate,
    DebtExtraPayment,
    Currency,
    Frequency,
} from '@/types';

// ──── Helpers ────

type EntityCategory = 'cash' | 'investments' | 'receivables' | 'debts';

interface EntityListDrawerProps {
    visible: boolean;
    category: EntityCategory;
    onClose: () => void;
    onRefresh?: () => void;
    editEntityId?: string;
}

const categoryConfig = {
    cash: { title: 'Cash Accounts', icon: <MdAccountBalanceWallet />, color: 'text-green-500', description: 'Manage your bank and cash accounts. These are the foundation for tracking income, expenses, and projections.' },
    investments: { title: 'Investments', icon: <MdBarChart />, color: 'text-blue-500', description: 'Track investment portfolios, stocks, and funds. Set an expected growth rate and manage contributions.' },
    receivables: { title: 'Receivables', icon: <MdGroup />, color: 'text-yellow-500', description: 'Money owed to you — personal loans, deposits, or any amount you expect to receive back.' },
    debts: { title: 'Debts', icon: <MdCreditCard />, color: 'text-red-500', description: 'Track loans, mortgages, and other debts. Monitor how they diminish over time with payments.' },
};

// ──── Form Components ────

function AccountForm({ account, onSave, onCancel }: {
    account: FinancialAccount | null;
    onSave: () => void;
    onCancel: () => void;
}) {
    const toast = useToast();
    const [name, setName] = useState(account?.name || '');
    const [currency, setCurrency] = useState(account?.currency || 'EUR');
    const [startingBalance, setStartingBalance] = useState(account?.startingBalance || 0);
    const [startingDate, setStartingDate] = useState(account?.startingDate || getCurrentYearMonth());
    const [planningHorizonMonths, setPlanningHorizonMonths] = useState(account?.planningHorizonMonths || 36);
    const [customEndDate, setCustomEndDate] = useState(account?.customEndDate || '');
    // Hidden by default — the start month is auto-managed. Only auto-expand for an
    // existing account whose start month isn't the current month (e.g. backfilled history).
    const [showAdvanced, setShowAdvanced] = useState(!!account && account.startingDate !== getCurrentYearMonth());
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        if (!name.trim()) { setError('Account name is required.'); return; }
        setError('');
        setIsSaving(true);
        try {
            const payload = { name, currency: currency as Currency, startingBalance, startingDate, planningHorizonMonths, customEndDate: planningHorizonMonths === -1 ? customEndDate : undefined };
            const result = account ? await updateAccount(account.id, payload) : await createAccount(payload);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', account ? 'Account updated successfully' : 'Account created successfully');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="A cash account represents a bank account or wallet. It's the starting point for tracking your income, expenses, and balance projections." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Account Name</label>
                <InputText placeholder="e.g., Main Checking Account" value={name} onChange={(e) => setName(e.target.value)} />
                <HelpTip text="Give your account a memorable name to easily identify it." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Currency</label>
                <Dropdown value={currency} onChange={(e: DropdownChangeEvent) => setCurrency(e.value)} options={CURRENCIES} optionLabel="label" optionValue="value" placeholder="Select currency" />
                <HelpTip text="The currency used for all amounts in this account." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Starting Balance</label>
                <InputNumber value={startingBalance} onValueChange={(e) => setStartingBalance(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Current account balance" />
                <HelpTip text="Your current account balance. Projections are calculated from this amount." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Planning Horizon</label>
                <Dropdown value={planningHorizonMonths} onChange={(e: DropdownChangeEvent) => setPlanningHorizonMonths(e.value)} options={PLANNING_HORIZONS} optionLabel="label" optionValue="value" placeholder="How far ahead to project" />
                <HelpTip text="How many months into the future to project your balance." />
            </div>

            {planningHorizonMonths === -1 && (
                <div className="flex flex-col gap-1">
                    <label className="font-medium text-sm">Custom End Date</label>
                    <MonthPicker value={customEndDate} onChange={setCustomEndDate} placeholder="Projection end date" helpText="The last month to include in projections." />
                </div>
            )}

            <div>
                <button type="button" onClick={() => setShowAdvanced(v => !v)} className="text-sm text-accent-500 hover:underline transition-colors duration-150 active:text-accent-700">
                    {showAdvanced ? 'Hide advanced options' : 'Advanced options'}
                </button>
            </div>

            {showAdvanced && (
                <div className="flex flex-col gap-1">
                    <label className="font-medium text-sm">History Start Month</label>
                    <MonthPicker value={startingDate} onChange={setStartingDate} placeholder="When to start projections" helpText="The month your history begins. Defaults to the current month — you normally don't need to change it. After each monthly check-in, projections automatically re-anchor on your latest confirmed balance." />
                </div>
            )}

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label={account ? 'Save Changes' : 'Create Account'} icon={account ? <MdCheck /> : <MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

function InvestmentForm({ investment, onSave, onCancel }: { investment: InvestmentAccount | null; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [name, setName] = useState(investment?.name || '');
    const [description, setDescription] = useState(investment?.description || '');
    const [currency, setCurrency] = useState<Currency>(investment?.currency || 'EUR');
    const [startingValuation, setStartingValuation] = useState(investment?.startingValuation || 0);
    const [valuationDate, setValuationDate] = useState(investment?.valuationDate || getCurrentYearMonth());
    const [annualGrowthRate, setAnnualGrowthRate] = useState(investment?.annualGrowthRate || 7);
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        if (!name.trim()) { setError('Investment name is required.'); return; }
        setError('');
        setIsSaving(true);
        try {
            const payload = { name, description: description || undefined, currency, startingValuation, valuationDate, annualGrowthRate };
            const result = investment ? await updateInvestmentAccount(investment.id, payload) : await createInvestmentAccount(payload);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', investment ? 'Investment updated successfully' : 'Investment created successfully');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="Track an investment such as stocks, ETFs, or a retirement fund. Set the expected annual growth rate and the app will project its future value." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Name</label>
                <InputText placeholder="e.g., Index Fund Portfolio" value={name} onChange={(e) => setName(e.target.value)} />
                <HelpTip text="A descriptive name for this investment." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputTextarea placeholder="Additional notes about this investment" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Currency</label>
                <Dropdown value={currency} onChange={(e: DropdownChangeEvent) => setCurrency(e.value)} options={CURRENCIES} optionLabel="label" optionValue="value" />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Current Valuation</label>
                <InputNumber value={startingValuation} onValueChange={(e) => setStartingValuation(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Current total value" />
                <HelpTip text="The current market value of this investment." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Valuation Date</label>
                <MonthPicker value={valuationDate} onChange={setValuationDate} placeholder="When was this valued?" helpText="The month when the valuation was last updated." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Expected Annual Growth Rate</label>
                <InputNumber value={annualGrowthRate} onValueChange={(e) => setAnnualGrowthRate(e.value || 0)} suffix=" %" locale="fi-FI" minFractionDigits={1} maxFractionDigits={2} placeholder="e.g., 7" />
                <HelpTip text="The average yearly return you expect. Historical stock market average is ~7%. Use a conservative estimate." />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label={investment ? 'Save Changes' : 'Create Investment'} icon={investment ? <MdCheck /> : <MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

const CONTRIBUTION_TYPES = [{ label: 'Contribution', value: 'contribution' }, { label: 'Withdrawal', value: 'withdrawal' }];
const CONTRIBUTION_KINDS = [{ label: 'One-off', value: 'one-off' }, { label: 'Recurring', value: 'recurring' }];

function ContributionForm({ investmentId, contribution, currency, onSave, onCancel }: { investmentId: string; contribution: InvestmentContribution | null; currency: Currency; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [contribType, setContribType] = useState<'contribution' | 'withdrawal'>(contribution?.type || 'contribution');
    const [contribKind, setContribKind] = useState<'one-off' | 'recurring'>(contribution?.kind || 'one-off');
    const [amount, setAmount] = useState(contribution?.amount || 0);
    const [scheduledDate, setScheduledDate] = useState(contribution?.scheduledDate || getCurrentYearMonth());
    const [startDate, setStartDate] = useState(contribution?.startDate || getCurrentYearMonth());
    const [endDate, setEndDate] = useState(contribution?.endDate || '');
    const [frequency, setFrequency] = useState<Frequency>(contribution?.frequency || 'monthly');
    const [description, setDescription] = useState(contribution?.description || '');
    const [isActive, setIsActive] = useState(contribution?.isActive ?? true);
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        setError('');
        setIsSaving(true);
        try {
            const payload = {
                type: contribType, kind: contribKind, amount,
                scheduledDate: contribKind === 'one-off' ? scheduledDate : undefined,
                startDate: contribKind === 'recurring' ? startDate : undefined,
                endDate: contribKind === 'recurring' && endDate ? endDate : undefined,
                frequency: contribKind === 'recurring' ? frequency : undefined,
                description: description || undefined, isActive,
            };
            const result = contribution ? await updateContribution(investmentId, contribution.id, payload) : await createContribution(investmentId, payload);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', contribution ? 'Contribution updated' : 'Contribution added');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="A contribution adds money to this investment; a withdrawal takes money out. Set it as one-off for a single event, or recurring for a regular schedule." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Type</label>
                <Dropdown value={contribType} onChange={(e: DropdownChangeEvent) => setContribType(e.value)} options={CONTRIBUTION_TYPES} optionLabel="label" optionValue="value" />
                <HelpTip text="Contribution = money going in. Withdrawal = money coming out." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Kind</label>
                <Dropdown value={contribKind} onChange={(e: DropdownChangeEvent) => setContribKind(e.value)} options={CONTRIBUTION_KINDS} optionLabel="label" optionValue="value" />
                <HelpTip text="One-off = happens once. Recurring = repeats on a schedule." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Amount</label>
                <InputNumber value={amount} onValueChange={(e) => setAmount(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" />
            </div>

            {contribKind === 'one-off' && (
                <div className="flex flex-col gap-1">
                    <label className="font-medium text-sm">Scheduled Date</label>
                    <MonthPicker value={scheduledDate} onChange={setScheduledDate} placeholder="When will this happen?" helpText="The month this one-off contribution or withdrawal occurs." />
                </div>
            )}
            {contribKind === 'recurring' && (
                <>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Frequency</label>
                        <Dropdown value={frequency} onChange={(e: DropdownChangeEvent) => setFrequency(e.value)} options={FREQUENCIES} optionLabel="label" optionValue="value" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Start Date</label>
                        <MonthPicker value={startDate} onChange={setStartDate} placeholder="First occurrence" helpText="The month the recurring contribution begins." />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">End Date (optional)</label>
                        <MonthPicker value={endDate} onChange={setEndDate} placeholder="Leave empty for indefinite" helpText="Leave empty if this continues indefinitely." />
                    </div>
                </>
            )}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputText placeholder="e.g., Monthly auto-invest" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="flex items-center gap-2">
                <Checkbox inputId="contribActive" checked={isActive} onChange={(e) => setIsActive(e.checked ?? true)} />
                <label htmlFor="contribActive" className="text-sm">Active</label>
                <Tooltip target=".contribActiveHelp" />
                <MdInfo className="contribActiveHelp text-xs opacity-50 cursor-help" data-pr-tooltip="Inactive contributions are paused and won't affect projections" data-pr-position="top" />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label={contribution ? 'Save' : 'Create'} icon={contribution ? <MdCheck /> : <MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

function ReceivableForm({ receivable, onSave, onCancel }: { receivable: Receivable | null; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [name, setName] = useState(receivable?.name || '');
    const [description, setDescription] = useState(receivable?.description || '');
    const [currency, setCurrency] = useState<Currency>(receivable?.currency || 'EUR');
    const [initialPrincipal, setInitialPrincipal] = useState(receivable?.initialPrincipal || 0);
    const [startDate, setStartDate] = useState(receivable?.startDate || getCurrentYearMonth());
    const [hasInterest, setHasInterest] = useState(receivable?.hasInterest ?? false);
    const [annualInterestRate, setAnnualInterestRate] = useState(receivable?.annualInterestRate || 0);
    const [expectedMonthlyRepayment, setExpectedMonthlyRepayment] = useState(receivable?.expectedMonthlyRepayment || 0);
    const [note, setNote] = useState(receivable?.note || '');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        if (!name.trim()) { setError('Name is required.'); return; }
        setError('');
        setIsSaving(true);
        try {
            const payload = { name, description: description || undefined, currency, initialPrincipal, startDate, hasInterest, annualInterestRate: hasInterest ? annualInterestRate : undefined, expectedMonthlyRepayment: expectedMonthlyRepayment || undefined, note: note || undefined };
            const result = receivable ? await updateReceivable(receivable.id, payload) : await createReceivable(payload);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', receivable ? 'Receivable updated successfully' : 'Receivable created successfully');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="A receivable is money someone owes you — e.g., a personal loan you gave to a friend. Track the amount, expected repayments, and optional interest." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Name</label>
                <InputText placeholder="e.g., Loan to John" value={name} onChange={(e) => setName(e.target.value)} />
                <HelpTip text="Who owes you and/or a description of what this receivable is for." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputTextarea placeholder="Additional details or notes" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Currency</label>
                <Dropdown value={currency} onChange={(e: DropdownChangeEvent) => setCurrency(e.value)} options={CURRENCIES} optionLabel="label" optionValue="value" />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Initial Principal</label>
                <InputNumber value={initialPrincipal} onValueChange={(e) => setInitialPrincipal(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Total amount owed to you" />
                <HelpTip text="The total original amount that was lent or is owed to you." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Start Date</label>
                <MonthPicker value={startDate} onChange={setStartDate} placeholder="When the receivable was created" helpText="The month the receivable started (e.g., when you lent the money)." />
            </div>

            <div className="flex items-center gap-2">
                <Checkbox inputId="hasInterest" checked={hasInterest} onChange={(e) => setHasInterest(e.checked ?? false)} />
                <label htmlFor="hasInterest" className="text-sm">Earns Interest</label>
                <Tooltip target=".interestHelp" />
                <MdInfo className="interestHelp text-xs opacity-50 cursor-help" data-pr-tooltip="Check if the person is paying interest on the amount owed" data-pr-position="top" />
            </div>

            {hasInterest && (
                <div className="flex flex-col gap-1">
                    <label className="font-medium text-sm">Annual Interest Rate</label>
                    <InputNumber value={annualInterestRate} onValueChange={(e) => setAnnualInterestRate(e.value || 0)} suffix=" %" locale="fi-FI" minFractionDigits={1} maxFractionDigits={3} placeholder="e.g., 5" />
                    <HelpTip text="The yearly interest rate applied to the outstanding balance." />
                </div>
            )}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Expected Monthly Repayment</label>
                <InputNumber value={expectedMonthlyRepayment} onValueChange={(e) => setExpectedMonthlyRepayment(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="How much do you expect per month?" />
                <HelpTip text="The amount you expect to receive each month. Used for projecting when the receivable will be fully repaid." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Note (optional)</label>
                <InputText placeholder="Any additional notes" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label={receivable ? 'Save Changes' : 'Create Receivable'} icon={receivable ? <MdCheck /> : <MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

function RepaymentForm({ receivableId, currency, onSave, onCancel }: { receivableId: string; currency: Currency; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [date, setDate] = useState(getCurrentYearMonth());
    const [amount, setAmount] = useState(0);
    const [description, setDescription] = useState('');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        setError('');
        setIsSaving(true);
        try {
            const result = await createRepayment(receivableId, { date, amount, description: description || undefined });
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', 'Repayment recorded');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="Record an actual repayment you received. This reduces the outstanding balance of the receivable." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Date</label>
                <MonthPicker value={date} onChange={setDate} placeholder="When was this received?" helpText="The month you received this repayment." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Amount Received</label>
                <InputNumber value={amount} onValueChange={(e) => setAmount(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Amount received" />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputText placeholder="e.g., Bank transfer from John" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label="Add Repayment" icon={<MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

const DEBT_TYPES = [
    { label: 'Amortized Loan', value: 'amortized', description: 'A standard loan with monthly payments that include both principal and interest (e.g., mortgages, car loans)' },
    { label: 'Fixed Installment', value: 'fixed-installment', description: 'A loan repaid in equal installments of a fixed amount (e.g., buy-now-pay-later plans)' },
];
const INTEREST_MODELS = [
    { label: 'None', value: 'none' },
    { label: 'Fixed Rate', value: 'fixed' },
    { label: 'Variable Rate', value: 'variable' },
];

function DebtForm({ debt, onSave, onCancel }: { debt: Debt | null; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [name, setName] = useState(debt?.name || '');
    const [description, setDescription] = useState(debt?.description || '');
    const [currency, setCurrency] = useState<Currency>(debt?.currency || 'EUR');
    const [debtType, setDebtType] = useState(debt?.debtType || 'amortized');
    const [initialPrincipal, setInitialPrincipal] = useState(debt?.initialPrincipal || 0);
    const [startDate, setStartDate] = useState(debt?.startDate || getCurrentYearMonth());
    const [interestModelType, setInterestModelType] = useState(debt?.interestModelType || 'fixed');
    const [fixedInterestRate, setFixedInterestRate] = useState(debt?.fixedInterestRate || 0);
    const [referenceRateMargin, setReferenceRateMargin] = useState(debt?.referenceRateMargin || 0);
    const [monthlyPayment, setMonthlyPayment] = useState(debt?.monthlyPayment || 0);
    const [installmentAmount, setInstallmentAmount] = useState(debt?.installmentAmount || 0);
    const [totalInstallments, setTotalInstallments] = useState(debt?.totalInstallments || 0);
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        if (!name.trim()) { setError('Debt name is required.'); return; }
        setError('');
        setIsSaving(true);
        try {
            const payload = {
                name, description: description || undefined, currency, debtType, initialPrincipal, startDate,
                interestModelType: debtType === 'amortized' ? interestModelType : undefined,
                fixedInterestRate: interestModelType === 'fixed' ? fixedInterestRate : undefined,
                referenceRateMargin: interestModelType === 'variable' ? referenceRateMargin : undefined,
                monthlyPayment: debtType === 'amortized' ? monthlyPayment || undefined : undefined,
                installmentAmount: debtType === 'fixed-installment' ? installmentAmount || undefined : undefined,
                totalInstallments: debtType === 'fixed-installment' ? totalInstallments || undefined : undefined,
            };
            const result = debt ? await updateDebt(debt.id, payload) : await createDebt(payload);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', debt ? 'Debt updated successfully' : 'Debt created successfully');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="Track a debt like a mortgage, car loan, or personal loan. The app will project how the balance decreases over time as you make payments." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Name</label>
                <InputText placeholder="e.g., Home Mortgage" value={name} onChange={(e) => setName(e.target.value)} />
                <HelpTip text="A descriptive name for this debt." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputTextarea placeholder="Additional notes about this debt" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Currency</label>
                <Dropdown value={currency} onChange={(e: DropdownChangeEvent) => setCurrency(e.value)} options={CURRENCIES} optionLabel="label" optionValue="value" />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Debt Type</label>
                <Dropdown value={debtType} onChange={(e: DropdownChangeEvent) => setDebtType(e.value)} options={DEBT_TYPES} optionLabel="label" optionValue="value" />
                <HelpTip text={debtType === 'amortized'
                    ? 'An amortized loan calculates interest on the remaining balance each month. Your monthly payment stays the same, but the interest/principal split changes over time.'
                    : 'A fixed installment debt is repaid in equal payments of a set amount, without interest calculations. Common for buy-now-pay-later or interest-free plans.'} />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Initial Principal</label>
                <InputNumber value={initialPrincipal} onValueChange={(e) => setInitialPrincipal(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Total amount borrowed" />
                <HelpTip text="The total amount originally borrowed or currently owed." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Start Date</label>
                <MonthPicker value={startDate} onChange={setStartDate} placeholder="When did the debt start?" helpText="The month the debt originated or the first payment was due." />
            </div>

            {debtType === 'amortized' && (
                <>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Interest Model</label>
                        <Dropdown value={interestModelType} onChange={(e: DropdownChangeEvent) => setInterestModelType(e.value)} options={INTEREST_MODELS} optionLabel="label" optionValue="value" />
                        <HelpTip text="Fixed = the rate stays the same. Variable = the rate changes based on a reference rate (e.g., Euribor). None = no interest." />
                    </div>
                    {interestModelType === 'fixed' && (
                        <div className="flex flex-col gap-1">
                            <label className="font-medium text-sm">Fixed Interest Rate</label>
                            <InputNumber value={fixedInterestRate} onValueChange={(e) => setFixedInterestRate(e.value || 0)} suffix=" %" locale="fi-FI" minFractionDigits={1} maxFractionDigits={3} placeholder="e.g., 3.5" />
                            <HelpTip text="The annual interest rate. E.g., 3.5% means you pay 3.5% of remaining balance per year." />
                        </div>
                    )}
                    {interestModelType === 'variable' && (
                        <div className="flex flex-col gap-1">
                            <label className="font-medium text-sm">Reference Rate Margin</label>
                            <InputNumber value={referenceRateMargin} onValueChange={(e) => setReferenceRateMargin(e.value || 0)} suffix=" %" locale="fi-FI" minFractionDigits={1} maxFractionDigits={3} placeholder="e.g., 1.5" />
                            <HelpTip text="The margin added on top of the reference rate (e.g., Euribor + this margin = your actual rate). Set reference rates per month in the expanded details." />
                        </div>
                    )}
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Monthly Payment</label>
                        <InputNumber value={monthlyPayment} onValueChange={(e) => setMonthlyPayment(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Regular monthly payment" />
                        <HelpTip text="The fixed amount you pay each month (principal + interest). Check your loan agreement for this value." />
                    </div>
                </>
            )}

            {debtType === 'fixed-installment' && (
                <>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Installment Amount</label>
                        <InputNumber value={installmentAmount} onValueChange={(e) => setInstallmentAmount(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Amount per installment" />
                        <HelpTip text="The fixed amount for each installment payment." />
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="font-medium text-sm">Total Installments</label>
                        <InputNumber value={totalInstallments} onValueChange={(e) => setTotalInstallments(e.value || 0)} placeholder="e.g., 12" />
                        <HelpTip text="The total number of installment payments (e.g., 12 for a 12-month plan)." />
                    </div>
                </>
            )}

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label={debt ? 'Save Changes' : 'Create Debt'} icon={debt ? <MdCheck /> : <MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

function ReferenceRateForm({ debtId, onSave, onCancel }: { debtId: string; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [yearMonth, setYearMonth] = useState(getCurrentYearMonth());
    const [rate, setRate] = useState(0);
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        setError('');
        setIsSaving(true);
        try {
            const result = await setReferenceRate(debtId, yearMonth, rate);
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', 'Reference rate added');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="Set the reference rate (e.g., Euribor) for a specific month. The debt's actual interest rate will be this value plus the margin you set on the debt." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Month</label>
                <MonthPicker value={yearMonth} onChange={setYearMonth} placeholder="Select month" helpText="The month this reference rate applies to." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Rate</label>
                <InputNumber value={rate} onValueChange={(e) => setRate(e.value || 0)} suffix=" %" locale="fi-FI" minFractionDigits={1} maxFractionDigits={3} placeholder="e.g., 3.2" />
                <HelpTip text="The base reference rate (e.g., 6-month Euribor) for this period." />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label="Add Rate" icon={<MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

function ExtraPaymentForm({ debtId, currency, onSave, onCancel }: { debtId: string; currency: Currency; onSave: () => void; onCancel: () => void; }) {
    const toast = useToast();
    const [date, setDate] = useState(getCurrentYearMonth());
    const [amount, setAmount] = useState(0);
    const [description, setDescription] = useState('');
    const [error, setError] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const handleSubmit = async () => {
        setError('');
        setIsSaving(true);
        try {
            const result = await createExtraPayment(debtId, { date, amount, description: description || undefined });
            if (!result.success) { setError(result.error || 'Failed to save'); return; }
            toast.success('Success', 'Extra payment recorded');
            onSave();
        } catch { setError('An error occurred.'); } finally { setIsSaving(false); }
    };

    return (
        <div className="space-y-4">
            <Message severity="info" text="Record an extra one-time payment to reduce the debt faster. This is in addition to your regular monthly payments." className="w-full" />
            {error && <Message severity="error" text={error} className="w-full" />}

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Date</label>
                <MonthPicker value={date} onChange={setDate} placeholder="When was this paid?" helpText="The month this extra payment was made." />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Amount</label>
                <InputNumber value={amount} onValueChange={(e) => setAmount(e.value || 0)} mode="currency" currency={currency} locale="fi-FI" placeholder="Extra amount paid" />
            </div>

            <div className="flex flex-col gap-1">
                <label className="font-medium text-sm">Description (optional)</label>
                <InputText placeholder="e.g., Year-end bonus payment" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>

            <div className="flex justify-end gap-2 pt-4">
                <Button label="Cancel" severity="secondary" outlined onClick={onCancel} />
                <Button label="Add Payment" icon={<MdAdd />} loading={isSaving} onClick={handleSubmit} />
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────
// Main Entity List Drawer
// ──────────────────────────────────────────────────

type FormState =
    | { kind: 'none' }
    | { kind: 'account'; account: FinancialAccount | null }
    | { kind: 'investment'; investment: InvestmentAccount | null }
    | { kind: 'contribution'; investmentId: string; contribution: InvestmentContribution | null; currency: Currency }
    | { kind: 'receivable'; receivable: Receivable | null }
    | { kind: 'repayment'; receivableId: string; currency: Currency }
    | { kind: 'debt'; debt: Debt | null }
    | { kind: 'referenceRate'; debtId: string }
    | { kind: 'extraPayment'; debtId: string; currency: Currency };

export function EntityListDrawer({ visible, category, onClose, onRefresh, editEntityId }: EntityListDrawerProps) {
    const config = categoryConfig[category];
    const toast = useToast();
    // Simple mode frames debts as progress ("X% paid off", payoff date)
    // instead of raw principal/type figures.
    const isSimple = useAppContext()?.displayMode === 'simple';

    const [isLoading, setIsLoading] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [formState, setFormState] = useState<FormState>({ kind: 'none' });
    const [expandedId, setExpandedId] = useState<string | null>(null);

    // Data
    const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
    const [investments, setInvestments] = useState<InvestmentAccount[]>([]);
    const [contributions, setContributions] = useState<Map<string, InvestmentContribution[]>>(new Map());
    const [receivables, setReceivables] = useState<Receivable[]>([]);
    const [repayments, setRepayments] = useState<Map<string, ReceivableRepayment[]>>(new Map());
    const [debts, setDebts] = useState<Debt[]>([]);
    const [referenceRates, setReferenceRates] = useState<Map<string, DebtReferenceRate[]>>(new Map());
    const [extraPayments, setExtraPayments] = useState<Map<string, DebtExtraPayment[]>>(new Map());

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        try {
            switch (category) {
                case 'cash': {
                    const res = await getAccounts();
                    if (res.success && res.data) setAccounts(res.data);
                    break;
                }
                case 'investments': {
                    const res = await getInvestmentAccounts();
                    if (res.success && res.data) {
                        setInvestments(res.data);
                        const cMap = new Map<string, InvestmentContribution[]>();
                        for (const inv of res.data) {
                            const cr = await getContributions(inv.id);
                            if (cr.success && cr.data) cMap.set(inv.id, cr.data);
                        }
                        setContributions(cMap);
                    }
                    break;
                }
                case 'receivables': {
                    const res = await getReceivables();
                    if (res.success && res.data) {
                        setReceivables(res.data);
                        const rMap = new Map<string, ReceivableRepayment[]>();
                        for (const rec of res.data) {
                            const rr = await getRepayments(rec.id);
                            if (rr.success && rr.data) rMap.set(rec.id, rr.data);
                        }
                        setRepayments(rMap);
                    }
                    break;
                }
                case 'debts': {
                    const res = await getDebts();
                    if (res.success && res.data) {
                        setDebts(res.data);
                        const rrMap = new Map<string, DebtReferenceRate[]>();
                        const epMap = new Map<string, DebtExtraPayment[]>();
                        for (const d of res.data) {
                            const rr = await getReferenceRates(d.id);
                            if (rr.success && rr.data) rrMap.set(d.id, rr.data);
                            const ep = await getExtraPayments(d.id);
                            if (ep.success && ep.data) epMap.set(d.id, ep.data);
                        }
                        setReferenceRates(rrMap);
                        setExtraPayments(epMap);
                    }
                    break;
                }
            }
        } catch (err) {
            console.error('Failed to fetch:', err);
        } finally {
            setIsLoading(false);
        }
    }, [category]);

    useEffect(() => {
        if (visible) fetchData();
    }, [visible, fetchData]);

    // Auto-open edit form when editEntityId is provided
    useEffect(() => {
        if (!editEntityId || isLoading) return;
        switch (category) {
            case 'cash': { const a = accounts.find(x => x.id === editEntityId); if (a) setFormState({ kind: 'account', account: a }); break; }
            case 'investments': { const i = investments.find(x => x.id === editEntityId); if (i) setFormState({ kind: 'investment', investment: i }); break; }
            case 'receivables': { const r = receivables.find(x => x.id === editEntityId); if (r) setFormState({ kind: 'receivable', receivable: r }); break; }
            case 'debts': { const d = debts.find(x => x.id === editEntityId); if (d) setFormState({ kind: 'debt', debt: d }); break; }
        }
    }, [editEntityId, isLoading, category, accounts, investments, receivables, debts]);

    const handleFormSave = async () => {
        setFormState({ kind: 'none' });
        await fetchData();
        onRefresh?.();
    };

    const handleFormCancel = () => {
        setFormState({ kind: 'none' });
    };

    const handleArchive = async (id: string, archive: boolean) => {
        try {
            let result;
            switch (category) {
                case 'cash': result = await updateAccount(id, { isArchived: archive }); break;
                case 'investments': result = await updateInvestmentAccount(id, { isArchived: archive }); break;
                case 'receivables': result = await updateReceivable(id, { isArchived: archive }); break;
                case 'debts': result = await updateDebt(id, { isArchived: archive }); break;
            }
            if (result?.success) {
                toast.success('Success', archive ? 'Archived successfully' : 'Restored successfully');
                await fetchData();
                onRefresh?.();
            }
        } catch (err) {
            console.error('Archive failed:', err);
            toast.error('Error', 'Failed to update archive status');
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure? This action cannot be undone.')) return;
        try {
            let result;
            switch (category) {
                case 'cash': result = await deleteAccountAction(id); break;
                case 'investments': result = await deleteInvestmentAccount(id); break;
                case 'receivables': result = await deleteReceivableAction(id); break;
                case 'debts': result = await deleteDebtAction(id); break;
            }
            if (result?.success) {
                toast.success('Deleted successfully');
                await fetchData();
                onRefresh?.();
            }
        } catch (err) {
            console.error('Delete failed:', err);
            toast.error('Failed to delete');
        }
    };

    const handleDeleteSubEntity = async (parentId: string, subId: string, subType: 'contribution' | 'repayment' | 'referenceRate' | 'extraPayment') => {
        if (!confirm('Delete this item?')) return;
        try {
            let result;
            switch (subType) {
                case 'contribution': result = await deleteContribution(parentId, subId); break;
                case 'repayment': result = await deleteRepaymentAction(parentId, subId); break;
                case 'referenceRate': result = await deleteReferenceRateAction(parentId, subId); break;
                case 'extraPayment': result = await deleteExtraPaymentAction(parentId, subId); break;
            }
            if (result?.success) {
                toast.success('Deleted successfully');
                await fetchData();
                onRefresh?.();
            }
        } catch (err) {
            console.error('Delete sub-entity failed:', err);
            toast.error('Failed to delete');
        }
    };

    const renderEmpty = () => (
        <div className="text-center py-12 opacity-50">
            <span className={`text-4xl mb-4 block ${config.color}`}>{config.icon}</span>
            <p className="mb-4">{showArchived ? `No archived ${config.title.toLowerCase()}` : `No ${config.title.toLowerCase()} yet`}</p>
        </div>
    );

    const renderItems = () => {
        switch (category) {
            case 'cash': {
                const items = accounts.filter(a => showArchived ? a.isArchived : !a.isArchived);
                if (items.length === 0) return renderEmpty();
                return items.map(a => (
                    <ItemCard key={a.id} name={a.name}
                        subtitle={`${formatCurrency(a.startingBalance, a.currency)} · Since ${a.startingDate}`}
                        tags={a.isArchived ? [{ label: 'Archived', severity: 'warning' as const }] : []}
                        onEdit={() => setFormState({ kind: 'account', account: a })}
                        onArchive={() => handleArchive(a.id, !a.isArchived)} isArchived={a.isArchived}
                        onDelete={() => handleDelete(a.id)}
                    />
                ));
            }
            case 'investments': {
                const items = investments.filter(i => showArchived ? i.isArchived : !i.isArchived);
                if (items.length === 0) return renderEmpty();
                return items.map(inv => {
                    const invContribs = contributions.get(inv.id) || [];
                    const isExpanded = expandedId === inv.id;
                    return (
                        <div key={inv.id}>
                            <ItemCard name={inv.name}
                                subtitle={`${formatCurrency(inv.currentValuation ?? inv.startingValuation, inv.currency)} · ${inv.annualGrowthRate}% annual`}
                                tags={inv.isArchived ? [{ label: 'Archived', severity: 'warning' as const }] : []}
                                onEdit={() => setFormState({ kind: 'investment', investment: inv })}
                                onArchive={() => handleArchive(inv.id, !inv.isArchived)} isArchived={inv.isArchived}
                                onDelete={() => handleDelete(inv.id)}
                                onExpand={() => setExpandedId(isExpanded ? null : inv.id)} isExpanded={isExpanded} expandLabel="Contributions"
                            />
                            {isExpanded && (
                                <div className="animate-fade-in">
                                <SubEntityList
                                    items={invContribs.map(c => ({ id: c.id, label: `${c.type === 'contribution' ? '+' : '-'}${formatCurrency(c.amount, inv.currency)}`, detail: c.kind === 'one-off' ? c.scheduledDate || '' : `${c.frequency} from ${c.startDate}`, inactive: !c.isActive }))}
                                    onAdd={() => setFormState({ kind: 'contribution', investmentId: inv.id, contribution: null, currency: inv.currency })}
                                    onEditItem={(subId) => { const c = invContribs.find(x => x.id === subId); if (c) setFormState({ kind: 'contribution', investmentId: inv.id, contribution: c, currency: inv.currency }); }}
                                    onDeleteItem={(subId) => handleDeleteSubEntity(inv.id, subId, 'contribution')}
                                    addLabel="Add Contribution"
                                />
                                </div>
                            )}
                        </div>
                    );
                });
            }
            case 'receivables': {
                const items = receivables.filter(r => showArchived ? r.isArchived : !r.isArchived);
                if (items.length === 0) return renderEmpty();
                return items.map(rec => {
                    const recRepayments = repayments.get(rec.id) || [];
                    const isExpanded = expandedId === rec.id;
                    return (
                        <div key={rec.id}>
                            <ItemCard name={rec.name}
                                subtitle={`${formatCurrency(rec.currentBalance, rec.currency)} remaining`}
                                tags={rec.isArchived ? [{ label: 'Archived', severity: 'warning' as const }] : []}
                                onEdit={() => setFormState({ kind: 'receivable', receivable: rec })}
                                onArchive={() => handleArchive(rec.id, !rec.isArchived)} isArchived={rec.isArchived}
                                onDelete={() => handleDelete(rec.id)}
                                onExpand={() => setExpandedId(isExpanded ? null : rec.id)} isExpanded={isExpanded} expandLabel="Repayments"
                            />
                            {isExpanded && (
                                <div className="animate-fade-in">
                                <SubEntityList
                                    items={recRepayments.map(r => ({ id: r.id, label: `+${formatCurrency(r.amount, rec.currency)}`, detail: `${r.date}${r.description ? ' · ' + r.description : ''}` }))}
                                    onAdd={() => setFormState({ kind: 'repayment', receivableId: rec.id, currency: rec.currency })}
                                    onDeleteItem={(subId) => handleDeleteSubEntity(rec.id, subId, 'repayment')}
                                    addLabel="Add Repayment"
                                />
                                </div>
                            )}
                        </div>
                    );
                });
            }
            case 'debts': {
                const items = debts.filter(d => showArchived ? d.isArchived : !d.isArchived);
                if (items.length === 0) return renderEmpty();
                return items.map(debt => {
                    const debtRates = referenceRates.get(debt.id) || [];
                    const debtEps = extraPayments.get(debt.id) || [];
                    const isExpanded = expandedId === debt.id;
                    // Progress framing: run the amortization engine over a long
                    // horizon so the payoff month is found (cheap for few debts).
                    const rows = calculateDebtAmortization(
                        debt, debtRates, debtEps, debt.startDate, addMonths(getCurrentYearMonth(), 480)
                    );
                    const payoff = getDebtPayoffInfo(debt, rows);
                    const subtitle = isSimple
                        ? `${Math.round(payoff.percentPaid)}% paid off${payoff.estimatedPayoffDate ? ` · debt-free ${formatYearMonth(payoff.estimatedPayoffDate)}` : ''}`
                        : `${formatCurrency(debt.initialPrincipal, debt.currency)} · ${debt.debtType} · ${debt.interestModelType}`;
                    return (
                        <div key={debt.id}>
                            <ItemCard name={debt.name}
                                subtitle={subtitle}
                                tags={debt.isArchived ? [{ label: 'Archived', severity: 'warning' as const }] : []}
                                onEdit={() => setFormState({ kind: 'debt', debt })}
                                onArchive={() => handleArchive(debt.id, !debt.isArchived)} isArchived={debt.isArchived}
                                onDelete={() => handleDelete(debt.id)}
                                onExpand={() => setExpandedId(isExpanded ? null : debt.id)} isExpanded={isExpanded} expandLabel="Details"
                            />
                            {isExpanded && (
                                <div className="animate-fade-in ml-4 mb-3 space-y-2 border-l surface-border pl-3">
                                    <DebtProgressCard debt={debt} payoffInfo={payoff} isSimpleMode={isSimple} />
                                    {debt.interestModelType === 'variable' && (
                                        <SubEntityList title="Reference Rates"
                                            items={debtRates.map(r => ({ id: r.id, label: `${r.rate}%`, detail: r.yearMonth }))}
                                            onAdd={() => setFormState({ kind: 'referenceRate', debtId: debt.id })}
                                            onDeleteItem={(subId) => handleDeleteSubEntity(debt.id, subId, 'referenceRate')}
                                            addLabel="Add Rate"
                                        />
                                    )}
                                    <SubEntityList title="Extra Payments"
                                        items={debtEps.map(p => ({ id: p.id, label: formatCurrency(p.amount, debt.currency), detail: `${p.date}${p.description ? ' · ' + p.description : ''}` }))}
                                        onAdd={() => setFormState({ kind: 'extraPayment', debtId: debt.id, currency: debt.currency })}
                                        onDeleteItem={(subId) => handleDeleteSubEntity(debt.id, subId, 'extraPayment')}
                                        addLabel="Add Payment"
                                    />
                                </div>
                            )}
                        </div>
                    );
                });
            }
        }
    };

    const openCreateForm = () => {
        switch (category) {
            case 'cash': setFormState({ kind: 'account', account: null }); break;
            case 'investments': setFormState({ kind: 'investment', investment: null }); break;
            case 'receivables': setFormState({ kind: 'receivable', receivable: null }); break;
            case 'debts': setFormState({ kind: 'debt', debt: null }); break;
        }
    };

    const formTitle = (() => {
        switch (formState.kind) {
            case 'account': return formState.account ? 'Edit Account' : 'New Account';
            case 'investment': return formState.investment ? 'Edit Investment' : 'New Investment';
            case 'contribution': return formState.contribution ? 'Edit Contribution' : 'New Contribution';
            case 'receivable': return formState.receivable ? 'Edit Receivable' : 'New Receivable';
            case 'repayment': return 'Add Repayment';
            case 'debt': return formState.debt ? 'Edit Debt' : 'New Debt';
            case 'referenceRate': return 'Add Reference Rate';
            case 'extraPayment': return 'Add Extra Payment';
            default: return '';
        }
    })();

    const sidebarHeader = (
        <div className="flex items-center gap-3">
            <span className={`text-xl ${config.color} flex items-center`}>{config.icon}</span>
            <span className="text-lg font-semibold">{config.title}</span>
        </div>
    );

    return (
        <>
            <Sidebar
                visible={visible}
                onHide={onClose}
                position="right"
                header={sidebarHeader}
                className="w-[28rem]"
                modal
                dismissable
            >
                {/* Category description */}
                <p className="text-sm opacity-60 mb-4">{config.description}</p>

                {/* Toolbar */}
                <div className="flex items-center justify-between mb-4">
                    <Button label={showArchived ? 'Active' : 'Archived'} icon={showArchived ? <MdVisibility /> : <MdVisibilityOff />} severity="secondary" text size="small" onClick={() => setShowArchived(!showArchived)} />
                    <Button label="Add" icon={<MdAdd />} size="small" onClick={openCreateForm} />
                </div>

                {/* Content */}
                {isLoading ? (
                    <div className="flex justify-center py-12"><ProgressSpinner style={{ width: '40px', height: '40px' }} /></div>
                ) : (
                    <div className="space-y-3">{renderItems()}</div>
                )}
            </Sidebar>

            {/* Form Dialog */}
            <Dialog header={formTitle} visible={formState.kind !== 'none'} onHide={handleFormCancel} style={{ width: '500px' }} modal>
                {formState.kind === 'account' && <AccountForm account={formState.account} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'investment' && <InvestmentForm investment={formState.investment} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'contribution' && <ContributionForm investmentId={formState.investmentId} contribution={formState.contribution} currency={formState.currency} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'receivable' && <ReceivableForm receivable={formState.receivable} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'repayment' && <RepaymentForm receivableId={formState.receivableId} currency={formState.currency} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'debt' && <DebtForm debt={formState.debt} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'referenceRate' && <ReferenceRateForm debtId={formState.debtId} onSave={handleFormSave} onCancel={handleFormCancel} />}
                {formState.kind === 'extraPayment' && <ExtraPaymentForm debtId={formState.debtId} currency={formState.currency} onSave={handleFormSave} onCancel={handleFormCancel} />}
            </Dialog>
        </>
    );
}
