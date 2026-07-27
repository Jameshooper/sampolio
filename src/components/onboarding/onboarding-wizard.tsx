'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { MdAccountBalanceWallet, MdArrowDownward, MdArrowUpward, MdAdd, MdClose, MdArrowBack, MdArrowForward, MdHome } from 'react-icons/md';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Steps } from 'primereact/steps';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { Dropdown } from 'primereact/dropdown';
import { SelectButton } from 'primereact/selectbutton';
import { Card } from 'primereact/card';
import { useTheme } from '@/components/providers/theme-provider';
import { getCurrentYearMonth } from '@/lib/projection';
import { createAccount } from '@/lib/actions/accounts';
import { createRecurringItem } from '@/lib/actions/recurring';
import { createSalaryConfig } from '@/lib/actions/salary';
import { completeOnboarding, getUserPreferences } from '@/lib/actions/user-preferences';
import { useAppContext } from '@/components/layout/app-layout';
import { calculateNetSalary } from '@/lib/salary-utils';
import type { Currency, DisplayMode, SalaryBenefit } from '@/types';

interface OnboardingWizardProps {
    visible: boolean;
    onComplete: () => void;
}

const WIZARD_STEPS = [
    { label: 'Welcome' },
    { label: 'Cash Account' },
    { label: 'Income' },
    { label: 'Expenses' },
    { label: 'Done' },
];

const CURRENCY_OPTIONS = [
    { label: 'EUR - Euro', value: 'EUR' },
    { label: 'USD - US Dollar', value: 'USD' },
    { label: 'BRL - Brazilian Real', value: 'BRL' },
    { label: 'GBP - British Pound', value: 'GBP' },
    { label: 'JPY - Japanese Yen', value: 'JPY' },
    { label: 'CHF - Swiss Franc', value: 'CHF' },
    { label: 'CAD - Canadian Dollar', value: 'CAD' },
    { label: 'AUD - Australian Dollar', value: 'AUD' },
];

interface ExpenseEntry {
    name: string;
    amount: number;
}

type IncomeType = 'simple' | 'salary';

const INCOME_TYPE_OPTIONS = [
    { label: 'Simple Amount', value: 'simple' },
    { label: 'Full Salary', value: 'salary' },
];

export function OnboardingWizard({ visible, onComplete }: OnboardingWizardProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const router = useRouter();
    const appContext = useAppContext();

    const [activeStep, setActiveStep] = useState(0);
    const [isSaving, setIsSaving] = useState(false);
    const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);

    // Account form
    const [accountName, setAccountName] = useState('Main Account');
    const [accountBalance, setAccountBalance] = useState<number>(0);
    const [currency, setCurrency] = useState<Currency>('EUR');

    // Income form
    const [incomeType, setIncomeType] = useState<IncomeType>('simple');
    const [incomeName, setIncomeName] = useState('Salary');
    const [incomeAmount, setIncomeAmount] = useState<number>(0);

    // Salary form (when incomeType === 'salary')
    const [grossSalary, setGrossSalary] = useState<number>(0);
    const [taxRate, setTaxRate] = useState<number>(0);
    const [contributionsRate, setContributionsRate] = useState<number>(0);
    const [otherDeductions, setOtherDeductions] = useState<number>(0);
    const [salaryBenefits, setSalaryBenefits] = useState<SalaryBenefit[]>([]);

    // Detail-level choice, persisted on finish. New users default to Simple.
    const [displayModeChoice, setDisplayModeChoice] = useState<DisplayMode>('simple');

    // Prefill the salary rates from the user's saved tax defaults (once).
    const prefilledRef = useRef(false);
    useEffect(() => {
        if (!visible || prefilledRef.current) return;
        prefilledRef.current = true;
        getUserPreferences().then((result) => {
            if (result.success && result.data?.taxDefaults) {
                const d = result.data.taxDefaults;
                setTaxRate((prev) => (prev === 0 ? d.taxRate : prev));
                setContributionsRate((prev) => (prev === 0 ? d.contributionsRate : prev));
                setOtherDeductions((prev) => (prev === 0 ? d.otherDeductions : prev));
            }
        });
    }, [visible]);

    const previewNetSalary = calculateNetSalary(grossSalary, taxRate, contributionsRate, otherDeductions, salaryBenefits);

    // Expenses form
    const [expenses, setExpenses] = useState<ExpenseEntry[]>([
        { name: 'Rent', amount: 0 },
        { name: 'Groceries', amount: 0 },
        { name: 'Utilities', amount: 0 },
    ]);

    const addExpense = () => {
        setExpenses(prev => [...prev, { name: '', amount: 0 }]);
    };

    const removeExpense = (index: number) => {
        setExpenses(prev => prev.filter((_, i) => i !== index));
    };

    const updateExpense = (index: number, field: keyof ExpenseEntry, value: string | number) => {
        setExpenses(prev => prev.map((e, i) => i === index ? { ...e, [field]: value } : e));
    };

    const handleNext = useCallback(async () => {
        if (activeStep === 1) {
            // Create account
            if (!accountName || accountBalance === null) return;
            setIsSaving(true);
            try {
                const result = await createAccount({
                    name: accountName,
                    currency,
                    startingBalance: accountBalance,
                    startingDate: getCurrentYearMonth(),
                    planningHorizonMonths: 60,
                });
                if (result.success && result.data) {
                    setCreatedAccountId(result.data.id);
                }
            } catch (err) {
                console.error('Failed to create account:', err);
            } finally {
                setIsSaving(false);
            }
        }

        if (activeStep === 2) {
            // Create income
            if (!createdAccountId) {
                setActiveStep(prev => prev + 1);
                return;
            }
            setIsSaving(true);
            try {
                if (incomeType === 'salary' && grossSalary > 0) {
                    // Create salary config (which auto-creates linked recurring income)
                    await createSalaryConfig(createdAccountId, {
                        name: incomeName || 'Salary',
                        grossSalary,
                        taxRate,
                        contributionsRate,
                        otherDeductions,
                        benefits: salaryBenefits.filter(b => b.name && b.amount > 0),
                        startDate: getCurrentYearMonth(),
                        isActive: true,
                        isLinkedToRecurring: true,
                    });
                } else if (incomeType === 'simple' && incomeAmount > 0) {
                    // Create simple recurring income
                    await createRecurringItem(createdAccountId, {
                        type: 'income',
                        name: incomeName,
                        amount: incomeAmount,
                        frequency: 'monthly',
                        startDate: getCurrentYearMonth(),
                    });
                }
            } catch (err) {
                console.error('Failed to create income:', err);
            } finally {
                setIsSaving(false);
            }
        }

        if (activeStep === 3) {
            // Create expenses
            if (!createdAccountId) {
                setActiveStep(prev => prev + 1);
                return;
            }
            setIsSaving(true);
            try {
                const validExpenses = expenses.filter(e => e.name && e.amount > 0);
                for (const expense of validExpenses) {
                    await createRecurringItem(createdAccountId, {
                        type: 'expense',
                        name: expense.name,
                        amount: expense.amount,
                        frequency: 'monthly',
                        startDate: getCurrentYearMonth(),
                    });
                }
            } catch (err) {
                console.error('Failed to create expenses:', err);
            } finally {
                setIsSaving(false);
            }
        }

        setActiveStep(prev => prev + 1);
    }, [activeStep, accountName, accountBalance, currency, createdAccountId, incomeName, incomeAmount, incomeType, grossSalary, taxRate, contributionsRate, otherDeductions, salaryBenefits, expenses]);

    const handleBack = () => {
        setActiveStep(prev => Math.max(0, prev - 1));
    };

    const handleFinish = async () => {
        setIsSaving(true);
        try {
            // Persist the chosen detail level (also updates the live context).
            await appContext?.setDisplayMode(displayModeChoice);
            await completeOnboarding();
        } catch (err) {
            console.error('Failed to complete onboarding:', err);
        } finally {
            setIsSaving(false);
            onComplete();
            router.push('/');
        }
    };

    const handleSkip = async () => {
        setIsSaving(true);
        try {
            await completeOnboarding();
        } catch (err) {
            console.error('Failed to skip onboarding:', err);
        } finally {
            setIsSaving(false);
            onComplete();
        }
    };

    const canProceed = () => {
        switch (activeStep) {
            case 0: return true;
            case 1: return !!accountName && accountBalance !== null;
            case 2: return true; // income is optional
            case 3: return true; // expenses are optional
            case 4: return true;
            default: return false;
        }
    };

    const renderStep = () => {
        switch (activeStep) {
            case 0:
                return (
                    <div className="text-center py-8 space-y-6">
                        <div className="text-6xl mb-4">👋</div>
                        <h2 className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            Welcome to Sampolio
                        </h2>
                        <p className={`text-lg max-w-md mx-auto ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                            Let&apos;s set up your financial overview in a few quick steps.
                            You&apos;ll create a cash account and add your main income and expenses.
                        </p>
                        <div className={`flex flex-col gap-3 max-w-sm mx-auto text-left text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            <div className="flex items-center gap-2">
                                <MdAccountBalanceWallet className="text-green-500" />
                                <span>Set up your main cash account</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <MdArrowDownward className="text-blue-500" />
                                <span>Add your primary income</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <MdArrowUpward className="text-orange-500" />
                                <span>Add your regular expenses</span>
                            </div>
                        </div>
                    </div>
                );

            case 1:
                return (
                    <div className="space-y-6 py-4">
                        <div className="text-center mb-6">
                            <h3 className={`text-xl font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                Create your first cash account
                            </h3>
                            <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                This represents your main bank account or wallet
                            </p>
                        </div>

                        <div className="max-w-md mx-auto space-y-4">
                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Account Name
                                </label>
                                <InputText
                                    value={accountName}
                                    onChange={(e) => setAccountName(e.target.value)}
                                    placeholder="e.g. Main Account"
                                    className="w-full"
                                />
                            </div>

                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Currency
                                </label>
                                <Dropdown
                                    value={currency}
                                    options={CURRENCY_OPTIONS}
                                    onChange={(e) => setCurrency(e.value)}
                                    className="w-full"
                                />
                            </div>

                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Current Balance
                                </label>
                                <InputNumber
                                    value={accountBalance}
                                    onValueChange={(e) => setAccountBalance(e.value ?? 0)}
                                    mode="currency"
                                    currency={currency}
                                    locale="fi-FI"
                                    className="w-full"
                                />
                            </div>
                        </div>
                    </div>
                );

            case 2:
                return (
                    <div className="space-y-6 py-4">
                        <div className="text-center mb-6">
                            <h3 className={`text-xl font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                Add your main income
                            </h3>
                            <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Your primary monthly income source. You can add more later.
                            </p>
                        </div>

                        <div className="max-w-md mx-auto space-y-4">
                            <div className="flex justify-center">
                                <SelectButton
                                    value={incomeType}
                                    onChange={(e) => setIncomeType(e.value as IncomeType)}
                                    options={INCOME_TYPE_OPTIONS}
                                    optionLabel="label"
                                    optionValue="value"
                                />
                            </div>
                            <p className={`text-xs text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Not sure about tax rates? Choose <b>Simple Amount</b> and enter what
                                lands in your account each month — you can switch later.
                            </p>

                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Income Name
                                </label>
                                <InputText
                                    value={incomeName}
                                    onChange={(e) => setIncomeName(e.target.value)}
                                    placeholder="e.g. Salary"
                                    className="w-full"
                                />
                            </div>

                            {incomeType === 'simple' ? (
                                <div>
                                    <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                        Monthly Amount (after tax)
                                    </label>
                                    <InputNumber
                                        value={incomeAmount}
                                        onValueChange={(e) => setIncomeAmount(e.value ?? 0)}
                                        mode="currency"
                                        currency={currency}
                                        locale="fi-FI"
                                        min={0}
                                        className="w-full"
                                    />
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                            Gross Salary (Monthly, before tax)
                                        </label>
                                        <InputNumber
                                            value={grossSalary}
                                            onValueChange={(e) => setGrossSalary(e.value ?? 0)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            min={0}
                                            className="w-full"
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-3">
                                        <div>
                                            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                                Tax Rate (%) — from your payslip
                                            </label>
                                            <InputNumber
                                                value={taxRate}
                                                onValueChange={(e) => setTaxRate(e.value ?? 0)}
                                                suffix="%"
                                                locale="fi-FI"
                                                min={0}
                                                max={100}
                                                minFractionDigits={0}
                                                maxFractionDigits={2}
                                                className="w-full"
                                            />
                                        </div>
                                        <div>
                                            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                                Contributions (%)
                                            </label>
                                            <InputNumber
                                                value={contributionsRate}
                                                onValueChange={(e) => setContributionsRate(e.value ?? 0)}
                                                suffix="%"
                                                locale="fi-FI"
                                                min={0}
                                                max={100}
                                                minFractionDigits={0}
                                                maxFractionDigits={2}
                                                className="w-full"
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                            Other Deductions (fixed amount)
                                        </label>
                                        <InputNumber
                                            value={otherDeductions}
                                            onValueChange={(e) => setOtherDeductions(e.value ?? 0)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            min={0}
                                            className="w-full"
                                        />
                                    </div>

                                    {/* Benefits */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <label className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                                Benefits
                                            </label>
                                            <Button
                                                label="Add"
                                                icon={<MdAdd />}
                                                size="small"
                                                text
                                                onClick={() => setSalaryBenefits(prev => [...prev, {
                                                    id: crypto.randomUUID(),
                                                    name: '',
                                                    amount: 0,
                                                    isTaxable: true,
                                                }])}
                                            />
                                        </div>
                                        {salaryBenefits.map((benefit, idx) => (
                                            <div key={benefit.id} className={`flex items-center gap-2 p-2 rounded mb-2 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
                                                <InputText
                                                    placeholder="Name"
                                                    value={benefit.name}
                                                    onChange={e => {
                                                        const updated = [...salaryBenefits];
                                                        updated[idx] = { ...updated[idx], name: e.target.value };
                                                        setSalaryBenefits(updated);
                                                    }}
                                                    className="flex-1"
                                                    size={1}
                                                />
                                                <InputNumber
                                                    value={benefit.amount}
                                                    onValueChange={e => {
                                                        const updated = [...salaryBenefits];
                                                        updated[idx] = { ...updated[idx], amount: e.value ?? 0 };
                                                        setSalaryBenefits(updated);
                                                    }}
                                                    mode="currency"
                                                    currency={currency}
                                                    locale="fi-FI"
                                                    min={0}
                                                    className="w-28"
                                                />
                                                <div className="flex items-center gap-1 shrink-0">
                                                    <InputSwitch
                                                        checked={benefit.isTaxable}
                                                        onChange={e => {
                                                            const updated = [...salaryBenefits];
                                                            updated[idx] = { ...updated[idx], isTaxable: e.value ?? true };
                                                            setSalaryBenefits(updated);
                                                        }}
                                                    />
                                                    <span className={`text-xs whitespace-nowrap ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                                        {benefit.isTaxable ? 'Taxable' : 'Non-tax'}
                                                    </span>
                                                </div>
                                                <Button
                                                    icon={<MdClose />}
                                                    rounded
                                                    text
                                                    severity="danger"
                                                    size="small"
                                                    onClick={() => setSalaryBenefits(prev => prev.filter((_, i) => i !== idx))}
                                                />
                                            </div>
                                        ))}
                                    </div>

                                    {/* Net salary preview */}
                                    {grossSalary > 0 && (
                                        <div className={`p-4 rounded-lg space-y-1 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
                                            <div className="flex justify-between text-sm">
                                                <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>Gross</span>
                                                <span>{grossSalary.toLocaleString()} {currency}</span>
                                            </div>
                                            {salaryBenefits.filter(b => b.amount > 0).length > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>+ Benefits</span>
                                                    <span className="text-blue-500">+{salaryBenefits.reduce((s, b) => s + b.amount, 0).toLocaleString()} {currency}</span>
                                                </div>
                                            )}
                                            {taxRate > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- Tax ({taxRate}%)</span>
                                                    <span className="text-red-500">-{((grossSalary + salaryBenefits.filter(b => b.isTaxable).reduce((s, b) => s + b.amount, 0)) * taxRate / 100).toLocaleString()} {currency}</span>
                                                </div>
                                            )}
                                            {contributionsRate > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- Contributions ({contributionsRate}%)</span>
                                                    <span className="text-red-500">-{((grossSalary + salaryBenefits.filter(b => b.isTaxable).reduce((s, b) => s + b.amount, 0)) * contributionsRate / 100).toLocaleString()} {currency}</span>
                                                </div>
                                            )}
                                            {otherDeductions > 0 && (
                                                <div className="flex justify-between text-sm">
                                                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>- Other Deductions</span>
                                                    <span className="text-red-500">-{otherDeductions.toLocaleString()} {currency}</span>
                                                </div>
                                            )}
                                            <div className={`flex justify-between items-center pt-2 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                                                <span className="font-medium">Net Salary</span>
                                                <span className="text-xl font-bold text-green-600">{previewNetSalary.toLocaleString()} {currency}/mo</span>
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );

            case 3:
                return (
                    <div className="space-y-6 py-4">
                        <div className="text-center mb-6">
                            <h3 className={`text-xl font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                Add your regular expenses
                            </h3>
                            <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Add your main monthly expenses. Leave amount at 0 to skip any.
                            </p>
                        </div>

                        <div className="max-w-md mx-auto space-y-3">
                            {expenses.map((expense, idx) => (
                                <div key={idx} className="flex items-end gap-2">
                                    <div className="flex-1">
                                        {idx === 0 && (
                                            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                                Name
                                            </label>
                                        )}
                                        <InputText
                                            value={expense.name}
                                            onChange={(e) => updateExpense(idx, 'name', e.target.value)}
                                            placeholder="Expense name"
                                            className="w-full"
                                        />
                                    </div>
                                    <div className="flex-1">
                                        {idx === 0 && (
                                            <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                                Amount
                                            </label>
                                        )}
                                        <InputNumber
                                            value={expense.amount}
                                            onValueChange={(e) => updateExpense(idx, 'amount', e.value ?? 0)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            min={0}
                                            className="w-full"
                                        />
                                    </div>
                                    <Button
                                        icon={<MdClose />}
                                        severity="danger"
                                        text
                                        rounded
                                        onClick={() => removeExpense(idx)}
                                        disabled={expenses.length <= 1}
                                    />
                                </div>
                            ))}

                            <Button
                                label="Add Another"
                                icon={<MdAdd />}
                                text
                                size="small"
                                onClick={addExpense}
                                className="mt-2"
                            />
                        </div>
                    </div>
                );

            case 4:
                return (
                    <div className="text-center py-8 space-y-6">
                        <div className="text-6xl mb-4">🎉</div>
                        <h2 className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            You&apos;re all set!
                        </h2>
                        <p className={`text-lg max-w-md mx-auto ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                            You&apos;re ready to go. You can always add more accounts, income,
                            expenses, investments, and debts later.
                        </p>

                        {/* Detail-level choice — persisted as the display mode on finish. */}
                        <div className="max-w-sm mx-auto space-y-2">
                            <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                How much detail do you want to see?
                            </p>
                            <SelectButton
                                value={displayModeChoice}
                                onChange={(e) => e.value && setDisplayModeChoice(e.value as DisplayMode)}
                                options={[
                                    { label: 'Keep it simple', value: 'simple' },
                                    { label: 'Show me everything', value: 'advanced' },
                                ]}
                                optionLabel="label"
                                optionValue="value"
                            />
                            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Simple shows the essentials in everyday words; you can switch anytime
                                from your account menu.
                            </p>
                        </div>

                        <Card className="max-w-sm mx-auto text-left">
                            <div className="space-y-3">
                                <div className="flex items-center justify-between">
                                    <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>Account</span>
                                    <span className={`font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                        {accountName}
                                    </span>
                                </div>
                                {incomeType === 'salary' && grossSalary > 0 && (
                                    <>
                                        <div className="flex items-center justify-between">
                                            <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>Gross Salary</span>
                                            <span className="font-semibold">
                                                {grossSalary.toLocaleString()} {currency}/mo
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>Net Salary</span>
                                            <span className="font-semibold text-green-500">
                                                +{previewNetSalary.toLocaleString()} {currency}/mo
                                            </span>
                                        </div>
                                    </>
                                )}
                                {incomeType === 'simple' && incomeAmount > 0 && (
                                    <div className="flex items-center justify-between">
                                        <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>Income</span>
                                        <span className="font-semibold text-green-500">
                                            +{incomeAmount.toLocaleString()} {currency}/mo
                                        </span>
                                    </div>
                                )}
                                {expenses.filter(e => e.amount > 0).map((e, i) => (
                                    <div key={i} className="flex items-center justify-between">
                                        <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{e.name}</span>
                                        <span className="font-semibold text-red-500">
                                            -{e.amount.toLocaleString()} {currency}/mo
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    </div>
                );

            default:
                return null;
        }
    };

    const footer = (
        <div className="flex items-center justify-between w-full">
            <div>
                {activeStep === 0 && (
                    <Button
                        label="Skip Setup"
                        text
                        severity="secondary"
                        onClick={handleSkip}
                        disabled={isSaving}
                    />
                )}
                {activeStep > 0 && activeStep < 4 && (
                    <Button
                        label="Back"
                        icon={<MdArrowBack />}
                        text
                        severity="secondary"
                        onClick={handleBack}
                        disabled={isSaving}
                    />
                )}
            </div>
            <div>
                {activeStep < 4 && (
                    <Button
                        label={activeStep === 0 ? 'Get Started' : 'Next'}
                        icon={<MdArrowForward />}
                        iconPos="right"
                        onClick={handleNext}
                        disabled={!canProceed() || isSaving}
                        loading={isSaving}
                    />
                )}
                {activeStep === 4 && (
                    <Button
                        label="Go to Home"
                        icon={<MdHome />}
                        iconPos="right"
                        onClick={handleFinish}
                        disabled={isSaving}
                        loading={isSaving}
                    />
                )}
            </div>
        </div>
    );

    return (
        <Dialog
            visible={visible}
            onHide={() => { }} // Don't allow closing by clicking outside
            modal
            closable={false}
            header="Getting Started"
            footer={footer}
            style={{ width: '600px' }}
            className="onboarding-wizard"
        >
            <Steps
                model={WIZARD_STEPS}
                activeIndex={activeStep}
                readOnly
                className="mb-6"
            />
            {renderStep()}
        </Dialog>
    );
}
