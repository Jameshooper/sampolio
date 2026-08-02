'use client';

import { useState } from 'react';
import { Tag } from 'primereact/tag';
import { useTheme } from '@/components/providers/theme-provider';
import { formatCurrency, getCategoryColor } from '@/lib/constants';
import { plainTerm, helpText } from '@/lib/plain-language';
import { HelpHint } from '@/components/ui/help-hint';
import type { MonthlyProjection, Currency } from '@/types';
import { MdCalendarToday, MdArrowForward, MdHistory } from 'react-icons/md';

/** Sort-by toggle for the income/expense breakdown lists. Module-scope so it
 * isn't recreated on every render (which would reset its state). */
export function SortToggle({ value, onChange, isDark }: { value: 'name' | 'amount'; onChange: (v: 'name' | 'amount') => void; isDark: boolean }) {
    return (
        <div className="flex gap-1">
            <button
                className={`px-1.5 py-0.5 rounded text-xs ${value === 'amount'
                    ? isDark ? 'bg-gray-700 text-gray-200' : 'bg-gray-200 text-gray-800'
                    : isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                    }`}
                onClick={() => onChange('amount')}
            >
                Amount
            </button>
            <button
                className={`px-1.5 py-0.5 rounded text-xs ${value === 'name'
                    ? isDark ? 'bg-gray-700 text-gray-200' : 'bg-gray-200 text-gray-800'
                    : isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                    }`}
                onClick={() => onChange('name')}
            >
                Name
            </button>
        </div>
    );
}

interface MonthDetailsPanelProps {
    projection: MonthlyProjection | null;
    currency: Currency;
    onEditItem?: (itemId: string, source: string, itemType?: string) => void;
    /** Simple-mode wording for the actualized-month labels; defaults to advanced (precise) wording. */
    isSimple?: boolean;
}

export function MonthDetailsPanel({ projection, currency, onEditItem, isSimple = false }: MonthDetailsPanelProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const [incomeSortBy, setIncomeSortBy] = useState<'name' | 'amount'>('amount');
    const [expenseSortBy, setExpenseSortBy] = useState<'name' | 'amount'>('amount');

    if (!projection) {
        return (
            <div className={`text-center py-8 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                <MdCalendarToday size={36} className="mb-4" />
                <p>Select a month to view details</p>
            </div>
        );
    }

    const sortItems = (items: typeof projection.incomeBreakdown, sortBy: 'name' | 'amount') => {
        return [...items].sort((a, b) =>
            sortBy === 'amount' ? b.amount - a.amount : a.name.localeCompare(b.name)
        );
    };

    return (
        <div className="space-y-2">
            {projection.isActual && (
                <div className="flex items-center gap-1.5 text-xs font-medium text-purple-500">
                    <MdHistory size={14} />
                    <span>Actual · from real bank transactions</span>
                </div>
            )}
            {/* Balance Flow: Starting → Net → Ending. This card can be as narrow as a
                mobile viewport (full-width) or a ~1/3-width desktop sidebar column, so
                wrapping is driven by the row's own rendered width (`@container`), not
                the viewport — a viewport breakpoint would stay "wide" on desktop even
                though the actual card is narrow. Below the container threshold the
                three blocks stack VERTICALLY in DOM order — Starting on top, the
                net-change pill centered in the middle (its connector arrow rotated to
                point down), Ending below — so the natural reading order is
                Starting → Difference → Ending instead of the two balances pairing up
                with the pill dropped onto its own row underneath. `@sm:flex-row
                @sm:flex-wrap @sm:items-center @sm:justify-between @sm:gap-x-2` restores
                today's single-line, pill-in-the-middle look (arrow pointing right)
                once the row is actually wide enough. */}
            <div className="@container flex flex-col items-center gap-y-1 py-2 @sm:flex-row @sm:flex-wrap @sm:items-center @sm:justify-between @sm:gap-x-2">
                <div className="text-center min-w-0">
                    <div className={`flex items-center justify-center gap-0.5 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        <span>{projection.isActualized ? plainTerm('balanceToday', isSimple) : 'Starting'}</span>
                        {projection.isActualized && <HelpHint text={helpText('balanceToday')} />}
                    </div>
                    <div className={`text-base @sm:text-lg font-semibold truncate ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        {formatCurrency(projection.startingBalance, currency)}
                    </div>
                </div>
                <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                    {projection.isActualized && (
                        <div className={`flex items-center gap-0.5 text-[10px] uppercase tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            <span>{plainTerm('stillAhead', isSimple)}</span>
                            <HelpHint text={helpText('stillAhead')} />
                        </div>
                    )}
                    <div className="flex items-center gap-1">
                        <div className={`h-px w-4 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`} />
                        <div className={`text-center px-2 py-1 rounded-full ${projection.netChange >= 0
                            ? 'bg-green-500/15 text-green-500'
                            : 'bg-red-500/15 text-red-500'
                            }`}>
                            <div className="text-xs font-medium">
                                {projection.netChange >= 0 ? '+' : ''}{formatCurrency(projection.netChange, currency)}
                            </div>
                        </div>
                        <div className={`h-px w-4 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`} />
                        <MdArrowForward size={12} className={`rotate-90 @sm:rotate-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
                    </div>
                </div>
                <div className="text-center min-w-0">
                    <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {projection.isActualized ? 'Projected end of month' : 'Ending'}
                    </div>
                    <div className={`text-base @sm:text-lg font-bold truncate ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                        {formatCurrency(projection.endingBalance, currency)}
                    </div>
                </div>
            </div>

            {/* Income Breakdown */}
            {projection.incomeBreakdown.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-1">
                        <h4 className={`text-xs font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            Income
                        </h4>
                        <SortToggle value={incomeSortBy} onChange={setIncomeSortBy} isDark={isDark} />
                    </div>
                    <div className="space-y-0">
                        {sortItems(projection.incomeBreakdown, incomeSortBy).map((item) => (
                            <div
                                key={item.itemId}
                                className={`flex justify-between items-center px-2 py-1 rounded cursor-pointer transition-colors text-sm ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                                    }`}
                                onClick={() => onEditItem?.(item.itemId, item.source, 'income')}
                            >
                                <div className="flex items-center gap-1 min-w-0 flex-wrap">
                                    <span className={`truncate ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>{item.name}</span>
                                    {item.isOverridden && (
                                        <Tag value="edited" className="text-xs !py-0 !px-1" severity="contrast" />
                                    )}
                                    {item.source === 'budget' && (
                                        <Tag value="budget" className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                    {item.source === 'trip' && (
                                        <Tag value="per diem" className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                    {item.category && (
                                        <Tag value={item.category} className="text-xs !py-0 !px-1" style={{ backgroundColor: getCategoryColor(item.category), color: '#fff' }} />
                                    )}
                                    {item.isPaid && (
                                        <Tag value={plainTerm('paidAlready', isSimple)} className="text-xs !py-0 !px-1" severity="success" />
                                    )}
                                    {!item.isPaid && item.remainingAmount !== undefined && item.remainingAmount < item.amount && (
                                        <Tag value={`${formatCurrency(item.remainingAmount, currency)} left`} className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                </div>
                                <span className={`text-green-500 whitespace-nowrap ml-2 ${item.isPaid ? 'line-through opacity-60' : ''}`}>+{formatCurrency(item.amount, currency)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Expense Breakdown */}
            {projection.expenseBreakdown.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-1">
                        <h4 className={`text-xs font-semibold ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                            Expenses
                        </h4>
                        <SortToggle value={expenseSortBy} onChange={setExpenseSortBy} isDark={isDark} />
                    </div>
                    <div className="space-y-0">
                        {sortItems(projection.expenseBreakdown, expenseSortBy).map((item) => (
                            <div
                                key={item.itemId}
                                className={`flex justify-between items-center px-2 py-1 rounded cursor-pointer transition-colors text-sm ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                                    }`}
                                onClick={() => onEditItem?.(item.itemId, item.source, 'expense')}
                            >
                                <div className="flex items-center gap-1 min-w-0 flex-wrap">
                                    <span className={`truncate ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>{item.name}</span>
                                    {item.isOverridden && (
                                        <Tag value="edited" className="text-xs !py-0 !px-1" severity="contrast" />
                                    )}
                                    {item.source === 'budget' && (
                                        <Tag value="budget" className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                    {item.source === 'goal' && (
                                        <Tag value="goal" className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                    {item.category && (
                                        <Tag value={item.category} className="text-xs !py-0 !px-1" style={{ backgroundColor: getCategoryColor(item.category), color: '#fff' }} />
                                    )}
                                    {item.isPaid && (
                                        <Tag value={plainTerm('paidAlready', isSimple)} className="text-xs !py-0 !px-1" severity="success" />
                                    )}
                                    {!item.isPaid && item.remainingAmount !== undefined && item.remainingAmount < item.amount && (
                                        <Tag value={`${formatCurrency(item.remainingAmount, currency)} left`} className="text-xs !py-0 !px-1" severity="info" />
                                    )}
                                </div>
                                <span className={`text-red-500 whitespace-nowrap ml-2 ${item.isPaid ? 'line-through opacity-60' : ''}`}>-{formatCurrency(item.amount, currency)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
