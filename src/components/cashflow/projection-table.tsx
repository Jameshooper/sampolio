'use client';

import { useEffect, useRef, useState } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { Button } from 'primereact/button';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import type { MonthlyProjection, Currency } from '@/types';
import { MdHistory } from 'react-icons/md';

interface ProjectionTableProps {
    displayMonths: MonthlyProjection[];
    nowMonth: string;
    selectedMonth: string;
    selectedProjection: MonthlyProjection | null;
    onSelectMonth: (month: string) => void;
    currency: Currency;
    /** Simple mode: hide the long forecast tail behind a "Show all months" toggle. */
    isSimple?: boolean;
}

/** How many months past "now" Simple mode shows before the "Show all" toggle. */
const SIMPLE_TAIL_MONTHS = 12;

export function ProjectionTable({ displayMonths, nowMonth, selectedMonth, selectedProjection, onSelectMonth, currency, isSimple = false }: ProjectionTableProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const demoMasked = useAppContext()?.demoMasked ?? false;
    const desktopTableRef = useRef<HTMLDivElement>(null);
    const mobileListRef = useRef<HTMLDivElement>(null);
    const [showAllMonths, setShowAllMonths] = useState(false);

    // Simple mode trims the forecast tail to a year past "now"; Advanced (or
    // "Show all months") renders everything.
    const nowIdx = displayMonths.findIndex((m) => m.yearMonth === nowMonth);
    const trimmed = isSimple && !showAllMonths && nowIdx >= 0
        ? displayMonths.slice(0, nowIdx + SIMPLE_TAIL_MONTHS)
        : displayMonths;
    const hiddenCount = displayMonths.length - trimmed.length;

    // Default the projection table + mobile card list to start at the current month.
    // Re-runs when the month count changes (not on every in-place refresh) so it
    // sets the default position without fighting the user's manual scrolling.
    useEffect(() => {
        const id = requestAnimationFrame(() => {
            const scrollToNow = (container: Element | null | undefined, selector: string) => {
                if (!container) return;
                const row = container.querySelector(selector) as HTMLElement | null;
                if (!row) return;
                // Offset by any sticky header so the current-month row lands just below it.
                const header = container.querySelector('thead') as HTMLElement | null;
                const headerH = header ? header.getBoundingClientRect().height : 0;
                const top = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - headerH;
                container.scrollTop = Math.max(0, top);
            };
            scrollToNow(desktopTableRef.current?.querySelector('.p-datatable-wrapper'), '.cf-now-row');
            scrollToNow(mobileListRef.current, '.cf-now-card');
        });
        return () => cancelAnimationFrame(id);
    }, [displayMonths.length, nowMonth]);

    return (
        <>
            {/* Desktop: full table (default-scrolled to the current month) */}
            <div className="hidden lg:block" ref={desktopTableRef}>
                <DataTable
                    // Remount when demo mode flips: DataTable's memoized internals
                    // keep stale formatCurrency output across re-renders otherwise.
                    key={demoMasked ? 'masked' : 'plain'}
                    value={trimmed}
                    scrollable
                    scrollHeight="400px"
                    size="small"
                    stripedRows
                    selectionMode="single"
                    selection={selectedProjection}
                    rowClassName={(row) => (row.yearMonth === nowMonth ? 'cf-now-row' : '')}
                    onSelectionChange={(e) => e.value && onSelectMonth(e.value.yearMonth)}
                >
                    <Column
                        field="yearMonth"
                        header="Month"
                        body={(row) => (
                            <span className="flex items-center gap-2 flex-wrap">
                                {formatYearMonth(row.yearMonth)}
                                {row.isActual && (
                                    <Tag value="Actual" className="text-xs !py-0 !px-1 !bg-gray-500/15 !text-gray-500" />
                                )}
                                {row.isActualized && (
                                    <Tag value="in progress" className="text-xs !py-0 !px-1 !bg-blue-500/15 !text-blue-500" />
                                )}
                            </span>
                        )}
                    />
                    <Column
                        field="totalIncome"
                        header="Income"
                        body={(row) => (
                            <span className="text-green-500">
                                +{formatCurrency(row.totalIncome, currency)}
                            </span>
                        )}
                    />
                    <Column
                        field="totalExpenses"
                        header="Expenses"
                        body={(row) => (
                            <span className="text-red-500">
                                -{formatCurrency(row.totalExpenses, currency)}
                            </span>
                        )}
                    />
                    <Column
                        field="netChange"
                        header="Net"
                        body={(row) => (
                            <span className={row.netChange >= 0 ? 'text-green-500' : 'text-red-500'}>
                                {row.netChange >= 0 ? '+' : ''}{formatCurrency(row.netChange, currency)}
                            </span>
                        )}
                    />
                    <Column
                        field="endingBalance"
                        header="Balance"
                        body={(row) => formatCurrency(row.endingBalance, currency)}
                    />
                </DataTable>
            </div>

            {/* Mobile: tappable card list (same data, default-scrolled to now) */}
            <div className="lg:hidden max-h-[60vh] overflow-y-auto -mx-2 px-2 space-y-2" ref={mobileListRef}>
                {trimmed.map((row) => {
                    const active = row.yearMonth === selectedMonth;
                    return (
                        <button
                            key={row.yearMonth}
                            type="button"
                            onClick={() => onSelectMonth(row.yearMonth)}
                            className={`${row.yearMonth === nowMonth ? 'cf-now-card ' : ''}w-full text-left rounded-lg border p-3 transition-colors ${active
                                ? isDark ? 'border-accent-500 bg-accent-900/30' : 'border-accent-500 bg-accent-50'
                                : row.isActual
                                    ? isDark ? 'border-dashed border-gray-700 bg-white/[0.03]' : 'border-dashed border-gray-300 bg-gray-50/60'
                                    : isDark ? 'border-gray-700 bg-gray-800/40' : 'border-gray-200 bg-white'}`}
                        >
                            <div className="flex items-center justify-between mb-2">
                                <span className={`font-semibold flex items-center gap-1.5 flex-wrap ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                                    {formatYearMonth(row.yearMonth)}
                                    {row.isActual && <MdHistory className="text-gray-400" size={14} />}
                                    {row.isActualized && (
                                        <Tag value="in progress" className="text-xs !py-0 !px-1 !bg-blue-500/15 !text-blue-500" />
                                    )}
                                </span>
                                <span className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{formatCurrency(row.endingBalance, currency)}</span>
                            </div>
                            {/* Labeled amounts — the colors alone don't say which is which. */}
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-green-500">
                                    <span className={`text-[10px] uppercase tracking-wide mr-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>in</span>
                                    +{formatCurrency(row.totalIncome, currency)}
                                </span>
                                <span className="text-red-500">
                                    <span className={`text-[10px] uppercase tracking-wide mr-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>out</span>
                                    -{formatCurrency(row.totalExpenses, currency)}
                                </span>
                                <span className={row.netChange >= 0 ? 'text-green-500' : 'text-red-500'}>
                                    <span className={`text-[10px] uppercase tracking-wide mr-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>net</span>
                                    {row.netChange >= 0 ? '+' : ''}{formatCurrency(row.netChange, currency)}
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>

            {hiddenCount > 0 && (
                <div className="text-center mt-2">
                    <Button
                        label={`Show all months (${hiddenCount} more)`}
                        text
                        size="small"
                        severity="secondary"
                        onClick={() => setShowAllMonths(true)}
                    />
                </div>
            )}
        </>
    );
}
