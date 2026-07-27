'use client';

import { useState, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Calendar } from 'primereact/calendar';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { InputText } from 'primereact/inputtext';
import { SelectButton } from 'primereact/selectbutton';
import { Tag } from 'primereact/tag';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { DelayedSpinner } from '@/components/ui/delayed-loading';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { runScenarioProjection } from '@/lib/actions/scenario';
import { createRecurringItem, getRecurringItems } from '@/lib/actions/recurring';
import { createPlannedItem, getPlannedItems } from '@/lib/actions/planned';
import type { ScenarioModification } from '@/lib/scenario-utils';
import type { MonthlyProjection, Currency, FinancialAccount, RecurringItem, PlannedItem } from '@/types';
import { MdPlayArrow, MdAdd, MdTrendingUp, MdRefresh, MdClose, MdPlaylistAdd, MdCheck } from 'react-icons/md';

// The comparison chart is a heavy ECharts bundle — code-split it (ssr:false;
// it's client-only) so it never bloats the playground's initial JS.
const ChartLoading = () => <div className="h-72 lg:h-96 rounded-lg bg-gray-100 dark:bg-gray-800/50 animate-pulse" />;
const ScenarioComparisonChart = dynamic(
    () => import('@/components/charts/scenario-comparison-chart').then((m) => m.ScenarioComparisonChart),
    { ssr: false, loading: ChartLoading },
);

type ScenarioTemplate = 'raise' | 'add-expense' | 'remove-expense' | 'extra-savings' | 'cancel-item' | 'change-amount';

const TEMPLATES: { label: string; value: ScenarioTemplate; description: string }[] = [
    { label: 'Get a raise', value: 'raise', description: 'See the impact of earning more' },
    { label: 'Add an expense', value: 'add-expense', description: 'What if you add a new regular cost?' },
    { label: 'Cancel a subscription', value: 'remove-expense', description: 'How much would you save annually?' },
    { label: 'Start saving', value: 'extra-savings', description: 'Start putting aside money each month' },
    { label: 'Cancel an existing expense', value: 'cancel-item', description: 'Remove one of your real items' },
    { label: "Change an item's amount", value: 'change-amount', description: 'Try a different amount for a real item' },
];

// Templates that target an EXISTING item instead of the add-a-new-item form.
const ITEM_PICKER_TEMPLATES: ScenarioTemplate[] = ['cancel-item', 'change-amount'];

type ScenarioFrequency = 'monthly' | 'quarterly' | 'yearly' | 'once';

function monthToYearMonth(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function PlaygroundPage() {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const appContext = useAppContext();
    const accounts = useMemo(() =>
        (appContext?.accounts || []).filter((a: FinancialAccount) => !a.isArchived),
        [appContext?.accounts]
    );

    const [selectedAccountId, setSelectedAccountId] = useState<string>(accounts[0]?.id || '');
    // Accounts load async in AppLayout — on a direct page load the state above
    // initializes empty and (with a single account) no dropdown ever renders to
    // fix it, leaving Run permanently disabled. Backfill once accounts arrive.
    useEffect(() => {
        if (!selectedAccountId && accounts.length > 0) {
            setSelectedAccountId(accounts[0].id);
        }
    }, [accounts, selectedAccountId]);
    const [selectedTemplate, setSelectedTemplate] = useState<ScenarioTemplate>('raise');
    const [isRunning, setIsRunning] = useState(false);
    const toast = useToast();

    const isItemPicker = ITEM_PICKER_TEMPLATES.includes(selectedTemplate);

    // Add-a-new-item form inputs
    const [scenarioName, setScenarioName] = useState('');
    const [scenarioAmount, setScenarioAmount] = useState<number>(0);
    const [scenarioFrequency, setScenarioFrequency] = useState<ScenarioFrequency>('monthly');
    // One-off month picker (used only when frequency === 'once'); defaults to now.
    const [scenarioMonth, setScenarioMonth] = useState<Date>(() => new Date());

    // Existing-item picker inputs
    const [pickerItems, setPickerItems] = useState<{ recurring: RecurringItem[]; planned: PlannedItem[] }>({ recurring: [], planned: [] });
    const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
    const [changeAmountValue, setChangeAmountValue] = useState<number>(0);

    // Staged modifications — runScenarioProjection takes an array, so you can
    // stack 2–3 changes ("raise + new car payment") before running.
    const [mods, setMods] = useState<ScenarioModification[]>([]);
    // IDs of staged mods already applied to the real plan (disables the button).
    const [appliedIdx, setAppliedIdx] = useState<Set<number>>(new Set());

    type RunSummary = { currentEndBalance: number; modifiedEndBalance: number; difference: number; monthsProjected: number };
    // Results
    const [result, setResult] = useState<{
        current: MonthlyProjection[];
        modified: MonthlyProjection[];
        summary: RunSummary;
    } | null>(null);
    // Session-local history of the last few runs, for quick comparison.
    const [history, setHistory] = useState<{ label: string; summary: RunSummary }[]>([]);

    const selectedAccount = accounts.find((a: FinancialAccount) => a.id === selectedAccountId);
    const currency = (selectedAccount?.currency || 'EUR') as Currency;

    // Fetch the account's real items whenever an item-picker template is active,
    // filtering to items that can actually be modified (active recurring; non-
    // override planned items).
    useEffect(() => {
        if (!isItemPicker || !selectedAccountId) return;
        let active = true;
        setSelectedItemId(null);
        Promise.all([getRecurringItems(selectedAccountId), getPlannedItems(selectedAccountId)]).then(([recRes, planRes]) => {
            if (!active) return;
            const recurring = (recRes.success && recRes.data ? recRes.data : []).filter((r) => r.isActive);
            const planned = (planRes.success && planRes.data ? planRes.data : []).filter((p) => !p.isRecurringOverride);
            setPickerItems({ recurring, planned });
        });
        return () => { active = false; };
    }, [isItemPicker, selectedAccountId, selectedTemplate]);

    // Flat lookup + grouped dropdown options for the item picker.
    const itemById = useMemo(() => {
        const map = new Map<string, RecurringItem | PlannedItem>();
        pickerItems.recurring.forEach((r) => map.set(r.id, r));
        pickerItems.planned.forEach((p) => map.set(p.id, p));
        return map;
    }, [pickerItems]);

    const itemGroups = useMemo(() => {
        const groups: { label: string; items: { label: string; value: string }[] }[] = [];
        if (pickerItems.recurring.length > 0) {
            groups.push({
                label: 'Recurring',
                items: pickerItems.recurring.map((r) => ({
                    label: `${r.name} — ${formatCurrency(r.amount, currency)} / ${r.frequency}`,
                    value: r.id,
                })),
            });
        }
        if (pickerItems.planned.length > 0) {
            groups.push({
                label: 'One-off',
                items: pickerItems.planned.map((p) => ({
                    label: `${p.name} — ${formatCurrency(p.amount, currency)}${p.scheduledDate ? ` · ${p.scheduledDate}` : ''}`,
                    value: p.id,
                })),
            });
        }
        return groups;
    }, [pickerItems, currency]);

    const buildFormMod = (): ScenarioModification | null => {
        if (selectedTemplate === 'cancel-item') {
            if (!selectedItemId) return null;
            return { type: 'remove-item', itemId: selectedItemId, name: itemById.get(selectedItemId)?.name };
        }
        if (selectedTemplate === 'change-amount') {
            if (!selectedItemId || !changeAmountValue) return null;
            return {
                type: 'modify-amount',
                itemId: selectedItemId,
                newAmount: changeAmountValue,
                name: itemById.get(selectedItemId)?.name,
            };
        }
        if (!scenarioAmount) return null;
        const modType = selectedTemplate === 'raise' ? 'add-income'
            : selectedTemplate === 'remove-expense' ? 'add-income' // simplified: treat removal as adding inverse
                : 'add-expense'; // add-expense + extra-savings (savings is an expense to yourself)
        const base: ScenarioModification = {
            type: modType,
            name: scenarioName || TEMPLATES.find(t => t.value === selectedTemplate)?.label || 'Scenario',
            amount: scenarioAmount,
        };
        if (scenarioFrequency === 'once') {
            return { ...base, isOneOff: true, scheduledDate: monthToYearMonth(scenarioMonth) };
        }
        return { ...base, frequency: scenarioFrequency };
    };

    const resetFormInputs = () => {
        setScenarioAmount(0);
        setScenarioName('');
        setSelectedItemId(null);
        setChangeAmountValue(0);
    };

    const handleStage = () => {
        const mod = buildFormMod();
        if (!mod) return;
        setMods((m) => [...m, mod]);
        resetFormInputs();
    };

    const handleRun = async () => {
        // Run the staged stack; an unstaged filled form joins in implicitly so
        // the one-change flow stays a single tap.
        const formMod = buildFormMod();
        const toRun = [...mods, ...(formMod ? [formMod] : [])];
        if (!selectedAccountId || toRun.length === 0) return;
        if (formMod) {
            setMods(toRun);
            resetFormInputs();
        }
        setIsRunning(true);
        try {
            const res = await runScenarioProjection(selectedAccountId, toRun);
            if (res.success && res.data) {
                setResult(res.data);
                const label = toRun.map((m) => m.name ?? m.type).join(' + ');
                setHistory((h) => [{ label, summary: res.data!.summary }, ...h].slice(0, 5));
            }
        } finally {
            setIsRunning(false);
        }
    };

    const handleApplyToPlan = async (mod: ScenarioModification, idx: number) => {
        if (!selectedAccountId || !mod.amount || (mod.type !== 'add-income' && mod.type !== 'add-expense')) return;
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const type = mod.type === 'add-income' ? 'income' : 'expense';
        // One-off scenario events become real one-off planned items; recurring
        // ones become recurring items.
        const res = mod.isOneOff
            ? await createPlannedItem(selectedAccountId, {
                type,
                kind: 'one-off',
                name: mod.name || 'From What If?',
                amount: mod.amount,
                scheduledDate: mod.scheduledDate || currentMonth,
            })
            : await createRecurringItem(selectedAccountId, {
                type,
                name: mod.name || 'From What If?',
                amount: mod.amount,
                frequency: mod.frequency ?? 'monthly',
                startDate: currentMonth,
            });
        if (res.success) {
            setAppliedIdx((s) => new Set(s).add(idx));
            toast.success('Added to your plan', `"${mod.name}" is now a real item — see it on Cashflow.`);
            appContext?.refreshData();
        } else {
            toast.error('Could not add item', res.error);
        }
    };

    const handleReset = () => {
        setResult(null);
        resetFormInputs();
        setMods([]);
        setAppliedIdx(new Set());
    };

    // Chip label + color for a staged modification.
    const chipLabel = (m: ScenarioModification): string => {
        if (m.type === 'remove-item') return `✕ ${m.name ?? 'item'}`;
        if (m.type === 'modify-amount') return `${m.name ?? 'item'} → ${formatCurrency(m.newAmount ?? 0, currency)}`;
        const sign = m.type === 'add-income' ? '+' : '−';
        return `${sign}${formatCurrency(m.amount ?? 0, currency)} ${m.name ?? ''}${m.isOneOff ? ' (once)' : ''}`;
    };
    const chipClass = (m: ScenarioModification): string => {
        if (m.type === 'add-income') return 'border-green-300 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300';
        if (m.type === 'modify-amount') return 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300';
        return 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300';
    };

    // Lowest projected point of the modified run (with its month).
    const lowestPoint = useMemo(() => {
        if (!result || result.modified.length === 0) return null;
        return result.modified.reduce((min, m) => (m.endingBalance < min.endingBalance ? m : min), result.modified[0]);
    }, [result]);

    const pendingMod = buildFormMod();

    return (
        <div className="space-y-4 lg:space-y-6 max-w-360 mx-auto py-4 lg:py-8">
            <div>
                <h1 className={`text-4xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                    What If?
                </h1>
                <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    Test changes against your real plan — the same account, income, and bills as your Cashflow — without saving anything.
                </p>
            </div>

            {/* Account selector */}
            {accounts.length > 1 && (
                <Dropdown
                    value={selectedAccountId}
                    options={accounts.map((a: FinancialAccount) => ({ label: a.name, value: a.id }))}
                    onChange={(e) => { setSelectedAccountId(e.value); setResult(null); }}
                    className="w-full md:w-64"
                    placeholder="Select account"
                />
            )}

            {/* Scenario templates */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {TEMPLATES.map(template => (
                    <button
                        key={template.value}
                        onClick={() => { setSelectedTemplate(template.value); setResult(null); }}
                        className={`p-4 rounded-lg border-2 text-left transition-colors ${selectedTemplate === template.value
                            ? 'border-accent-500 bg-accent-50 dark:bg-accent-400/15'
                            : isDark ? 'border-gray-700 hover:border-gray-600' : 'border-gray-200 hover:border-gray-300'
                            }`}
                    >
                        <p className={`font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            {template.label}
                        </p>
                        <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            {template.description}
                        </p>
                    </button>
                ))}
            </div>

            {/* Input form */}
            <Card>
                <div className="space-y-4">
                    <h2 className={`text-lg font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        {TEMPLATES.find(t => t.value === selectedTemplate)?.label}
                    </h2>

                    {isItemPicker ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Which item?
                                </label>
                                <Dropdown
                                    value={selectedItemId}
                                    options={itemGroups}
                                    optionGroupLabel="label"
                                    optionGroupChildren="items"
                                    optionLabel="label"
                                    optionValue="value"
                                    onChange={(e) => setSelectedItemId(e.value)}
                                    placeholder={itemGroups.length === 0 ? 'No items on this account' : 'Select an item'}
                                    disabled={itemGroups.length === 0}
                                    className="w-full"
                                    filter
                                />
                            </div>
                            {selectedTemplate === 'change-amount' && (
                                <div>
                                    <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                        New amount
                                    </label>
                                    <InputNumber
                                        value={changeAmountValue}
                                        onValueChange={e => setChangeAmountValue(e.value ?? 0)}
                                        mode="currency"
                                        currency={currency}
                                        locale="fi-FI"
                                        min={0}
                                        className="w-full"
                                    />
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Name (optional)
                                </label>
                                <InputText
                                    value={scenarioName}
                                    onChange={e => setScenarioName(e.target.value)}
                                    placeholder="e.g. Netflix, Gym membership"
                                    className="w-full"
                                />
                            </div>
                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Amount
                                </label>
                                <InputNumber
                                    value={scenarioAmount}
                                    onValueChange={e => setScenarioAmount(e.value ?? 0)}
                                    mode="currency"
                                    currency={currency}
                                    locale="fi-FI"
                                    min={0}
                                    className="w-full"
                                />
                            </div>
                            <div>
                                <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                    Frequency
                                </label>
                                <SelectButton
                                    value={scenarioFrequency}
                                    options={[
                                        { label: 'Monthly', value: 'monthly' },
                                        { label: 'Quarterly', value: 'quarterly' },
                                        { label: 'Yearly', value: 'yearly' },
                                        { label: 'Once', value: 'once' },
                                    ]}
                                    onChange={e => { if (e.value) setScenarioFrequency(e.value); }}
                                    className="w-full"
                                />
                                {scenarioFrequency === 'once' && (
                                    <Calendar
                                        value={scenarioMonth}
                                        onChange={(e) => { if (e.value) setScenarioMonth(e.value as Date); }}
                                        view="month"
                                        dateFormat="mm/yy"
                                        minDate={new Date()}
                                        className="w-full mt-2"
                                        placeholder="Which month?"
                                    />
                                )}
                            </div>
                        </div>
                    )}

                    {/* Staged changes — stack a few before running */}
                    {mods.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Scenario so far:</span>
                            {mods.map((m, i) => (
                                <span
                                    key={i}
                                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border ${chipClass(m)}`}
                                >
                                    {chipLabel(m)}
                                    <button
                                        type="button"
                                        aria-label={`Remove ${m.name ?? 'change'}`}
                                        className="opacity-60 hover:opacity-100"
                                        onClick={() => {
                                            setMods((all) => all.filter((_, j) => j !== i));
                                            setAppliedIdx(new Set());
                                        }}
                                    >
                                        <MdClose size={14} />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <Button
                            label="Run Scenario"
                            icon={<MdPlayArrow />}
                            onClick={handleRun}
                            loading={isRunning}
                            disabled={!selectedAccountId || (mods.length === 0 && !pendingMod)}
                        />
                        <Button
                            label="Add another change"
                            icon={<MdPlaylistAdd />}
                            severity="secondary"
                            outlined
                            onClick={handleStage}
                            disabled={!pendingMod}
                            tooltip="Stage this change, then set up the next one — run them together"
                            tooltipOptions={{ position: 'top', showOnDisabled: false }}
                        />
                        {(result || mods.length > 0) && (
                            <Button
                                label="Reset"
                                icon={<MdRefresh />}
                                severity="secondary"
                                text
                                onClick={handleReset}
                            />
                        )}
                    </div>
                </div>
            </Card>

            {/* Results */}
            {isRunning && <DelayedSpinner className="flex items-center justify-center py-12" />}

            {result && !isRunning && (
                <div className="space-y-6 animate-fade-in">
                    {/* Apply staged changes to the real plan */}
                    {mods.some((m) => m.type === 'add-income' || m.type === 'add-expense') && (
                        <Card>
                            <h3 className={`font-semibold mb-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>Like what you see?</h3>
                            <p className={`text-sm mb-3 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                Turn a what-if into a real item on your Cashflow.
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {mods.map((m, i) =>
                                    (m.type === 'add-income' || m.type === 'add-expense') ? (
                                        <Button
                                            key={i}
                                            label={appliedIdx.has(i) ? `Added "${m.name}"` : `Add "${m.name}" to my plan`}
                                            icon={appliedIdx.has(i) ? <MdCheck /> : <MdAdd />}
                                            size="small"
                                            outlined
                                            severity={appliedIdx.has(i) ? 'success' : undefined}
                                            disabled={appliedIdx.has(i)}
                                            onClick={() => handleApplyToPlan(m, i)}
                                        />
                                    ) : null
                                )}
                            </div>
                        </Card>
                    )}
                    {/* Key metrics */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <Card>
                            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Current End Balance</p>
                            <p className={`text-2xl font-bold mt-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                {formatCurrency(result.summary.currentEndBalance, currency)}
                            </p>
                        </Card>
                        <Card>
                            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Modified End Balance</p>
                            <p className={`text-2xl font-bold mt-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                {formatCurrency(result.summary.modifiedEndBalance, currency)}
                            </p>
                        </Card>
                        <Card>
                            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Difference</p>
                            <p className={`text-2xl font-bold mt-1 ${result.summary.difference >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                {result.summary.difference >= 0 ? '+' : ''}{formatCurrency(result.summary.difference, currency)}
                            </p>
                            <Tag
                                value={`Over ${result.summary.monthsProjected} months`}
                                severity="info"
                                className="mt-2"
                            />
                        </Card>
                        <Card>
                            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Lowest point</p>
                            <p className={`text-2xl font-bold mt-1 ${lowestPoint && lowestPoint.endingBalance < 0 ? 'text-red-500' : isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                {lowestPoint ? formatCurrency(lowestPoint.endingBalance, currency) : '—'}
                            </p>
                            {lowestPoint && (
                                <p className={`text-xs mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                    {formatYearMonth(lowestPoint.yearMonth)}
                                </p>
                            )}
                        </Card>
                    </div>

                    {/* Comparison chart — current vs modified over the full horizon */}
                    <Card>
                        <h3 className={`font-semibold mb-3 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            <MdTrendingUp className="inline mr-2" />
                            Balance over time
                        </h3>
                        <ScenarioComparisonChart current={result.current} modified={result.modified} currency={currency} />
                    </Card>

                    {/* Monthly comparison */}
                    <Card>
                        <h3 className={`font-semibold mb-4 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            Monthly Comparison (first 12 months)
                        </h3>
                        <div className="overflow-x-auto">
                            <table className={`w-full text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                                <thead>
                                    <tr className={`border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                                        <th className="text-left py-2">Month</th>
                                        <th className="text-right py-2">Current</th>
                                        <th className="text-right py-2">Modified</th>
                                        <th className="text-right py-2">Diff</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {result.current.slice(0, 12).map((month, i) => {
                                        const mod = result.modified[i];
                                        const diff = (mod?.endingBalance ?? 0) - month.endingBalance;
                                        return (
                                            <tr key={month.yearMonth} className={`border-b ${isDark ? 'border-gray-800' : 'border-gray-100'}`}>
                                                <td className="py-2">{month.yearMonth}</td>
                                                <td className="text-right">{formatCurrency(month.endingBalance, currency)}</td>
                                                <td className="text-right">{formatCurrency(mod?.endingBalance ?? 0, currency)}</td>
                                                <td className={`text-right font-medium ${diff >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                    {diff >= 0 ? '+' : ''}{formatCurrency(diff, currency)}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </Card>

                    {/* Recent runs — quick comparison of the last few scenarios */}
                    {history.length > 1 && (
                        <Card>
                            <h3 className={`font-semibold mb-3 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>Recent runs</h3>
                            <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
                                {history.map((h, i) => (
                                    <div key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                                        <span className={`truncate ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                                            {i === 0 && <Tag value="latest" severity="info" className="mr-2 text-xs !py-0 !px-1" />}
                                            {h.label}
                                        </span>
                                        <span className={`shrink-0 font-medium ${h.summary.difference >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                            {h.summary.difference >= 0 ? '+' : ''}{formatCurrency(h.summary.difference, currency)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                </div>
            )}
        </div>
    );
}
