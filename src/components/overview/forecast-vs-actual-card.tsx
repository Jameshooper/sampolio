'use client';

import { useMemo, useState } from 'react';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';
import {
    comparePlanToActual,
    pickDefaultView,
    summarizeMonthProgress,
    type PlanCheckView,
} from '@/lib/forecast-vs-actual';
import { guessItemCategory } from '@/lib/category-utils';
import { formatCurrency, formatYearMonthShort, getCategoryColor } from '@/lib/constants';
import { plainTerm, helpText } from '@/lib/plain-language';
import { HelpHint } from '@/components/ui/help-hint';
import { EmptyState } from '@/components/ui/empty-state';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import type { Currency, MonthlyProjection, ProjectionLineItem } from '@/types';
import { MdCheckCircleOutline, MdExpandMore } from 'react-icons/md';

/** How many ranked rows each view shows. */
const MAX_DEVIATION_ROWS = 4;
const MAX_PROGRESS_ROWS = 5;
/** Items listed inside an expanded row before "+N more". */
const MAX_EXPANDED_ITEMS = 5;
/** Below this, an unmatched-spend footer isn't worth the pixels. */
const MIN_UNMATCHED_FOOTER = 20;

/** A DOM-id-safe panel id for a row key (category names carry spaces/&). */
function panelIdFor(rowKey: string): string {
    return `plan-check-${rowKey.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

interface RowStyles {
    bodyText: string;
    mutedText: string;
    trackBg: string;
    tickBg: string;
    rowActive: string;
}

/**
 * One expandable category row: header line (color dot, name, chevron, verdict),
 * a bullet bar, a sub-line, and the collapsible item list. Module-level so
 * toggling a row never remounts it — the `.collapse-grid` height transition
 * only plays on a surviving element.
 */
function PlanCheckRow({
    category,
    verdict,
    barMaxWidthPct,
    fillPct,
    tickPct,
    subLine,
    items,
    renderItem,
    open,
    onToggle,
    panelId,
    styles,
    mutedText,
}: {
    category: string;
    verdict: React.ReactNode;
    barMaxWidthPct: number;
    fillPct: number;
    tickPct?: number;
    subLine: string;
    items: ProjectionLineItem[];
    renderItem: (item: ProjectionLineItem) => React.ReactNode;
    open: boolean;
    onToggle: () => void;
    panelId: string;
    styles: RowStyles;
    mutedText: string;
}) {
    return (
        <div>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={onToggle}
                className={`w-full text-left rounded px-1 py-1.5 transition-colors ${styles.rowActive}`}
            >
                <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-1.5 min-w-0">
                        <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: getCategoryColor(category) }}
                            aria-hidden
                        />
                        <span className={`truncate ${styles.bodyText}`}>{category}</span>
                        <MdExpandMore
                            size={14}
                            className={`shrink-0 opacity-40 transition-transform ${open ? 'rotate-180' : ''}`}
                            aria-hidden
                        />
                    </span>
                    <span className="whitespace-nowrap text-xs">{verdict}</span>
                </div>
                <div
                    className={`relative h-2 rounded mt-1.5 ${styles.trackBg}`}
                    style={{ width: `${barMaxWidthPct}%`, minWidth: 24 }}
                >
                    <div
                        className="absolute inset-y-0 left-0 rounded"
                        style={{ width: `${fillPct}%`, backgroundColor: getCategoryColor(category) }}
                    />
                    {tickPct !== undefined && (
                        <div
                            className={`absolute w-0.5 -inset-y-0.5 ${styles.tickBg}`}
                            style={{ left: `${tickPct}%` }}
                            aria-hidden
                        />
                    )}
                </div>
                <div className={`text-[11px] opacity-60 mt-1 ${styles.bodyText}`}>{subLine}</div>
            </button>
            <div id={panelId} className={`collapse-grid ${open ? 'is-open' : ''}`} inert={open ? undefined : true}>
                <div className="min-h-0 overflow-hidden">
                    <div className="pl-4 pr-1 pb-2 space-y-0.5">
                        {items.slice(0, MAX_EXPANDED_ITEMS).map((item) => renderItem(item))}
                        {items.length > MAX_EXPANDED_ITEMS && (
                            <div className={`text-xs ${mutedText}`}>+{items.length - MAX_EXPANDED_ITEMS} more</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * "Plan check" — two views on how the plan is holding up:
 *
 *  • This month: how much of each category's plan the bank has recorded as paid
 *    so far (progress, deliberately not judged as good or bad).
 *  • Last closed month: the biggest per-category gaps between the plan and what
 *    the bank actually recorded, stated in words ("€120 more than planned").
 *
 * Purely presentational — the Overview page passes both projections in. Hidden
 * entirely when there is neither a retrospective nor an actualized month (no
 * synced bank account).
 */
export function PlanCheckCard({
    monthly,
    retrospective,
    currency,
}: {
    monthly: MonthlyProjection[];
    retrospective: MonthlyProjection[];
    currency: Currency;
}) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const displayMode = useAppContext()?.displayMode ?? 'advanced';
    const isSimple = displayMode === 'simple';

    const current = monthly[0];
    const lastActual = retrospective[retrospective.length - 1];
    const hasMonthView = Boolean(current?.isActualized);
    const hasLastView = Boolean(lastActual);

    const [view, setView] = useState<PlanCheckView>(() =>
        pickDefaultView(new Date(), monthly[0], retrospective.length > 0)
    );
    const [openRow, setOpenRow] = useState<string | null>(null);

    function switchView(next: PlanCheckView) {
        setView(next);
        setOpenRow(null);
    }

    // This-month view: progress against the plan, all sources included (an
    // already-paid card bill or mortgage payment is real progress too).
    const progress = useMemo(
        () => summarizeMonthProgress(current?.expenseBreakdown ?? []),
        [current]
    );

    // Last-month view: the plan baseline is only the RECURRING part of the
    // current plan (recurring items + repeating planned items). One-off planned
    // items belong to their own specific month — comparing this month's
    // one-offs against last month's reality would flood the list with huge fake
    // "under plan" rows — and injected lines (card bill, mortgage, budget) book
    // under unguessable merchant names, so both stay out.
    const comparisons = useMemo(() => {
        if (!current || !lastActual) return [];
        const plan = current.expenseBreakdown.filter(
            (i) => i.source === 'recurring' || i.source === 'planned-repeating'
        );
        // Retrospective line "categories" are raw bank transaction codes —
        // recategorize by merchant name so they can join the plan's
        // ITEM_CATEGORIES vocabulary (best effort; unmatched → Uncategorized).
        // Card-settlement lines ("Card: X") are dropped symmetrically with the
        // plan side: card-tagged plan items never appear in the cash breakdown
        // either, so neither side of the comparison sees card purchases.
        const actuals: ProjectionLineItem[] = lastActual.expenseBreakdown
            .filter((i) => i.source !== 'credit-card')
            .map((i) => ({
                ...i,
                category: guessItemCategory(i.name) ?? undefined,
            }));
        return comparePlanToActual(plan, actuals);
    }, [current, lastActual]);

    if (retrospective.length === 0 && !monthly[0]?.isActualized) return null;

    const showToggle = hasLastView && hasMonthView;
    // A view with no data can't be shown even if it's the selected one.
    const activeView: PlanCheckView =
        view === 'month' && !hasMonthView ? 'last' : view === 'last' && !hasLastView ? 'month' : view;

    const mutedText = isDark ? 'text-gray-500' : 'text-gray-400';
    const bodyText = isDark ? 'text-gray-200' : 'text-gray-700';
    const trackBg = isDark ? 'bg-gray-700' : 'bg-gray-200';
    const tickBg = isDark ? 'bg-gray-300' : 'bg-gray-500';
    const rowActive = isDark ? 'active:bg-gray-800' : 'active:bg-gray-100';
    const toggleActive = isDark
        ? 'bg-gray-700 text-gray-100 shadow-sm font-medium'
        : 'bg-white text-gray-900 shadow-sm font-medium';

    const rowStyles: RowStyles = { bodyText, mutedText, trackBg, tickBg, rowActive };

    // ── Last-month (deviation) view ──────────────────────────────────────────
    const deviationRows = comparisons
        .filter((c) => c.status !== 'on' && c.category !== 'Uncategorized')
        .slice(0, MAX_DEVIATION_ROWS);
    const onPlanCount = comparisons.filter((c) => c.status === 'on').length;
    const unmatchedTotal = comparisons.find((c) => c.category === 'Uncategorized')?.actual ?? 0;
    const deviationMax = Math.max(...deviationRows.map((r) => Math.max(r.planned, r.actual)), 1);

    // ── This-month (progress) view ───────────────────────────────────────────
    const progressRows = progress.slice(0, MAX_PROGRESS_ROWS);
    const progressMax = Math.max(...progressRows.map((r) => r.planned), 1);
    const progressPlannedTotal = progress.reduce((s, p) => s + p.planned, 0);
    const smallerCount = progress.length - progressRows.length;
    const smallerPlanned = progress.slice(MAX_PROGRESS_ROWS).reduce((s, p) => s + p.planned, 0);

    return (
        <Card>
            <div className="flex items-start justify-between gap-2 flex-wrap">
                <h2 className={`text-lg font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                    {plainTerm('planCheck', isSimple)}
                    <HelpHint text={helpText('planCheck')} />
                </h2>
                {showToggle && current && lastActual && (
                    <div className={`flex items-center rounded-lg p-0.5 ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
                        <button
                            type="button"
                            aria-pressed={activeView === 'month'}
                            onClick={() => switchView('month')}
                            className={`text-xs px-2 py-1 rounded-md transition-colors ${activeView === 'month' ? toggleActive : mutedText}`}
                        >
                            {formatYearMonthShort(current.yearMonth)}
                        </button>
                        <button
                            type="button"
                            aria-pressed={activeView === 'last'}
                            onClick={() => switchView('last')}
                            className={`text-xs px-2 py-1 rounded-md transition-colors ${activeView === 'last' ? toggleActive : mutedText}`}
                        >
                            {formatYearMonthShort(lastActual.yearMonth)}
                        </button>
                    </div>
                )}
            </div>
            <p className={`text-xs mb-3 ${mutedText}`}>
                {activeView === 'month' ? (
                    "What you've paid so far out of this month's plan."
                ) : (
                    <>
                        {plainTerm('lastMonthBaseline', isSimple)}
                        <HelpHint text={helpText('lastMonthBaseline')} />
                    </>
                )}
            </p>

            {activeView === 'last' ? (
                deviationRows.length === 0 ? (
                    <EmptyState
                        icon={<MdCheckCircleOutline />}
                        title="Everything was on plan."
                        className="!py-6"
                    />
                ) : (
                    <>
                        <div className="space-y-1">
                            {deviationRows.map((row) => {
                                const rowMax = Math.max(row.planned, row.actual, 1);
                                const isOver = row.delta > 0;
                                const rowKey = `dev-${row.category}`;
                                return (
                                    <PlanCheckRow
                                        key={rowKey}
                                        open={openRow === rowKey}
                                        onToggle={() => setOpenRow(openRow === rowKey ? null : rowKey)}
                                        panelId={panelIdFor(rowKey)}
                                        styles={rowStyles}
                                        mutedText={mutedText}
                                        category={row.category}
                                        verdict={
                                            <span className={isOver ? 'text-red-500' : 'text-green-500'}>
                                                {formatCurrency(Math.abs(row.delta), currency)}{' '}
                                                {plainTerm(isOver ? 'overPlan' : 'underPlan', isSimple)}
                                            </span>
                                        }
                                        barMaxWidthPct={(rowMax / deviationMax) * 100}
                                        fillPct={(row.actual / rowMax) * 100}
                                        tickPct={(row.planned / rowMax) * 100}
                                        subLine={`spent ${formatCurrency(row.actual, currency)} · planned ${formatCurrency(row.planned, currency)}`}
                                        items={row.actualItems}
                                        renderItem={(item) => (
                                            <div key={item.itemId} className="flex items-center justify-between gap-2 text-xs">
                                                <span className={`truncate ${bodyText}`}>{item.name}</span>
                                                <span className={`whitespace-nowrap ${mutedText}`}>
                                                    {formatCurrency(item.amount, currency)}
                                                </span>
                                            </div>
                                        )}
                                    />
                                );
                            })}
                        </div>
                        {onPlanCount > 0 && (
                            <p className={`text-xs mt-3 ${mutedText}`}>
                                {`${onPlanCount} other ${onPlanCount === 1 ? 'category' : 'categories'} on plan.`}
                            </p>
                        )}
                        {unmatchedTotal >= MIN_UNMATCHED_FOOTER && (
                            <p className={`text-xs mt-1 ${mutedText}`}>
                                {`+ ${formatCurrency(unmatchedTotal, currency)} spending we couldn't match to a category.`}
                            </p>
                        )}
                    </>
                )
            ) : progressRows.length === 0 || progressPlannedTotal === 0 || !hasMonthView ? (
                <EmptyState title="No plan for this month yet." className="!py-6" />
            ) : (
                <>
                    <div className="space-y-1">
                        {progressRows.map((row) => (
                            <PlanCheckRow
                                key={`prog-${row.category}`}
                                open={openRow === `prog-${row.category}`}
                                onToggle={() =>
                                    setOpenRow(openRow === `prog-${row.category}` ? null : `prog-${row.category}`)
                                }
                                panelId={panelIdFor(`prog-${row.category}`)}
                                styles={rowStyles}
                                mutedText={mutedText}
                                category={row.category}
                                verdict={
                                    <span className={mutedText}>
                                        {`${formatCurrency(row.paidSoFar, currency)} of ${formatCurrency(row.planned, currency)}`}
                                    </span>
                                }
                                barMaxWidthPct={(row.planned / progressMax) * 100}
                                fillPct={row.planned > 0 ? Math.min(100, (row.paidSoFar / row.planned) * 100) : 0}
                                subLine={`${formatCurrency(row.paidSoFar, currency)} ${plainTerm('paidOfPlanned', isSimple)}`}
                                items={row.items}
                                renderItem={(item) => (
                                    <div key={item.itemId} className="flex items-center justify-between gap-2 text-xs">
                                        <span className="flex items-center gap-1 min-w-0 flex-wrap">
                                            <span className={`truncate ${bodyText} ${item.isPaid ? 'line-through opacity-60' : ''}`}>
                                                {item.name}
                                            </span>
                                            {item.isPaid && (
                                                <Tag
                                                    value={plainTerm('paidAlready', isSimple)}
                                                    className="text-xs !py-0 !px-1"
                                                    severity="success"
                                                />
                                            )}
                                            {!item.isPaid && item.remainingAmount !== undefined && item.remainingAmount < item.amount && (
                                                <Tag
                                                    value={`${formatCurrency(item.remainingAmount, currency)} left`}
                                                    className="text-xs !py-0 !px-1"
                                                    severity="info"
                                                />
                                            )}
                                        </span>
                                        <span className={`whitespace-nowrap ${mutedText}`}>
                                            {formatCurrency(item.amount, currency)}
                                        </span>
                                    </div>
                                )}
                            />
                        ))}
                    </div>
                    {smallerCount > 0 && (
                        <p className={`text-xs mt-3 ${mutedText}`}>
                            {`+${smallerCount} smaller ${smallerCount === 1 ? 'category' : 'categories'} · ${formatCurrency(smallerPlanned, currency)} planned`}
                        </p>
                    )}
                </>
            )}
        </Card>
    );
}
