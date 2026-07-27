'use client';

import { useMemo, useRef, useCallback } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { MdBarChart } from 'react-icons/md';
import { formatCurrency, getCategoryColor } from '@/lib/constants';
import { describeExpenseBreakdown } from '@/lib/chart-descriptions';
import {
    ChartExplainButton,
    ChartExplainPanel,
    ChartTourBar,
    useChartExplain,
    useChartTour,
    type ReadCue,
    type ChartTourStep,
} from '@/components/ui/chart-explain';
import type { ProjectionLineItem, Currency } from '@/types';

echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);

interface ExpenseTreemapChartProps {
    expenses: ProjectionLineItem[];
    currency: Currency;
    height?: string;
    onClickItem?: (item: ProjectionLineItem) => void;
    /** Per credit-card-link statement breakdown, keyed by the expense `itemId`
     * (= bank link id). When present, a card bill becomes a parent block whose
     * children are the individual purchases instead of a single flat tile. */
    cardBreakdowns?: Map<string, { cardName: string; transactions: { name: string; amount: number }[] }>;
}

// Amber shades for credit-card transaction children (distinct from the warm
// category palette, so a card block reads as one group).
const CARD_PARENT_COLOR = '#f59e0b';
const CARD_TX_SHADES = ['#fbbf24', '#f59e0b', '#fcd34d', '#d97706', '#fde68a', '#b45309'];

/**
 * Treemap chart showing expense breakdown by category or individual item.
 * Groups expenses by category, with individual items as children.
 */
export function ExpenseTreemapChart({ expenses, currency, height = '350px', onClickItem, cardBreakdowns }: ExpenseTreemapChartProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const { demoMasked } = useAppContext() ?? {};

    const built = useMemo(() => {
        if (expenses.length === 0) return null;

        // Credit-card bills with a transaction breakdown become a parent block
        // whose children are the individual purchases (top N + an "Other" tile so
        // the narrow column doesn't fill with slivers). They're pulled out of the
        // category grouping and rendered as standalone top-level blocks.
        const CARD_TX_TOP = 12;
        const handledCardIds = new Set<string>();
        const cardNodes = expenses
            .filter(e => e.source === 'credit-card' && (cardBreakdowns?.get(e.itemId)?.transactions.length ?? 0) > 0)
            .map(exp => {
                const bd = cardBreakdowns!.get(exp.itemId)!;
                handledCardIds.add(exp.itemId);
                const shown = bd.transactions.slice(0, CARD_TX_TOP);
                const children = shown.map((t, i) => ({
                    name: t.name,
                    value: t.amount,
                    itemId: exp.itemId,
                    source: exp.source,
                    itemStyle: { color: CARD_TX_SHADES[i % CARD_TX_SHADES.length] },
                }));
                const rest = exp.amount - shown.reduce((s, t) => s + t.amount, 0);
                const restCount = Math.max(bd.transactions.length - shown.length, 0);
                if (rest > 0.005) {
                    children.push({
                        name: restCount > 0 ? `Other (${restCount})` : 'Other',
                        value: rest,
                        itemId: exp.itemId,
                        source: exp.source,
                        itemStyle: { color: '#92400e' },
                    });
                }
                return { name: exp.name, value: exp.amount, itemId: exp.itemId, source: exp.source, itemStyle: { color: CARD_PARENT_COLOR }, children };
            });

        // Group the remaining expenses by category.
        const categoryMap = new Map<string, { total: number; items: ProjectionLineItem[] }>();
        for (const exp of expenses) {
            if (handledCardIds.has(exp.itemId)) continue;
            const cat = exp.category || 'Uncategorized';
            const entry = categoryMap.get(cat) || { total: 0, items: [] };
            entry.total += exp.amount;
            entry.items.push(exp);
            categoryMap.set(cat, entry);
        }

        // Build treemap data — colors come from the app-wide CATEGORY_COLORS
        // map so the same category looks identical here, in the Sankey, and on
        // the category badges.
        const categoryNodes = Array.from(categoryMap.entries())
            .sort((a, b) => b[1].total - a[1].total)
            .map(([category, { total, items }]) => {
                const color = getCategoryColor(items.length === 1 ? (items[0].category || category) : category);
                if (items.length === 1) {
                    return {
                        name: items[0].name,
                        value: total,
                        itemStyle: { color },
                        itemId: items[0].itemId,
                        source: items[0].source,
                    };
                }
                return {
                    name: category,
                    value: total,
                    itemStyle: { color },
                    children: items
                        .sort((a, b) => b.amount - a.amount)
                        .map(item => ({
                            name: item.name,
                            value: item.amount,
                            itemId: item.itemId,
                            source: item.source,
                        })),
                };
            });

        const treemapData = [...categoryNodes, ...cardNodes].sort((a, b) => b.value - a.value);

        // Top-level node names for the guided tour's highlight steps.
        const topNames = treemapData.map((n) => n.name);
        const largestName = treemapData[0]?.name;
        const parentNames = treemapData.filter((n) => 'children' in n && n.children && n.children.length > 0).map((n) => n.name);
        const cardNames = cardNodes.map((n) => n.name);

        const textColor = isDark ? '#e5e7eb' : '#374151';

        const option = {
            tooltip: {
                backgroundColor: isDark ? '#1f2937' : '#ffffff',
                borderColor: isDark ? '#374151' : '#e5e7eb',
                textStyle: { color: textColor },
                formatter: (params: { name: string; value: number; treePathInfo: Array<{ name: string }> }) => {
                    const path = params.treePathInfo
                        ?.filter(p => p.name)
                        .map(p => p.name)
                        .join(' › ');
                    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
                    const pct = totalExpenses > 0 ? ((params.value / totalExpenses) * 100).toFixed(1) : '0';
                    return `<strong>${path || params.name}</strong><br/>${formatCurrency(params.value, currency)}<br/>${pct}% of total expenses`;
                },
            },
            series: [
                {
                    type: 'treemap',
                    data: treemapData,
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                    roam: false,
                    nodeClick: false,
                    breadcrumb: { show: false },
                    // Header strip on parent blocks (a card, or a multi-item
                    // category) so the group name stays visible above its tiles.
                    // The strip is filled with the (light) gap/border colour, not
                    // the node's warm colour, so the text must contrast with that:
                    // dark in light theme, white (with a soft shadow) in dark theme.
                    upperLabel: {
                        show: true,
                        height: 22,
                        color: isDark ? '#fff' : '#374151',
                        fontSize: 12,
                        fontWeight: 'bold' as const,
                        formatter: (params: { name: string; value: number }) =>
                            `${params.name}  ${formatCurrency(params.value, currency)}`,
                        textShadowColor: isDark ? 'rgba(0,0,0,0.4)' : 'transparent',
                        textShadowBlur: isDark ? 2 : 0,
                    },
                    emphasis: {
                        itemStyle: {
                            borderColor: '#fff',
                            borderWidth: 2,
                        },
                    },
                    label: {
                        show: true,
                        formatter: (params: { name: string; value: number }) => {
                            const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
                            const pct = totalExpenses > 0 ? ((params.value / totalExpenses) * 100).toFixed(0) : '0';
                            return `{name|${params.name}}\n{value|${formatCurrency(params.value, currency)}}\n{pct|${pct}%}`;
                        },
                        rich: {
                            name: {
                                fontSize: 13,
                                fontWeight: 'bold' as const,
                                color: '#fff',
                                lineHeight: 20,
                                textShadowColor: 'rgba(0,0,0,0.3)',
                                textShadowBlur: 2,
                            },
                            value: {
                                fontSize: 11,
                                color: 'rgba(255,255,255,0.9)',
                                lineHeight: 18,
                            },
                            pct: {
                                fontSize: 10,
                                color: 'rgba(255,255,255,0.7)',
                                lineHeight: 16,
                            },
                        },
                    },
                    itemStyle: {
                        borderColor: isDark ? '#1f2937' : '#ffffff',
                        borderWidth: 2,
                        gapWidth: 2,
                    },
                    levels: [
                        {
                            // Category level
                            itemStyle: {
                                borderColor: isDark ? '#111827' : '#f3f4f6',
                                borderWidth: 3,
                                gapWidth: 3,
                            },
                        },
                        {
                            // Item level
                            itemStyle: {
                                borderColor: isDark ? '#1f2937' : '#ffffff',
                                borderWidth: 1,
                                gapWidth: 1,
                            },
                            label: {
                                show: true,
                                formatter: (params: { name: string; value: number }) => {
                                    return `{name|${params.name}}\n{value|${formatCurrency(params.value, currency)}}`;
                                },
                                rich: {
                                    name: {
                                        fontSize: 11,
                                        color: '#fff',
                                        lineHeight: 16,
                                    },
                                    value: {
                                        fontSize: 10,
                                        color: 'rgba(255,255,255,0.8)',
                                        lineHeight: 14,
                                    },
                                },
                            },
                        },
                    ],
                },
            ],
        };

        return { option, topNames, largestName, parentNames, cardNames };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [expenses, currency, isDark, cardBreakdowns, demoMasked]);

    const option = built?.option ?? null;

    // Build a click handler that maps treemap nodes back to expense items.
    // Declared before the early returns below so hooks run in a stable order.
    const onEvents = useMemo(() => {
        if (!onClickItem) return undefined;
        return {
            click: (params: { data?: { itemId?: string; source?: string } }) => {
                const data = params.data;
                if (data?.itemId && data?.source) {
                    const item = expenses.find(e => e.itemId === data.itemId);
                    if (item) onClickItem(item);
                }
            },
        };
    }, [onClickItem, expenses]);

    // Explain / plain-words / guided tour
    const explain = useChartExplain();
    const chartRef = useRef<ReactEChartsCore>(null);
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance() ?? null, []);

    const description = useMemo(
        () => describeExpenseBreakdown(expenses, (n) => formatCurrency(n, currency)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
        [expenses, currency, demoMasked]
    );

    const howToRead: ReadCue[] = useMemo(
        () => [
            { shape: 'square', color: '#3b82f6', text: 'Each tile is a spending category — the bigger the tile, the more you spent.' },
            { shape: 'group', color: '#6b7280', text: 'Tiles with a title bar hold items inside — tap one to zoom in.' },
            { shape: 'square', color: '#f59e0b', text: 'The amber tile is your card bill, split into its purchases.' },
        ],
        []
    );

    const tourSteps: ChartTourStep[] = useMemo(() => {
        if (!built) return [];
        const { topNames, largestName, parentNames, cardNames } = built;
        const hl = (names: string[]) => (chart: EChartsType) => {
            if (names.length) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, name: names });
        };
        const dp = (names: string[]) => (chart: EChartsType) => {
            if (names.length) chart.dispatchAction({ type: 'downplay', seriesIndex: 0, name: names });
        };
        const steps: ChartTourStep[] = [
            { text: 'Each tile is a spending category. Bigger tile, more money.', apply: hl(topNames), clear: dp(topNames) },
        ];
        if (largestName) {
            steps.push({ text: 'The biggest tile is where most of your money went.', apply: hl([largestName]), clear: dp([largestName]) });
        }
        if (parentNames.length) {
            steps.push({ text: 'Tiles with a title bar hold items — tap one to zoom in.', apply: hl(parentNames), clear: dp(parentNames) });
        }
        if (cardNames.length) {
            steps.push({ text: "The amber tile is your card bill, split into its purchases.", apply: hl(cardNames), clear: dp(cardNames) });
        }
        return steps;
    }, [built]);

    const tour = useChartTour(tourSteps, getChart);

    if (expenses.length === 0) {
        return (
            <div className="flex items-center justify-center h-40 opacity-50">
                <div className="text-center">
                    <MdBarChart size={30} className="mb-2" />
                    <p className="text-sm">No expenses this month</p>
                </div>
            </div>
        );
    }

    if (!option) return null;

    return (
        <div>
            <div className="mb-2 flex items-center justify-end">
                <ChartExplainButton open={explain.open} onClick={explain.toggle} controls={explain.panelId} />
            </div>
            <ChartExplainPanel
                id={explain.panelId}
                open={explain.open}
                chartLabel="Expenses breakdown"
                howToRead={howToRead}
                description={description}
                onStartTour={tour.start}
                describedById={explain.descId}
            />
            <ReactEChartsCore
                key={demoMasked ? 'masked' : 'plain'}
                ref={chartRef}
                echarts={echarts}
                option={option}
                style={{ height, width: '100%' }}
                onEvents={onEvents}
                notMerge
                lazyUpdate
                aria-describedby={explain.descId}
            />
            {tour.active && <ChartTourBar tour={tour} label="Expenses breakdown" />}
        </div>
    );
}
