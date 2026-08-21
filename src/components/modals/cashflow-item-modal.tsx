'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog } from 'primereact/dialog';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import { Dropdown, DropdownChangeEvent } from 'primereact/dropdown';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { InputSwitch } from 'primereact/inputswitch';
import { Checkbox } from 'primereact/checkbox';
import { SelectButton } from 'primereact/selectbutton';
import { Calendar } from 'primereact/calendar';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { ProgressSpinner } from 'primereact/progressspinner';
import { confirmDialog } from 'primereact/confirmdialog';
import { useToast } from '@/components/providers/toast-provider';
import { formatCurrency, FREQUENCIES, ITEM_CATEGORIES, formatYearMonth } from '@/lib/constants';
import { guessItemCategory } from '@/lib/category-utils';
import { getCurrentYearMonth, getIntervalMonths } from '@/lib/projection';
import { calculateTaxedIncomeNet, getUpcomingTaxedIncomeOccurrences } from '@/lib/taxed-income-utils';
import {
    getRecurringItems,
    createRecurringItem,
    updateRecurringItem,
    deleteRecurringItem,
} from '@/lib/actions/recurring';
import {
    getPlannedItems,
    createPlannedItem,
    updatePlannedItem,
    deletePlannedItem,
} from '@/lib/actions/planned';
import {
    getSalaryConfigs,
    createSalaryConfig,
    updateSalaryConfig,
    deleteSalaryConfig,
} from '@/lib/actions/salary';
import {
    getTaxedIncomes,
    createTaxedIncome,
    updateTaxedIncome,
    deleteTaxedIncome,
} from '@/lib/actions/taxed-income';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { getCreditCardOptions } from '@/lib/actions/bank';
import { calculateNetSalary } from '@/lib/salary-utils';
import { cashflowItemSchema, type CashflowItemFormData } from '@/lib/schemas/cashflow-item.schema';
import { MdArrowUpward, MdArrowDownward, MdAdd, MdCheckCircle, MdRadioButtonUnchecked, MdEdit, MdDelete, MdClose, MdCheck } from 'react-icons/md';
import type {
    FinancialAccount,
    RecurringItem,
    PlannedItem,
    SalaryConfig,
    TaxedIncome,
    Currency,
    TaxDefaults,
    Frequency,
    YearMonth,
} from '@/types';

type FormRecurrence = 'recurring' | 'one-off' | 'salary' | 'taxed-income';

// Unified item wrapper for the list
type UnifiedItem = {
    id: string;
    name: string;
    amount: number;
    displayAmount: number;
    type: 'income' | 'expense';
    recurrence: FormRecurrence;
    category?: string;
    schedule: string;
    isActive: boolean;
    // Per-month equivalent for the "Regular items" section (recurring/salary/
    // repeating/recurring-taxed). null for one-time items.
    monthlyEquivalent: number | null;
    // Set for one-time items (planned one-off, one-off taxed income) — the month
    // the money is expected. Drives the "One-time items" section.
    scheduledYm?: YearMonth;
    // References back to original data
    sourceType: 'recurring' | 'planned' | 'salary' | 'taxed-income';
    originalItem: RecurringItem | PlannedItem | SalaryConfig | TaxedIncome;
};

interface CashflowItemModalProps {
    visible: boolean;
    onHide: () => void;
    selectedAccountId: string;
    accounts: FinancialAccount[];
    onAccountChange: (accountId: string) => void;
    onDataChange?: () => void;
    editItemId?: string;
    editItemSource?: string;
    initialType?: 'income' | 'expense';
    initialRecurrence?: FormRecurrence;
    autoOpenForm?: boolean;
}

const TYPE_OPTIONS = [
    { label: 'Income', value: 'income', icon: <MdArrowUpward /> },
    { label: 'Expense', value: 'expense', icon: <MdArrowDownward /> },
];

const RECURRENCE_OPTIONS = [
    { label: 'Recurring', value: 'recurring' },
    { label: 'One-Off', value: 'one-off' },
    { label: 'Salary', value: 'salary' },
    { label: 'Gross income', value: 'taxed-income' },
];

const RECURRENCE_OPTIONS_EXPENSE = [
    { label: 'Recurring', value: 'recurring' },
    { label: 'One-Off', value: 'one-off' },
];

const TI_KIND_OPTIONS = [
    { label: 'One-time', value: 'one-off' },
    { label: 'Recurring', value: 'recurring' },
];

const REIMBURSEMENT_STATUS_OPTIONS = [
    { label: 'Pending', value: 'pending' },
    { label: 'Received', value: 'received' },
];

/** Convert YYYY-MM string to Date (1st of that month) */
function yearMonthToDate(ym: string): Date | null {
    if (!ym) return null;
    const [year, month] = ym.split('-').map(Number);
    if (!year || !month) return null;
    return new Date(year, month - 1, 1);
}

/** Convert Date to YYYY-MM string */
function dateToYearMonth(date: Date | null | undefined): string {
    if (!date) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function HelpTip({ text }: { text: string }) {
    return <small className="block mt-1 opacity-60">{text}</small>;
}

function MonthPicker({ value, onChange, placeholder, helpText }: { value: string; onChange: (ym: string) => void; placeholder?: string; helpText?: string }) {
    return (
        <div>
            <Calendar
                value={yearMonthToDate(value)}
                onChange={(e) => onChange(dateToYearMonth(e.value as Date))}
                view="month"
                dateFormat="yy-mm"
                placeholder={placeholder || 'Select month'}
                showIcon
                className="w-full"
            />
            {helpText && <HelpTip text={helpText} />}
        </div>
    );
}

/** Tag label + severity for a unified item's recurrence. */
function recurrenceTag(recurrence: FormRecurrence): { label: string; severity: 'info' | 'warning' | 'secondary' | 'contrast' } {
    switch (recurrence) {
        case 'salary':
            return { label: 'Salary', severity: 'info' };
        case 'taxed-income':
            return { label: 'Gross income', severity: 'contrast' };
        case 'one-off':
            return { label: 'One-off', severity: 'warning' };
        default:
            return { label: 'Recurring', severity: 'secondary' };
    }
}

export function CashflowItemModal({
    visible,
    onHide,
    selectedAccountId,
    accounts,
    onAccountChange,
    onDataChange,
    editItemId,
    initialType,
    initialRecurrence,
    autoOpenForm,
}: CashflowItemModalProps) {
    const toast = useToast();
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [recurringItems, setRecurringItems] = useState<RecurringItem[]>([]);
    const [plannedItems, setPlannedItems] = useState<PlannedItem[]>([]);
    const [salaryConfigs, setSalaryConfigs] = useState<SalaryConfig[]>([]);
    const [taxedIncomes, setTaxedIncomes] = useState<TaxedIncome[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isFormOpen, setIsFormOpen] = useState(false);
    // Quick-add pattern: the create form shows name/amount/category + schedule
    // first; secondary fields (card, dates, reimbursement, active) sit behind
    // "More options". Editing always shows everything.
    const [showMore, setShowMore] = useState(false);
    // True while the category value came from guessItemCategory (keeps
    // re-guessing as the name changes); a manual pick turns it off.
    const [categoryAutoSet, setCategoryAutoSet] = useState(false);
    const [editingItem, setEditingItem] = useState<UnifiedItem | null>(null);
    const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
    const [taxDefaults, setTaxDefaults] = useState<TaxDefaults | null>(null);
    const [cardOptions, setCardOptions] = useState<{ label: string; value: string }[]>([]);

    const account = accounts.find(a => a.id === selectedAccountId);
    const currency = (account?.currency || 'EUR') as Currency;
    const currentYearMonth = getCurrentYearMonth();
    const activeSalary = useMemo(() => salaryConfigs.find(s => s.isActive), [salaryConfigs]);
    const hasActiveSalary = !!activeSalary;

    const buildDefaults = useCallback((): CashflowItemFormData => ({
        recurrence: initialRecurrence ?? 'recurring',
        type: initialType ?? 'income',
        name: '',
        amount: undefined,
        category: '',
        frequency: 'monthly',
        customIntervalMonths: 1,
        startDate: getCurrentYearMonth(),
        endDate: '',
        isActive: true,
        paidByCardLinkId: '',
        isFixedAmount: false,
        scheduledDate: getCurrentYearMonth(),
        isReimbursable: false,
        expectedReimbursementMonth: '',
        reimbursementStatus: 'pending',
        grossSalary: undefined,
        taxRate: taxDefaults?.taxRate,
        contributionsRate: taxDefaults?.contributionsRate,
        otherDeductions: taxDefaults?.otherDeductions ?? 0,
        benefits: [],
        isLinkedToRecurring: true,
        grossAmount: undefined,
        tiKind: 'one-off',
        useSalaryTaxSettings: hasActiveSalary,
        customTaxRate: taxDefaults?.taxRate,
        customContributionsRate: taxDefaults?.contributionsRate,
        customOtherDeductions: taxDefaults?.otherDeductions ?? 0,
        skippedOccurrences: [],
    }), [initialRecurrence, initialType, taxDefaults, hasActiveSalary]);

    const {
        control,
        handleSubmit,
        reset,
        watch,
        setValue,
        getValues,
        formState: { errors },
    } = useForm<CashflowItemFormData>({
        resolver: zodResolver(cashflowItemSchema),
        defaultValues: buildDefaults(),
    });

    const recurrence = watch('recurrence');
    const type = watch('type');
    const tiKind = watch('tiKind');
    const frequency = watch('frequency');
    const useSalaryTaxSettings = watch('useSalaryTaxSettings');
    const isReimbursable = watch('isReimbursable');
    const benefits = watch('benefits') ?? [];
    const grossSalary = watch('grossSalary');
    const taxRate = watch('taxRate');
    const contributionsRate = watch('contributionsRate');
    const otherDeductions = watch('otherDeductions');
    const grossAmount = watch('grossAmount');
    const customTaxRate = watch('customTaxRate');
    const customContributionsRate = watch('customContributionsRate');
    const customOtherDeductions = watch('customOtherDeductions');
    const startDate = watch('startDate');
    const endDate = watch('endDate');
    const customIntervalMonths = watch('customIntervalMonths');
    // Kept as the raw watched value (stable reference) so the skipChipMonths memo
    // below doesn't recompute every render; default with `?? []` at use sites.
    const skippedOccurrences = watch('skippedOccurrences');

    // Load tax defaults
    useEffect(() => {
        getUserPreferences().then(result => {
            if (result.success && result.data?.taxDefaults) {
                setTaxDefaults(result.data.taxDefaults);
            }
        });
    }, []);

    // Load credit-card options (for the "paid by card" tag on expenses)
    useEffect(() => {
        getCreditCardOptions().then(result => {
            if (result.success && result.data) {
                setCardOptions(result.data.map(c => ({ label: c.label, value: c.linkId })));
            }
        });
    }, []);

    // Fetch all items
    const fetchAll = useCallback(async () => {
        if (!selectedAccountId) return;
        setIsLoading(true);
        try {
            const [recResult, planResult, salResult, taxResult] = await Promise.all([
                getRecurringItems(selectedAccountId),
                getPlannedItems(selectedAccountId),
                getSalaryConfigs(selectedAccountId),
                getTaxedIncomes(selectedAccountId),
            ]);
            if (recResult.success && recResult.data) setRecurringItems(recResult.data);
            if (planResult.success && planResult.data) setPlannedItems(planResult.data);
            if (salResult.success && salResult.data) setSalaryConfigs(salResult.data);
            if (taxResult.success && taxResult.data) setTaxedIncomes(taxResult.data);
        } catch (err) {
            console.error('Failed to fetch items:', err);
        } finally {
            setIsLoading(false);
        }
    }, [selectedAccountId]);

    useEffect(() => {
        if (visible && selectedAccountId) {
            fetchAll();
        }
    }, [visible, selectedAccountId, fetchAll]);

    // Build unified list
    const unifiedItems: UnifiedItem[] = useMemo(() => {
        const items: UnifiedItem[] = [];

        // Collect IDs of recurring items linked to salary configs
        const salaryLinkedIds = new Set(
            salaryConfigs
                .filter(s => s.isLinkedToRecurring && s.linkedRecurringItemId)
                .map(s => s.linkedRecurringItemId!)
        );

        recurringItems.forEach(item => {
            // Skip recurring items that are linked to a salary config (shown as salary instead)
            if (salaryLinkedIds.has(item.id)) return;

            items.push({
                id: item.id,
                name: item.name,
                amount: item.amount,
                displayAmount: item.amount,
                type: item.type,
                recurrence: 'recurring',
                category: item.category,
                schedule: `${item.frequency}${item.endDate ? `, until ${formatYearMonth(item.endDate)}` : ''}`,
                isActive: item.isActive,
                monthlyEquivalent: item.amount / getIntervalMonths(item.frequency, item.customIntervalMonths),
                sourceType: 'recurring',
                originalItem: item,
            });
        });

        plannedItems.forEach(item => {
            const isOneOff = item.kind === 'one-off';
            items.push({
                id: item.id,
                name: item.name,
                amount: item.amount,
                displayAmount: item.amount,
                type: item.type,
                recurrence: isOneOff ? 'one-off' : 'recurring',
                category: item.category,
                schedule: isOneOff
                    ? (item.scheduledDate ? formatYearMonth(item.scheduledDate) : '')
                    : `${item.frequency || ''} from ${item.firstOccurrence ? formatYearMonth(item.firstOccurrence) : ''}`,
                isActive: true,
                monthlyEquivalent: isOneOff
                    ? null
                    : item.amount / getIntervalMonths(item.frequency ?? 'monthly', item.customIntervalMonths),
                scheduledYm: isOneOff ? item.scheduledDate : undefined,
                sourceType: 'planned',
                originalItem: item,
            });
        });

        salaryConfigs.forEach(config => {
            items.push({
                id: config.id,
                name: config.name,
                amount: config.netSalary,
                displayAmount: config.netSalary,
                type: 'income',
                recurrence: 'salary',
                category: 'Salary',
                schedule: `Gross: ${formatCurrency(config.grossSalary, currency)}`,
                isActive: config.isActive,
                monthlyEquivalent: config.netSalary,
                sourceType: 'salary',
                originalItem: config,
            });
        });

        taxedIncomes.forEach(ti => {
            const isOneOff = ti.kind === 'one-off';
            const grossLabel = `Gross ${formatCurrency(ti.grossAmount, currency)}`;
            items.push({
                id: ti.id,
                name: ti.name,
                amount: ti.netAmount,
                displayAmount: ti.netAmount,
                type: 'income',
                recurrence: 'taxed-income',
                schedule: isOneOff
                    ? `${ti.scheduledDate ? formatYearMonth(ti.scheduledDate) : ''} · ${grossLabel}`
                    : `${ti.frequency || ''}${ti.startDate ? ` from ${formatYearMonth(ti.startDate)}` : ''} · ${grossLabel}`,
                isActive: ti.isActive,
                monthlyEquivalent: isOneOff
                    ? null
                    : ti.netAmount / getIntervalMonths(ti.frequency ?? 'yearly', ti.customIntervalMonths),
                scheduledYm: isOneOff ? ti.scheduledDate : undefined,
                sourceType: 'taxed-income',
                originalItem: ti,
            });
        });

        return items;
    }, [recurringItems, plannedItems, salaryConfigs, taxedIncomes, currency]);

    const resetForm = useCallback(() => {
        reset(buildDefaults());
        setEditingItem(null);
        setCategoryAutoSet(false);
    }, [reset, buildDefaults]);

    const openEditForm = useCallback((item: UnifiedItem) => {
        setEditingItem(item);
        setShowMore(true); // editing: show every field, nothing hidden
        setCategoryAutoSet(false);
        const orig = item.originalItem;
        const base = buildDefaults();

        if (item.sourceType === 'recurring') {
            const r = orig as RecurringItem;
            reset({
                ...base,
                type: r.type,
                recurrence: 'recurring',
                name: r.name,
                amount: r.amount,
                category: r.category || '',
                frequency: r.frequency,
                customIntervalMonths: r.customIntervalMonths ?? 1,
                startDate: r.startDate,
                endDate: r.endDate || '',
                isActive: r.isActive,
                paidByCardLinkId: r.paidByCardLinkId || '',
                isFixedAmount: r.isFixedAmount ?? false,
            });
        } else if (item.sourceType === 'planned') {
            const p = orig as PlannedItem;
            reset({
                ...base,
                type: p.type,
                recurrence: p.kind === 'one-off' ? 'one-off' : 'recurring',
                name: p.name,
                amount: p.amount,
                category: p.category || '',
                scheduledDate: p.scheduledDate || getCurrentYearMonth(),
                frequency: p.frequency || 'yearly',
                customIntervalMonths: p.customIntervalMonths ?? 12,
                startDate: p.firstOccurrence || getCurrentYearMonth(),
                endDate: p.endDate || '',
                paidByCardLinkId: p.paidByCardLinkId || '',
                isFixedAmount: p.isFixedAmount ?? false,
                isReimbursable: !!p.isReimbursable,
                expectedReimbursementMonth: p.expectedReimbursementMonth || '',
                reimbursementStatus: p.reimbursementStatus || 'pending',
            });
        } else if (item.sourceType === 'salary') {
            const s = orig as SalaryConfig;
            reset({
                ...base,
                type: 'income',
                recurrence: 'salary',
                name: s.name,
                grossSalary: s.grossSalary,
                taxRate: s.taxRate,
                contributionsRate: s.contributionsRate,
                otherDeductions: s.otherDeductions,
                benefits: s.benefits || [],
                startDate: s.startDate,
                endDate: s.endDate || '',
                isActive: s.isActive,
                isLinkedToRecurring: s.isLinkedToRecurring,
            });
        } else if (item.sourceType === 'taxed-income') {
            const t = orig as TaxedIncome;
            reset({
                ...base,
                type: 'income',
                recurrence: 'taxed-income',
                name: t.name,
                grossAmount: t.grossAmount,
                tiKind: t.kind,
                useSalaryTaxSettings: t.useSalaryTaxSettings,
                customTaxRate: t.customTaxRate ?? taxDefaults?.taxRate,
                customContributionsRate: t.customContributionsRate ?? taxDefaults?.contributionsRate,
                customOtherDeductions: t.customOtherDeductions ?? 0,
                scheduledDate: t.scheduledDate || getCurrentYearMonth(),
                frequency: t.frequency || 'yearly',
                customIntervalMonths: t.customIntervalMonths ?? 12,
                startDate: t.startDate || getCurrentYearMonth(),
                endDate: t.endDate || '',
                isActive: t.isActive,
                skippedOccurrences: t.skippedOccurrences ?? [],
            });
        }
        setIsFormOpen(true);
    }, [reset, buildDefaults, taxDefaults]);

    // Auto-open edit form when editItemId is provided
    useEffect(() => {
        if (editItemId && unifiedItems.length > 0 && !isFormOpen) {
            const item = unifiedItems.find(i => i.id === editItemId);
            if (item) {
                openEditForm(item);
            }
        }
    }, [editItemId, unifiedItems.length]); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-open add form when autoOpenForm is true (e.g. from Add Income/Expense buttons)
    useEffect(() => {
        if (autoOpenForm && visible && !editItemId && !isLoading && !isFormOpen) {
            setEditingItem(null);
            reset(buildDefaults());
            setShowMore(false);
            setIsFormOpen(true);
        }
    }, [autoOpenForm, visible, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

    const openNewForm = (nextType?: 'income' | 'expense', nextRecurrence?: FormRecurrence) => {
        setEditingItem(null);
        setCategoryAutoSet(false);
        reset({
            ...buildDefaults(),
            ...(nextType ? { type: nextType } : {}),
            ...(nextRecurrence ? { recurrence: nextRecurrence } : {}),
        });
        setShowMore(false);
        setIsFormOpen(true);
    };

    const onValid = async (data: CashflowItemFormData) => {
        setIsSaving(true);
        try {
            if (data.recurrence === 'salary') {
                const body = {
                    name: data.name,
                    grossSalary: data.grossSalary ?? 0,
                    benefits: data.benefits ?? [],
                    taxRate: data.taxRate ?? 0,
                    contributionsRate: data.contributionsRate ?? 0,
                    otherDeductions: data.otherDeductions ?? 0,
                    startDate: data.startDate || getCurrentYearMonth(),
                    endDate: data.endDate || undefined,
                    isActive: data.isActive,
                    isLinkedToRecurring: data.isLinkedToRecurring,
                };
                if (editingItem?.sourceType === 'salary') {
                    await updateSalaryConfig(selectedAccountId, editingItem.id, body);
                } else {
                    await createSalaryConfig(selectedAccountId, body);
                }
            } else if (data.recurrence === 'taxed-income') {
                const kind = data.tiKind ?? 'one-off';
                const useSalary = data.useSalaryTaxSettings ?? false;
                const body = {
                    name: data.name,
                    grossAmount: data.grossAmount ?? 0,
                    useSalaryTaxSettings: useSalary,
                    customTaxRate: useSalary ? undefined : data.customTaxRate,
                    customContributionsRate: useSalary ? undefined : data.customContributionsRate,
                    customOtherDeductions: useSalary ? undefined : data.customOtherDeductions,
                    kind,
                    scheduledDate: kind === 'one-off' ? (data.scheduledDate || getCurrentYearMonth()) : undefined,
                    frequency: kind === 'recurring' ? (data.frequency as Frequency) : undefined,
                    customIntervalMonths: kind === 'recurring' && data.frequency === 'custom' ? data.customIntervalMonths : undefined,
                    startDate: kind === 'recurring' ? (data.startDate || getCurrentYearMonth()) : undefined,
                    endDate: kind === 'recurring' ? (data.endDate || undefined) : undefined,
                    // Always send the full array on update so a cleared skip actually clears.
                    skippedOccurrences: kind === 'recurring' ? (data.skippedOccurrences ?? []) : undefined,
                    isActive: data.isActive,
                };
                if (editingItem?.sourceType === 'taxed-income') {
                    await updateTaxedIncome(selectedAccountId, editingItem.id, body);
                } else {
                    await createTaxedIncome(selectedAccountId, body);
                }
            } else if (data.recurrence === 'one-off') {
                const wantsReimbursement = data.type === 'expense' && !!data.isReimbursable;
                const body = {
                    type: data.type,
                    kind: 'one-off' as const,
                    name: data.name,
                    amount: data.amount ?? 0,
                    category: data.category || undefined,
                    scheduledDate: data.scheduledDate || getCurrentYearMonth(),
                    paidByCardLinkId: data.type === 'expense' ? (data.paidByCardLinkId || undefined) : undefined,
                    isFixedAmount: data.type === 'expense' ? (data.isFixedAmount || undefined) : undefined,
                    // Explicit false on update clears status + expected month in the db layer.
                    isReimbursable: wantsReimbursement,
                    expectedReimbursementMonth: wantsReimbursement ? data.expectedReimbursementMonth : undefined,
                };
                if (editingItem?.sourceType === 'planned') {
                    await updatePlannedItem(selectedAccountId, editingItem.id, {
                        ...body,
                        reimbursementStatus: wantsReimbursement ? data.reimbursementStatus : undefined,
                    });
                } else {
                    await createPlannedItem(selectedAccountId, body);
                }
            } else {
                const body = {
                    type: data.type,
                    name: data.name,
                    amount: data.amount ?? 0,
                    category: data.category || undefined,
                    frequency: data.frequency as Frequency,
                    customIntervalMonths: data.frequency === 'custom' ? data.customIntervalMonths : undefined,
                    startDate: data.startDate || getCurrentYearMonth(),
                    endDate: data.endDate || undefined,
                    isActive: data.isActive,
                    paidByCardLinkId: data.type === 'expense' ? (data.paidByCardLinkId || undefined) : undefined,
                    isFixedAmount: data.type === 'expense' ? (data.isFixedAmount || undefined) : undefined,
                };
                if (editingItem?.sourceType === 'recurring') {
                    await updateRecurringItem(selectedAccountId, editingItem.id, body);
                } else {
                    await createRecurringItem(selectedAccountId, body);
                }
            }

            await fetchAll();
            setIsFormOpen(false);
            resetForm();
            onDataChange?.();
            toast.success(editingItem ? 'Item updated' : 'Item created');
            if (isStandaloneFormMode) onHide();
        } catch (err) {
            console.error('Failed to save:', err);
            toast.error('Failed to save item');
        } finally {
            setIsSaving(false);
        }
    };

    const performDelete = async (item: UnifiedItem) => {
        setIsDeleting(true);
        try {
            if (item.sourceType === 'recurring') {
                await deleteRecurringItem(selectedAccountId, item.id);
            } else if (item.sourceType === 'planned') {
                await deletePlannedItem(selectedAccountId, item.id);
            } else if (item.sourceType === 'salary') {
                await deleteSalaryConfig(selectedAccountId, item.id);
            } else if (item.sourceType === 'taxed-income') {
                await deleteTaxedIncome(selectedAccountId, item.id);
            }
            await fetchAll();
            onDataChange?.();
            toast.success('Item deleted');
        } catch (err) {
            console.error('Failed to delete:', err);
            toast.error('Failed to delete item');
        } finally {
            setIsDeleting(false);
        }
    };

    const handleDelete = (item: UnifiedItem) => {
        const label = item.sourceType === 'salary'
            ? 'Delete this salary configuration? This will also remove the linked recurring income item.'
            : 'Delete this item?';
        confirmDialog({
            message: label,
            header: 'Delete item',
            icon: 'pi pi-trash',
            acceptClassName: 'p-button-danger',
            accept: () => performDelete(item),
        });
    };

    const handleDeleteFromForm = () => {
        if (!editingItem) return;
        const item = editingItem;
        const label = item.sourceType === 'salary'
            ? 'Delete this salary configuration? This will also remove the linked recurring income item.'
            : 'Delete this item?';
        confirmDialog({
            message: label,
            header: 'Delete item',
            icon: 'pi pi-trash',
            acceptClassName: 'p-button-danger',
            accept: async () => {
                await performDelete(item);
                setIsFormOpen(false);
                resetForm();
                if (isStandaloneFormMode) onHide();
            },
        });
    };

    const handleToggleActive = async (item: UnifiedItem) => {
        try {
            if (item.sourceType === 'recurring') {
                await updateRecurringItem(selectedAccountId, item.id, { isActive: !item.isActive });
            } else if (item.sourceType === 'salary') {
                await updateSalaryConfig(selectedAccountId, item.id, { isActive: !item.isActive });
            } else if (item.sourceType === 'taxed-income') {
                await updateTaxedIncome(selectedAccountId, item.id, { isActive: !item.isActive });
            }
            await fetchAll();
            onDataChange?.();
            toast.success(`Item ${!item.isActive ? 'activated' : 'deactivated'}`);
        } catch (err) {
            console.error('Failed to toggle:', err);
            toast.error('Failed to update status');
        }
    };

    // Income/expense filter applies to both sections.
    const filteredItems = unifiedItems.filter(item => filterType === 'all' || item.type === filterType);

    // Two sections: regular (has a monthly equivalent) and one-time (has a scheduled month).
    const regularItems = useMemo(
        () => filteredItems.filter(i => i.monthlyEquivalent !== null).sort((a, b) => (b.monthlyEquivalent ?? 0) - (a.monthlyEquivalent ?? 0)),
        [filteredItems]
    );
    const oneTimeItems = useMemo(
        () => filteredItems.filter(i => i.scheduledYm !== undefined).sort((a, b) => (a.scheduledYm ?? '').localeCompare(b.scheduledYm ?? '')),
        [filteredItems]
    );

    const activeRegular = regularItems.filter(i => i.isActive);
    const monthlyIncome = activeRegular.filter(i => i.type === 'income').reduce((s, i) => s + (i.monthlyEquivalent ?? 0), 0);
    const monthlyExpenses = activeRegular.filter(i => i.type === 'expense').reduce((s, i) => s + (i.monthlyEquivalent ?? 0), 0);
    const monthlyNet = monthlyIncome - monthlyExpenses;

    const upcomingOneTime = oneTimeItems.filter(i => i.isActive && i.scheduledYm && i.scheduledYm >= currentYearMonth);
    const upcomingIncome = upcomingOneTime.filter(i => i.type === 'income').reduce((s, i) => s + i.displayAmount, 0);
    const upcomingExpense = upcomingOneTime.filter(i => i.type === 'expense').reduce((s, i) => s + i.displayAmount, 0);

    // Salary net preview
    const previewNetSalary = recurrence === 'salary'
        ? calculateNetSalary(grossSalary ?? 0, taxRate ?? 0, contributionsRate ?? 0, otherDeductions ?? 0, benefits)
        : 0;

    // Taxed-income net preview
    const tiNet = useMemo(() => {
        if (recurrence !== 'taxed-income') return null;
        const gross = grossAmount ?? 0;
        const tr = useSalaryTaxSettings ? (activeSalary?.taxRate ?? 0) : (customTaxRate ?? 0);
        const cr = useSalaryTaxSettings ? (activeSalary?.contributionsRate ?? 0) : (customContributionsRate ?? 0);
        const od = useSalaryTaxSettings ? (activeSalary?.otherDeductions ?? 0) : (customOtherDeductions ?? 0);
        return calculateTaxedIncomeNet(gross, tr, cr, od);
    }, [recurrence, grossAmount, useSalaryTaxSettings, customTaxRate, customContributionsRate, customOtherDeductions, activeSalary]);

    // Skip-occurrence chips: upcoming occurrences ∪ future months already skipped.
    const skipChipMonths = useMemo(() => {
        if (recurrence !== 'taxed-income' || tiKind !== 'recurring') return [];
        const upcoming = getUpcomingTaxedIncomeOccurrences(
            {
                kind: 'recurring',
                frequency: frequency as Frequency,
                customIntervalMonths,
                startDate: startDate || undefined,
                scheduledDate: undefined,
                endDate: endDate || undefined,
            },
            currentYearMonth,
            3,
        );
        const futureSkipped = (skippedOccurrences ?? []).filter(m => m >= currentYearMonth);
        return Array.from(new Set([...upcoming, ...futureSkipped])).sort();
    }, [recurrence, tiKind, frequency, customIntervalMonths, startDate, endDate, skippedOccurrences, currentYearMonth]);

    const toggleSkip = (month: string) => {
        const current = getValues('skippedOccurrences') ?? [];
        const next = current.includes(month)
            ? current.filter(m => m !== month)
            : [...current, month].sort();
        setValue('skippedOccurrences', next, { shouldDirty: true });
    };

    const recurrenceOptions = type === 'expense' ? RECURRENCE_OPTIONS_EXPENSE : RECURRENCE_OPTIONS;
    const showAmountAndCategory = recurrence === 'recurring' || recurrence === 'one-off';
    const showDateRange = showMore && (recurrence === 'recurring' || recurrence === 'salary' || (recurrence === 'taxed-income' && tiKind === 'recurring'));
    const showActiveToggle = showMore && recurrence !== 'one-off';

    const formTitle = editingItem
        ? `Edit ${editingItem.recurrence === 'salary' ? 'Salary' : editingItem.recurrence === 'taxed-income' ? 'Gross Income' : 'Item'}`
        : 'Add Item';

    // Skip the full items list dialog and show only the form when:
    // - autoOpenForm is true (create mode from Add Income/Expense buttons), or
    // - editItemId is set (editing a specific item directly)
    const isStandaloneFormMode = autoOpenForm || !!editItemId;

    const handleFormClose = () => {
        setIsFormOpen(false);
        resetForm();
        if (isStandaloneFormMode) onHide();
    };

    const amountColumn = (item: UnifiedItem) => (
        <span className={`font-medium ${item.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
            {item.type === 'income' ? '+' : '-'}{formatCurrency(item.displayAmount, currency)}
        </span>
    );
    const typeTag = (item: UnifiedItem) => (
        <Tag value={item.type} severity={item.type === 'income' ? 'success' : 'danger'} />
    );
    const statusTag = (item: UnifiedItem) => (
        <Tag value={item.isActive ? 'Active' : 'Inactive'} severity={item.isActive ? 'success' : 'secondary'} />
    );
    const actionsColumn = (item: UnifiedItem) => (
        <div className="flex justify-end gap-1">
            {(item.sourceType === 'recurring' || item.sourceType === 'salary' || item.sourceType === 'taxed-income') && (
                <Button
                    icon={item.isActive ? <MdCheckCircle /> : <MdRadioButtonUnchecked />}
                    text size="small"
                    tooltip={item.isActive ? 'Deactivate' : 'Activate'}
                    tooltipOptions={{ position: 'top' }}
                    onClick={() => handleToggleActive(item)}
                />
            )}
            <Button icon={<MdEdit />} text size="small" tooltip="Edit" tooltipOptions={{ position: 'top' }} onClick={() => openEditForm(item)} />
            <Button icon={<MdDelete />} text size="small" severity="danger" tooltip="Delete" tooltipOptions={{ position: 'top' }} onClick={() => handleDelete(item)} />
        </div>
    );

    return (
        <>
            {!isStandaloneFormMode && (
                <Dialog
                    header="Cashflow Items"
                    visible={visible}
                    onHide={onHide}
                    style={{ width: '95vw', maxWidth: '1400px' }}
                    maximizable
                    modal
                    dismissableMask
                >
                    <div className="space-y-6">
                        {/* Header */}
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-3">
                                <Dropdown
                                    value={selectedAccountId}
                                    onChange={(e: DropdownChangeEvent) => onAccountChange(e.value)}
                                    options={accounts.filter(a => !a.isArchived).map(a => ({ value: a.id, label: a.name }))}
                                    optionLabel="label"
                                    optionValue="value"
                                    placeholder="Select Account"
                                    className="w-48"
                                />
                                <div className="flex gap-1">
                                    {(['all', 'income', 'expense'] as const).map(t => (
                                        <Button
                                            key={t}
                                            label={t.charAt(0).toUpperCase() + t.slice(1)}
                                            size="small"
                                            severity={filterType === t ? undefined : 'secondary'}
                                            outlined={filterType !== t}
                                            onClick={() => setFilterType(t)}
                                        />
                                    ))}
                                </div>
                            </div>
                            <Button label="Add Item" icon={<MdAdd />} onClick={() => openNewForm()} />
                        </div>

                        {/* Items */}
                        {isLoading ? (
                            <div className="flex justify-center py-8">
                                <ProgressSpinner style={{ width: '40px', height: '40px' }} />
                            </div>
                        ) : regularItems.length === 0 && oneTimeItems.length === 0 ? (
                            <div className="text-center py-8 opacity-50">
                                No items yet. Click &quot;Add Item&quot; to create one.
                            </div>
                        ) : (
                            <>
                                {/* === Regular items === */}
                                {regularItems.length > 0 && (
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold opacity-70">Regular items</h3>
                                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                            <Card className="p-3!">
                                                <div className="text-center">
                                                    <p className="text-sm text-gray-500">≈ Monthly income</p>
                                                    <p className="text-xl font-bold text-green-600">{formatCurrency(monthlyIncome, currency)}</p>
                                                </div>
                                            </Card>
                                            <Card className="p-3!">
                                                <div className="text-center">
                                                    <p className="text-sm text-gray-500">≈ Monthly expenses</p>
                                                    <p className="text-xl font-bold text-red-600">{formatCurrency(monthlyExpenses, currency)}</p>
                                                </div>
                                            </Card>
                                            <Card className="p-3!">
                                                <div className="text-center">
                                                    <p className="text-sm text-gray-500">≈ Net per month</p>
                                                    <p className={`text-xl font-bold ${monthlyNet >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        {formatCurrency(monthlyNet, currency)}
                                                    </p>
                                                </div>
                                            </Card>
                                        </div>
                                        <p className="text-xs opacity-50">Quarterly amounts are ÷3 and yearly ÷12 to estimate the monthly figure.</p>
                                        <div className="overflow-x-auto">
                                            <DataTable
                                                value={regularItems}
                                                dataKey="id"
                                                size="small"
                                                stripedRows
                                                rowHover
                                                sortField="monthlyEquivalent"
                                                sortOrder={-1}
                                            >
                                                <Column header="Name" body={(item: UnifiedItem) => (
                                                    <div>
                                                        <span className="font-medium">{item.name}</span>
                                                        {item.category && <span className="block text-xs opacity-60">{item.category}</span>}
                                                    </div>
                                                )} />
                                                <Column header="Type" body={typeTag} />
                                                <Column header="Kind" body={(item: UnifiedItem) => {
                                                    const t = recurrenceTag(item.recurrence);
                                                    return <Tag value={t.label} severity={t.severity} />;
                                                }} />
                                                <Column header="Amount" align="right" body={amountColumn} sortable sortField="displayAmount" />
                                                <Column header="≈ / month" align="right" sortable sortField="monthlyEquivalent" body={(item: UnifiedItem) => (
                                                    <span className={`${item.type === 'income' ? 'text-green-600' : 'text-red-600'}`}>
                                                        {item.monthlyEquivalent === null ? '—' : `${item.type === 'income' ? '+' : '-'}${formatCurrency(item.monthlyEquivalent, currency)}`}
                                                    </span>
                                                )} />
                                                <Column header="Schedule" body={(item: UnifiedItem) => (
                                                    <span className="text-xs opacity-60">{item.schedule}</span>
                                                )} />
                                                <Column header="Status" align="center" body={statusTag} />
                                                <Column header="Actions" align="right" body={actionsColumn} />
                                            </DataTable>
                                        </div>
                                    </div>
                                )}

                                {/* === One-time items === */}
                                {oneTimeItems.length > 0 && (
                                    <div className="space-y-3">
                                        <h3 className="text-sm font-semibold opacity-70">One-time items</h3>
                                        <div className="text-sm flex flex-wrap gap-x-4 gap-y-1">
                                            <span className="opacity-60">Upcoming:</span>
                                            <span className="text-green-600 font-medium">+{formatCurrency(upcomingIncome, currency)}</span>
                                            <span className="text-red-600 font-medium">-{formatCurrency(upcomingExpense, currency)}</span>
                                        </div>
                                        <div className="overflow-x-auto">
                                            <DataTable
                                                value={oneTimeItems}
                                                dataKey="id"
                                                size="small"
                                                stripedRows
                                                rowHover
                                                sortField="scheduledYm"
                                                sortOrder={1}
                                            >
                                                <Column header="Name" body={(item: UnifiedItem) => (
                                                    <div>
                                                        <span className="font-medium">{item.name}</span>
                                                        {item.recurrence === 'taxed-income' && <span className="block text-xs opacity-60">Gross income</span>}
                                                        {item.category && <span className="block text-xs opacity-60">{item.category}</span>}
                                                    </div>
                                                )} />
                                                <Column header="Type" body={typeTag} />
                                                <Column header="Amount" align="right" body={amountColumn} sortable sortField="displayAmount" />
                                                <Column header="Month" body={(item: UnifiedItem) => (
                                                    <span className="text-xs opacity-60">{item.scheduledYm ? formatYearMonth(item.scheduledYm) : ''}</span>
                                                )} sortable sortField="scheduledYm" />
                                                <Column header="Status" align="center" body={statusTag} />
                                                <Column header="Actions" align="right" body={actionsColumn} />
                                            </DataTable>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </Dialog>
            )}

            {/* Form Dialog */}
            <Dialog
                header={formTitle}
                visible={isFormOpen}
                onHide={handleFormClose}
                style={{ width: '550px' }}
                modal
            >
                <div className="space-y-4">
                    {/* Type: Income / Expense */}
                    <div>
                        <label className="text-sm font-medium mb-1 block">Type</label>
                        <Controller
                            name="type"
                            control={control}
                            render={({ field }) => (
                                <SelectButton
                                    value={field.value}
                                    onChange={(e) => {
                                        const val = e.value as 'income' | 'expense';
                                        if (!val) return;
                                        field.onChange(val);
                                        const rec = getValues('recurrence');
                                        if (val === 'expense' && (rec === 'salary' || rec === 'taxed-income')) {
                                            setValue('recurrence', 'recurring');
                                        }
                                    }}
                                    options={TYPE_OPTIONS}
                                    optionLabel="label"
                                    optionValue="value"
                                    className="w-full"
                                    disabled={editingItem?.sourceType === 'salary' || editingItem?.sourceType === 'taxed-income'}
                                />
                            )}
                        />
                        <HelpTip text="Income = money coming in. Expense = money going out." />
                    </div>

                    {/* Recurrence */}
                    <div>
                        <label className="text-sm font-medium mb-1 block">Recurrence</label>
                        <Controller
                            name="recurrence"
                            control={control}
                            render={({ field }) => (
                                <SelectButton
                                    value={field.value}
                                    onChange={(e) => {
                                        const val = e.value as FormRecurrence;
                                        if (!val) return;
                                        field.onChange(val);
                                        if (val === 'salary' || val === 'taxed-income') setValue('type', 'income');
                                        if (val === 'taxed-income' && !editingItem) setValue('frequency', 'yearly');
                                    }}
                                    options={recurrenceOptions}
                                    optionLabel="label"
                                    optionValue="value"
                                    className="w-full"
                                    disabled={!!editingItem}
                                />
                            )}
                        />
                        <HelpTip text="Recurring = repeats on a schedule. One-off = happens once. Salary = income with tax/deduction calculations. Gross income = a taxed lump sum like a bonus or holiday pay." />
                    </div>

                    {/* Name */}
                    <div>
                        <label className="text-sm font-medium">Name</label>
                        <Controller
                            name="name"
                            control={control}
                            render={({ field }) => (
                                <InputText
                                    value={field.value}
                                    onChange={e => {
                                        const name = e.target.value;
                                        field.onChange(name);
                                        // Auto-suggest a category from the name while the category is
                                        // untouched ("Netflix" → Entertainment). Recurring/one-off only.
                                        const cat = getValues('category');
                                        const canGuess = !editingItem && showAmountAndCategory && (!cat || categoryAutoSet);
                                        if (canGuess) {
                                            const suggested = guessItemCategory(name);
                                            if (suggested && suggested !== cat) {
                                                setCategoryAutoSet(true);
                                                setValue('category', suggested);
                                            } else if (!suggested && categoryAutoSet) {
                                                setValue('category', '');
                                            }
                                        }
                                    }}
                                    placeholder={recurrence === 'salary' ? 'e.g., Main Job' : recurrence === 'taxed-income' ? 'e.g., Holiday bonus, Annual bonus' : type === 'income' ? 'e.g., Freelance Work, Dividends' : 'e.g., Rent, Groceries, Netflix'}
                                    className="w-full"
                                />
                            )}
                        />
                        {errors.name && <small className="text-red-500">{errors.name.message}</small>}
                        <HelpTip text="A descriptive name to identify this item." />
                    </div>

                    {/* Amount (recurring / one-off) */}
                    {showAmountAndCategory && (
                        <div>
                            <label className="text-sm font-medium">Amount ({currency})</label>
                            <Controller
                                name="amount"
                                control={control}
                                render={({ field }) => (
                                    <InputNumber
                                        value={field.value ?? null}
                                        onValueChange={e => field.onChange(e.value ?? undefined)}
                                        mode="currency"
                                        currency={currency}
                                        locale="fi-FI"
                                        placeholder="0.00"
                                        className="w-full"
                                    />
                                )}
                            />
                            {errors.amount && <small className="text-red-500">{errors.amount.message}</small>}
                            <HelpTip text={recurrence === 'recurring' ? 'The amount per occurrence (e.g., monthly rent amount).' : 'The one-time amount for this item.'} />
                        </div>
                    )}

                    {/* Category (recurring / one-off) */}
                    {showAmountAndCategory && (
                        <div>
                            <Controller
                                name="category"
                                control={control}
                                render={({ field }) => (
                                    <>
                                        <label className="text-sm font-medium">Category{categoryAutoSet && field.value ? <span className="ml-1 text-xs opacity-60">(suggested)</span> : null}</label>
                                        <Dropdown
                                            value={field.value}
                                            onChange={e => { setCategoryAutoSet(false); field.onChange(e.value); }}
                                            options={[{ value: '', label: 'None' }, ...ITEM_CATEGORIES.map(c => ({ value: c, label: c }))]}
                                            optionLabel="label"
                                            optionValue="value"
                                            placeholder="Select a category"
                                            className="w-full"
                                        />
                                    </>
                                )}
                            />
                            <HelpTip text="Optional grouping for reporting and charts." />
                        </div>
                    )}

                    {/* Paid by card (expenses only) */}
                    {showMore && type === 'expense' && showAmountAndCategory && cardOptions.length > 0 && (
                        <div>
                            <label className="text-sm font-medium">Paid by card</label>
                            <Controller
                                name="paidByCardLinkId"
                                control={control}
                                render={({ field }) => (
                                    <Dropdown
                                        value={field.value}
                                        onChange={e => field.onChange(e.value)}
                                        options={[{ value: '', label: 'Paid from cash' }, ...cardOptions]}
                                        optionLabel="label"
                                        optionValue="value"
                                        placeholder="Paid from cash"
                                        className="w-full"
                                    />
                                )}
                            />
                            <HelpTip text="If this is charged to a credit card, pick it here. The expense then stops hitting cash directly — it rolls into that card's statement (real bills when synced, forecast bills for future months), so it isn't double-counted with your card transactions." />
                        </div>
                    )}

                    {/* Fixed amount (expenses only) */}
                    {showMore && type === 'expense' && showAmountAndCategory && (
                        <div>
                            <div className="flex items-center gap-2">
                                <Controller
                                    name="isFixedAmount"
                                    control={control}
                                    render={({ field }) => (
                                        <Checkbox
                                            inputId="fixed-amount"
                                            checked={!!field.value}
                                            onChange={e => field.onChange(e.checked ?? false)}
                                        />
                                    )}
                                />
                                <label htmlFor="fixed-amount" className="text-sm font-medium cursor-pointer">Fixed amount</label>
                            </div>
                            <HelpTip text="This bill is always exactly this amount. Don't estimate what's left from other spending in its category — only mark it paid when the matching bank payment appears." />
                        </div>
                    )}

                    {/* === SALARY SPECIFIC FIELDS === */}
                    {recurrence === 'salary' && (
                        <>
                            {!editingItem && taxDefaults && (
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    Rates below are prefilled from your defaults (Settings → Finance).
                                    Editing them here only affects this salary.
                                </p>
                            )}
                            <div>
                                <label className="text-sm font-medium">Gross Salary (Monthly)</label>
                                <Controller
                                    name="grossSalary"
                                    control={control}
                                    render={({ field }) => (
                                        <InputNumber
                                            value={field.value ?? null}
                                            onValueChange={e => field.onChange(e.value ?? undefined)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            placeholder="Your monthly gross salary"
                                            className="w-full"
                                        />
                                    )}
                                />
                                {errors.grossSalary && <small className="text-red-500">{errors.grossSalary.message}</small>}
                                <HelpTip text="Your salary before taxes and deductions. The net amount will be calculated automatically." />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="text-sm font-medium">Tax Rate (%)</label>
                                    <Controller
                                        name="taxRate"
                                        control={control}
                                        render={({ field }) => (
                                            <InputNumber
                                                value={field.value ?? null}
                                                onValueChange={e => field.onChange(e.value ?? undefined)}
                                                suffix=" %"
                                                locale="fi-FI"
                                                minFractionDigits={0}
                                                maxFractionDigits={2}
                                                placeholder="e.g., 25,50"
                                                className="w-full"
                                            />
                                        )}
                                    />
                                    <HelpTip text="Your income tax rate." />
                                </div>
                                <div>
                                    <label className="text-sm font-medium">Contributions (%)</label>
                                    <Controller
                                        name="contributionsRate"
                                        control={control}
                                        render={({ field }) => (
                                            <InputNumber
                                                value={field.value ?? null}
                                                onValueChange={e => field.onChange(e.value ?? undefined)}
                                                suffix=" %"
                                                locale="fi-FI"
                                                minFractionDigits={0}
                                                maxFractionDigits={2}
                                                placeholder="e.g., 7,15"
                                                className="w-full"
                                            />
                                        )}
                                    />
                                    <HelpTip text="Social security or pension contributions." />
                                </div>
                            </div>
                            <div>
                                <label className="text-sm font-medium">Other Deductions (Fixed Amount)</label>
                                <Controller
                                    name="otherDeductions"
                                    control={control}
                                    render={({ field }) => (
                                        <InputNumber
                                            value={field.value ?? null}
                                            onValueChange={e => field.onChange(e.value ?? 0)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            placeholder="0.00"
                                            className="w-full"
                                        />
                                    )}
                                />
                                <HelpTip text="Any fixed monthly deductions (e.g., union fees, insurance)." />
                            </div>

                            {/* Benefits */}
                            <Controller
                                name="benefits"
                                control={control}
                                render={({ field }) => {
                                    const list = field.value ?? [];
                                    return (
                                        <div>
                                            <div className="flex items-center justify-between mb-2">
                                                <label className="text-sm font-medium">Benefits</label>
                                                <Button
                                                    label="Add Benefit"
                                                    icon={<MdAdd />}
                                                    size="small"
                                                    text
                                                    onClick={() => field.onChange([...list, { id: crypto.randomUUID(), name: '', amount: 0, isTaxable: true }])}
                                                />
                                            </div>
                                            <HelpTip text="Additional benefits like meal vouchers, health insurance, etc. Mark whether each benefit is taxable." />
                                            {list.length > 0 && (
                                                <div className="space-y-2 mt-2">
                                                    {list.map((benefit, index) => (
                                                        <div key={benefit.id} className="flex items-center gap-2 p-2 bg-gray-100 dark:bg-gray-800 rounded-lg">
                                                            <InputText
                                                                placeholder="e.g., Meal Voucher"
                                                                value={benefit.name}
                                                                onChange={e => {
                                                                    const next = [...list];
                                                                    next[index] = { ...next[index], name: e.target.value };
                                                                    field.onChange(next);
                                                                }}
                                                                className="flex-1"
                                                                size={1}
                                                            />
                                                            <InputNumber
                                                                placeholder="0"
                                                                value={benefit.amount}
                                                                onValueChange={e => {
                                                                    const next = [...list];
                                                                    next[index] = { ...next[index], amount: e.value ?? 0 };
                                                                    field.onChange(next);
                                                                }}
                                                                mode="currency"
                                                                currency={currency}
                                                                locale="fi-FI"
                                                                className="w-36"
                                                            />
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <InputSwitch
                                                                    checked={benefit.isTaxable}
                                                                    onChange={e => {
                                                                        const next = [...list];
                                                                        next[index] = { ...next[index], isTaxable: e.value ?? true };
                                                                        field.onChange(next);
                                                                    }}
                                                                />
                                                                <span className="text-xs whitespace-nowrap">{benefit.isTaxable ? 'Taxable' : 'Non-tax'}</span>
                                                            </div>
                                                            <Button
                                                                icon={<MdClose />}
                                                                rounded
                                                                text
                                                                severity="danger"
                                                                size="small"
                                                                onClick={() => field.onChange(list.filter((_, i) => i !== index))}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                }}
                            />

                            {/* Net salary preview */}
                            <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg space-y-1">
                                {benefits.length > 0 && (
                                    <div className="flex justify-between text-xs opacity-60">
                                        <span>Taxable Gross</span>
                                        <span>{formatCurrency(
                                            (grossSalary ?? 0) + benefits.filter(b => b.isTaxable).reduce((s, b) => s + b.amount, 0),
                                            currency
                                        )}</span>
                                    </div>
                                )}
                                <div className="flex justify-between items-center">
                                    <span className="text-sm opacity-60">Calculated Net Salary</span>
                                    <span className="text-xl font-bold text-green-600">{formatCurrency(previewNetSalary, currency)}</span>
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <Controller
                                    name="isLinkedToRecurring"
                                    control={control}
                                    render={({ field }) => (
                                        <InputSwitch checked={!!field.value} onChange={e => field.onChange(e.value ?? false)} />
                                    )}
                                />
                                <label className="text-sm">Add as recurring income item</label>
                            </div>
                            <HelpTip text="When enabled, a recurring income entry is automatically created based on the net salary." />
                        </>
                    )}

                    {/* === GROSS (TAXED) INCOME SPECIFIC FIELDS === */}
                    {recurrence === 'taxed-income' && (
                        <>
                            <div>
                                <label className="text-sm font-medium">Gross Amount ({currency})</label>
                                <Controller
                                    name="grossAmount"
                                    control={control}
                                    render={({ field }) => (
                                        <InputNumber
                                            value={field.value ?? null}
                                            onValueChange={e => field.onChange(e.value ?? undefined)}
                                            mode="currency"
                                            currency={currency}
                                            locale="fi-FI"
                                            placeholder="Amount before tax"
                                            className="w-full"
                                        />
                                    )}
                                />
                                {errors.grossAmount && <small className="text-red-500">{errors.grossAmount.message}</small>}
                                <HelpTip text="The gross (pre-tax) amount, e.g. a holiday bonus or one-time bonus." />
                            </div>

                            <div>
                                <label className="text-sm font-medium mb-1 block">When</label>
                                <Controller
                                    name="tiKind"
                                    control={control}
                                    render={({ field }) => (
                                        <SelectButton
                                            value={field.value}
                                            onChange={e => { if (e.value) field.onChange(e.value); }}
                                            options={TI_KIND_OPTIONS}
                                            optionLabel="label"
                                            optionValue="value"
                                            className="w-full"
                                        />
                                    )}
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <Controller
                                    name="useSalaryTaxSettings"
                                    control={control}
                                    render={({ field }) => (
                                        <InputSwitch
                                            checked={!!field.value}
                                            disabled={!hasActiveSalary}
                                            onChange={e => field.onChange(e.value ?? false)}
                                        />
                                    )}
                                />
                                <label className="text-sm">Use my salary&apos;s tax settings</label>
                            </div>
                            {hasActiveSalary
                                ? <HelpTip text="Applies the active salary's tax and contribution rates. If those rates change, this recomputes automatically." />
                                : <HelpTip text="No active salary on this account — enter the tax and contribution rates manually below." />}

                            {!useSalaryTaxSettings && (
                                <>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="text-sm font-medium">Tax Rate (%)</label>
                                            <Controller
                                                name="customTaxRate"
                                                control={control}
                                                render={({ field }) => (
                                                    <InputNumber
                                                        value={field.value ?? null}
                                                        onValueChange={e => field.onChange(e.value ?? undefined)}
                                                        suffix=" %"
                                                        locale="fi-FI"
                                                        minFractionDigits={0}
                                                        maxFractionDigits={2}
                                                        placeholder="e.g., 30"
                                                        className="w-full"
                                                    />
                                                )}
                                            />
                                        </div>
                                        <div>
                                            <label className="text-sm font-medium">Contributions (%)</label>
                                            <Controller
                                                name="customContributionsRate"
                                                control={control}
                                                render={({ field }) => (
                                                    <InputNumber
                                                        value={field.value ?? null}
                                                        onValueChange={e => field.onChange(e.value ?? undefined)}
                                                        suffix=" %"
                                                        locale="fi-FI"
                                                        minFractionDigits={0}
                                                        maxFractionDigits={2}
                                                        placeholder="e.g., 8"
                                                        className="w-full"
                                                    />
                                                )}
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="text-sm font-medium">Other Deductions (Fixed Amount)</label>
                                        <Controller
                                            name="customOtherDeductions"
                                            control={control}
                                            render={({ field }) => (
                                                <InputNumber
                                                    value={field.value ?? null}
                                                    onValueChange={e => field.onChange(e.value ?? 0)}
                                                    mode="currency"
                                                    currency={currency}
                                                    locale="fi-FI"
                                                    placeholder="0.00"
                                                    className="w-full"
                                                />
                                            )}
                                        />
                                    </div>
                                </>
                            )}

                            {/* Net preview */}
                            {tiNet && (
                                <div className="p-4 bg-gray-100 dark:bg-gray-800 rounded-lg space-y-1">
                                    <div className="flex justify-between text-xs opacity-60">
                                        <span>Tax</span>
                                        <span>−{formatCurrency(tiNet.taxAmount, currency)}</span>
                                    </div>
                                    <div className="flex justify-between text-xs opacity-60">
                                        <span>Contributions</span>
                                        <span>−{formatCurrency(tiNet.contributionsAmount, currency)}</span>
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm opacity-60">Calculated Net</span>
                                        <span className="text-xl font-bold text-green-600">{formatCurrency(tiNet.netAmount, currency)}</span>
                                    </div>
                                </div>
                            )}

                            {/* Schedule */}
                            {tiKind === 'one-off' ? (
                                <div>
                                    <label className="text-sm font-medium">Scheduled Month</label>
                                    <Controller
                                        name="scheduledDate"
                                        control={control}
                                        render={({ field }) => (
                                            <MonthPicker value={field.value ?? ''} onChange={field.onChange} placeholder="When is it paid?" />
                                        )}
                                    />
                                    {errors.scheduledDate && <small className="text-red-500">{errors.scheduledDate.message}</small>}
                                </div>
                            ) : (
                                <>
                                    <div>
                                        <label className="text-sm font-medium">Frequency</label>
                                        <Controller
                                            name="frequency"
                                            control={control}
                                            render={({ field }) => (
                                                <Dropdown
                                                    value={field.value}
                                                    onChange={e => field.onChange(e.value)}
                                                    options={FREQUENCIES}
                                                    optionLabel="label"
                                                    optionValue="value"
                                                    className="w-full"
                                                />
                                            )}
                                        />
                                        <HelpTip text="How often this amount is paid (holiday pay is typically yearly)." />
                                    </div>
                                    {frequency === 'custom' && (
                                        <div>
                                            <label className="text-sm font-medium">Interval (months)</label>
                                            <Controller
                                                name="customIntervalMonths"
                                                control={control}
                                                render={({ field }) => (
                                                    <InputNumber
                                                        value={field.value ?? null}
                                                        onValueChange={e => field.onChange(e.value ?? undefined)}
                                                        placeholder="e.g., 6"
                                                        className="w-full"
                                                        min={1}
                                                        showButtons
                                                    />
                                                )}
                                            />
                                        </div>
                                    )}
                                    {skipChipMonths.length > 0 && (
                                        <div>
                                            <label className="text-sm font-medium mb-1 block">Skip occurrences</label>
                                            <div className="flex flex-wrap gap-2">
                                                {skipChipMonths.map(month => {
                                                    const isSkipped = (skippedOccurrences ?? []).includes(month);
                                                    return (
                                                        <Button
                                                            key={month}
                                                            label={formatYearMonth(month)}
                                                            size="small"
                                                            outlined={!isSkipped}
                                                            severity={isSkipped ? 'danger' : 'secondary'}
                                                            icon={isSkipped ? 'pi pi-times' : undefined}
                                                            onClick={() => toggleSkip(month)}
                                                        />
                                                    );
                                                })}
                                            </div>
                                            <HelpTip text="Tap a month to skip that occurrence — e.g. a year when the holiday bonus isn't paid." />
                                        </div>
                                    )}
                                </>
                            )}
                        </>
                    )}

                    {/* === RECURRING SPECIFIC FIELDS === */}
                    {recurrence === 'recurring' && (
                        <>
                            <div>
                                <label className="text-sm font-medium">Frequency</label>
                                <Controller
                                    name="frequency"
                                    control={control}
                                    render={({ field }) => (
                                        <Dropdown
                                            value={field.value}
                                            onChange={e => field.onChange(e.value)}
                                            options={FREQUENCIES}
                                            optionLabel="label"
                                            optionValue="value"
                                            className="w-full"
                                        />
                                    )}
                                />
                                <HelpTip text="How often this item repeats. Use 'Custom' for non-standard intervals." />
                            </div>
                            {frequency === 'custom' && (
                                <div>
                                    <label className="text-sm font-medium">Interval (months)</label>
                                    <Controller
                                        name="customIntervalMonths"
                                        control={control}
                                        render={({ field }) => (
                                            <InputNumber
                                                value={field.value ?? null}
                                                onValueChange={e => field.onChange(e.value ?? undefined)}
                                                placeholder="e.g., 3 for quarterly"
                                                className="w-full"
                                                min={1}
                                                showButtons
                                            />
                                        )}
                                    />
                                    <HelpTip text="Number of months between each occurrence." />
                                </div>
                            )}
                        </>
                    )}

                    {/* === ONE-OFF SPECIFIC FIELDS === */}
                    {recurrence === 'one-off' && (
                        <div>
                            <label className="text-sm font-medium">Scheduled Month</label>
                            <Controller
                                name="scheduledDate"
                                control={control}
                                render={({ field }) => (
                                    <MonthPicker value={field.value ?? ''} onChange={field.onChange} placeholder="When will this happen?" />
                                )}
                            />
                            {errors.scheduledDate && <small className="text-red-500">{errors.scheduledDate.message}</small>}
                            <HelpTip text="The month this one-time item is expected to occur." />
                        </div>
                    )}

                    {/* Reimbursement (one-off expenses only) */}
                    {showMore && recurrence === 'one-off' && type === 'expense' && (
                        <div>
                            <div className="flex items-center gap-2">
                                <Controller
                                    name="isReimbursable"
                                    control={control}
                                    render={({ field }) => (
                                        <Checkbox
                                            inputId="expect-reimbursement"
                                            checked={!!field.value}
                                            onChange={e => {
                                                field.onChange(e.checked ?? false);
                                                if (e.checked && !getValues('expectedReimbursementMonth')) {
                                                    setValue('expectedReimbursementMonth', getCurrentYearMonth());
                                                }
                                            }}
                                        />
                                    )}
                                />
                                <label htmlFor="expect-reimbursement" className="text-sm font-medium cursor-pointer">Expect reimbursement</label>
                            </div>
                            <HelpTip text="The expense still hits your cash as usual; a matching 'Reimbursement' income line is projected in the month you expect the money back, until it's marked received." />
                            {isReimbursable && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                                    <div>
                                        <label className="text-sm font-medium">Expected Month</label>
                                        <Controller
                                            name="expectedReimbursementMonth"
                                            control={control}
                                            render={({ field }) => (
                                                <MonthPicker value={field.value ?? ''} onChange={field.onChange} placeholder="When is it paid back?" />
                                            )}
                                        />
                                        {errors.expectedReimbursementMonth && <small className="text-red-500">{errors.expectedReimbursementMonth.message}</small>}
                                    </div>
                                    {editingItem?.sourceType === 'planned' && !!(editingItem.originalItem as PlannedItem).isReimbursable && (
                                        <div>
                                            <label className="text-sm font-medium">Status</label>
                                            <Controller
                                                name="reimbursementStatus"
                                                control={control}
                                                render={({ field }) => (
                                                    <SelectButton
                                                        value={field.value}
                                                        onChange={e => { if (e.value) field.onChange(e.value); }}
                                                        options={REIMBURSEMENT_STATUS_OPTIONS}
                                                        optionLabel="label"
                                                        optionValue="value"
                                                        className="w-full"
                                                    />
                                                )}
                                            />
                                            <HelpTip text="Mark as received once the money arrives — the projected income line then disappears." />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Date range (recurring / salary / recurring taxed income) */}
                    {showDateRange && (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="text-sm font-medium">Start Month</label>
                                <Controller
                                    name="startDate"
                                    control={control}
                                    render={({ field }) => (
                                        <MonthPicker value={field.value ?? ''} onChange={field.onChange} placeholder="First month" />
                                    )}
                                />
                                <HelpTip text="First month this item takes effect." />
                            </div>
                            <div>
                                <label className="text-sm font-medium">End Month (opt)</label>
                                <Controller
                                    name="endDate"
                                    control={control}
                                    render={({ field }) => (
                                        <MonthPicker value={field.value ?? ''} onChange={field.onChange} placeholder="Leave empty = ongoing" />
                                    )}
                                />
                                <HelpTip text="Leave empty to continue indefinitely." />
                            </div>
                        </div>
                    )}

                    {/* Active toggle (recurring / salary / taxed income) */}
                    {showActiveToggle && (
                        <div className="flex items-center gap-2">
                            <Controller
                                name="isActive"
                                control={control}
                                render={({ field }) => (
                                    <InputSwitch checked={!!field.value} onChange={e => field.onChange(e.value ?? false)} />
                                )}
                            />
                            <label className="text-sm">Active</label>
                            <HelpTip text="Inactive items are paused and won't appear in projections." />
                        </div>
                    )}

                    {/* More options */}
                    {!showMore && (
                        <Button
                            label="More options"
                            icon="pi pi-chevron-down"
                            text
                            size="small"
                            severity="secondary"
                            className="self-start"
                            onClick={() => setShowMore(true)}
                        />
                    )}

                    {/* Buttons */}
                    <div className="flex justify-between gap-2 pt-2">
                        <div>
                            {editingItem && (
                                <Button
                                    icon={<MdDelete />}
                                    severity="danger"
                                    outlined
                                    onClick={handleDeleteFromForm}
                                    loading={isDeleting}
                                    disabled={isSaving}
                                >
                                    <span className="hidden sm:inline ml-2">Delete</span>
                                </Button>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <Button label="Cancel" severity="secondary" outlined onClick={handleFormClose} disabled={isSaving || isDeleting} />
                            <Button label="Save" icon={<MdCheck />} onClick={handleSubmit(onValid)} loading={isSaving} disabled={isDeleting} />
                        </div>
                    </div>
                </div>
            </Dialog>
        </>
    );
}
