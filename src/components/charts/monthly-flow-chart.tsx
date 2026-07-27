'use client';

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import type { EChartsType } from 'echarts/core';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { formatCurrency, getCategoryColor } from '@/lib/constants';
import { describeMonthlyFlow } from '@/lib/chart-descriptions';
import {
    ChartExplainButton,
    ChartExplainPanel,
    ChartTourBar,
    useChartExplain,
    useChartTour,
    type ReadCue,
    type ChartTourStep,
} from '@/components/ui/chart-explain';
import type { MonthFlowData, CashflowItem, Currency } from '@/types';

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer]);

// Sources whose inflow is shown GROSS with tax/contribution/other deductions
// split off as their own outflows (salary + taxed income / bonuses). They flow
// from their income node straight to a shared "Deductions" node rather than
// through the Budget.
const isGrossSource = (source: CashflowItem['source']): boolean =>
    source === 'salary' || source === 'taxed-income';

export interface CardFlowBreakdown {
    cardName: string;
    transactions: { name: string; amount: number }[];
}

interface MonthlyFlowChartProps {
    data: MonthFlowData;
    currency?: Currency;
    height?: string;
    onClickItem?: (item: CashflowItem) => void;
    onClickStart?: () => void;
    onClickEnd?: () => void;
    /** Per credit-card-link statement breakdown, keyed by the outflow item id
     * (= bank link id). When present, a card bill is drawn as its own node with
     * the individual purchases as leaves instead of a single bar. */
    cardBreakdowns?: Map<string, CardFlowBreakdown>;
}

interface NodeMeta {
    items: CashflowItem[];
    side: 'left' | 'center' | 'right';
}

export function MonthlyFlowChart({
    data,
    currency = 'EUR',
    height = '400px',
    onClickItem,
    cardBreakdowns,
}: MonthlyFlowChartProps) {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const { demoMasked } = useAppContext() ?? {};
    const chartRef = useRef<ReactEChartsCore>(null);
    const [nodeMetaMap] = useState<Map<string, NodeMeta>>(() => new Map());

    const GREEN = '#22c55e';
    const RED = '#ef4444';
    const BLUE = '#3b82f6';
    const AMBER = '#f59e0b';

    const { nodes, links, metaMap, labeledNodes, maxCol } = useMemo(() => {
        const nodes: Array<{ name: string; itemStyle: { color: string; borderColor: string }; depth?: number; label?: { position: 'left' | 'right' } }> = [];
        const links: Array<{ source: string; target: string; value: number; lineStyle?: { color: string; opacity: number } }> = [];
        const meta = new Map<string, NodeMeta>();

        // Use data.netChange (real net based on net salary) for savings/deficit,
        // not totalInflows - totalOutflows (which includes gross salary + deductions)
        const netChange = data.netChange;
        const hasSavings = netChange > 0;
        const hasDeficit = netChange < 0;

        // Center node: "Budget"
        const centerNodeName = 'Budget';
        nodes.push({
            name: centerNodeName,
            itemStyle: { color: BLUE, borderColor: BLUE },
            depth: 1,
        });
        meta.set(centerNodeName, { items: [], side: 'center' });

        // Separate gross-source deductions (salary + taxed income) from regular
        // expenses — these flow directly from the gross income node, not through Budget.
        const grossDeductions = data.outflows.filter(item => isGrossSource(item.source));
        const regularOutflows = data.outflows.filter(item => !isGrossSource(item.source));

        // Track which gross inflow nodes were created (for linking deductions)
        const grossInflowNodeNames = new Map<string, string>(); // linkedEntityId -> nodeName

        // Income nodes (depth 0) — individual items, no grouping
        data.inflows.forEach(item => {
            const nodeName = `Income: ${item.name}`;
            const existingNode = nodes.find(n => n.name === nodeName);
            const uniqueName = existingNode ? `Income: ${item.name} (${item.id.slice(-4)})` : nodeName;
            nodes.push({
                name: uniqueName,
                itemStyle: { color: GREEN, borderColor: GREEN },
                depth: 0,
            });

            // For gross inflows (salary / taxed income): split into net (→ Budget)
            // and deductions.
            const isGrossInflow = isGrossSource(item.source) && item.linkedEntityId;
            const linkedDeductions = isGrossInflow
                ? grossDeductions.filter(d => d.linkedEntityId === item.linkedEntityId)
                : [];
            const deductionTotal = linkedDeductions.reduce((s, d) => s + d.amount, 0);
            const netToBudget = item.amount - deductionTotal;

            if (isGrossInflow && deductionTotal > 0 && item.linkedEntityId) {
                grossInflowNodeNames.set(item.linkedEntityId, uniqueName);
                // Only net income flows to Budget
                if (netToBudget > 0) {
                    links.push({
                        source: uniqueName,
                        target: centerNodeName,
                        value: netToBudget,
                        lineStyle: { color: GREEN, opacity: 0.3 },
                    });
                }
            } else {
                // Non-salary income: full amount flows to Budget
                links.push({
                    source: uniqueName,
                    target: centerNodeName,
                    value: item.amount,
                    lineStyle: { color: GREEN, opacity: 0.3 },
                });
            }
            meta.set(uniqueName, { items: [item], side: 'left' });
        });

        // Gross-source deductions: flow from gross income node → Deductions category → individual items
        if (grossDeductions.length > 0) {
            const ORANGE = '#f97316';
            const deductionsCatName = 'Deductions';
            nodes.push({
                name: deductionsCatName,
                itemStyle: { color: ORANGE, borderColor: ORANGE },
                depth: 2,
            });
            meta.set(deductionsCatName, { items: grossDeductions, side: 'right' });

            // Link each gross inflow to the Deductions node
            const deductionsBySource = new Map<string, number>();
            for (const d of grossDeductions) {
                if (d.linkedEntityId) {
                    deductionsBySource.set(d.linkedEntityId, (deductionsBySource.get(d.linkedEntityId) || 0) + d.amount);
                }
            }
            for (const [entityId, amount] of deductionsBySource) {
                const sourceName = grossInflowNodeNames.get(entityId);
                if (sourceName) {
                    links.push({
                        source: sourceName,
                        target: deductionsCatName,
                        value: amount,
                        lineStyle: { color: ORANGE, opacity: 0.3 },
                    });
                }
            }

            // Individual deduction items (depth 3)
            grossDeductions.forEach(item => {
                const itemNodeName = `Deduction: ${item.name}`;
                const existingNode = nodes.find(n => n.name === itemNodeName);
                const uniqueName = existingNode ? `Deduction: ${item.name} (${item.id.slice(-4)})` : itemNodeName;
                nodes.push({
                    name: uniqueName,
                    itemStyle: { color: '#fb923c', borderColor: '#fb923c' },
                    depth: 3,
                });
                links.push({
                    source: deductionsCatName,
                    target: uniqueName,
                    value: item.amount,
                    lineStyle: { color: '#fb923c', opacity: 0.2 },
                });
                meta.set(uniqueName, { items: [item], side: 'right' });
            });
        }

        // Credit-card bills with a transaction breakdown are drawn as their own
        // node (depth 2) with the individual purchases as leaves (depth 3); the
        // rest group by category as usual.
        const cardItems = regularOutflows.filter(
            i => i.source === 'credit-card' && (cardBreakdowns?.get(i.id)?.transactions.length ?? 0) > 0
        );
        const nonCardOutflows = regularOutflows.filter(
            i => !(i.source === 'credit-card' && (cardBreakdowns?.get(i.id)?.transactions.length ?? 0) > 0)
        );

        // Expense categories (depth 2) + individual items (depth 3) — excludes salary deductions
        const expensesByCategory = new Map<string, CashflowItem[]>();
        nonCardOutflows.forEach(item => {
            const key = item.category || 'Other';
            if (!expensesByCategory.has(key)) expensesByCategory.set(key, []);
            expensesByCategory.get(key)!.push(item);
        });

        const sortedCategories = Array.from(expensesByCategory.entries())
            .map(([cat, items]) => ({
                category: cat,
                items,
                total: items.reduce((s, i) => s + i.amount, 0),
            }))
            .sort((a, b) => b.total - a.total);

        // Category nodes take their color from the shared CATEGORY_COLORS map
        // (same hue as the treemap and category badges); items inherit it.
        sortedCategories.forEach(({ category, items, total }) => {
            const catNodeName = `Category: ${category}`;
            const catColor = getCategoryColor(category);
            nodes.push({
                name: catNodeName,
                itemStyle: { color: catColor, borderColor: catColor },
                depth: 2,
            });
            links.push({
                source: centerNodeName,
                target: catNodeName,
                value: total,
                lineStyle: { color: catColor, opacity: 0.3 },
            });
            meta.set(catNodeName, { items, side: 'right' });

            // Individual expense items (depth 3) — always expand
            items
                .sort((a, b) => b.amount - a.amount)
                .forEach(item => {
                    const itemNodeName = `Expense: ${item.name}`;
                    const existingNode = nodes.find(n => n.name === itemNodeName);
                    const uniqueName = existingNode ? `Expense: ${item.name} (${item.id.slice(-4)})` : itemNodeName;
                    nodes.push({
                        name: uniqueName,
                        itemStyle: { color: catColor, borderColor: catColor },
                        depth: 3,
                    });
                    links.push({
                        source: catNodeName,
                        target: uniqueName,
                        value: item.amount,
                        lineStyle: { color: catColor, opacity: 0.2 },
                    });
                    meta.set(uniqueName, { items: [item], side: 'right' });
                });
        });

        // Credit cards: Budget → "Card: X" (depth 2) → individual purchases (depth 3)
        cardItems.forEach(item => {
            const bd = cardBreakdowns!.get(item.id)!;
            const catName = `Card: ${bd.cardName}`;
            nodes.push({ name: catName, itemStyle: { color: AMBER, borderColor: AMBER }, depth: 2 });
            links.push({
                source: centerNodeName,
                target: catName,
                value: item.amount,
                lineStyle: { color: AMBER, opacity: 0.3 },
            });
            meta.set(catName, { items: [item], side: 'right' });

            // Show only the largest purchases individually; roll the long tail
            // (plus any rounding / estimate difference) into one "Other" leaf so
            // the chart stays readable when a statement has many transactions.
            // `bd.transactions` arrives sorted by descending amount.
            const TOP_CARD_TX = 8;
            const shown = bd.transactions.slice(0, TOP_CARD_TX);
            shown.forEach((t, idx) => {
                const leafName = `CardTx: ${t.name} (${item.id.slice(-4)}-${idx})`;
                nodes.push({ name: leafName, itemStyle: { color: '#fbbf24', borderColor: '#fbbf24' }, depth: 3 });
                links.push({
                    source: catName,
                    target: leafName,
                    value: t.amount,
                    lineStyle: { color: '#fbbf24', opacity: 0.2 },
                });
                meta.set(leafName, { items: [], side: 'right' });
            });
            const rest = item.amount - shown.reduce((s, t) => s + t.amount, 0);
            const restCount = Math.max(bd.transactions.length - shown.length, 0);
            if (rest > 0.005) {
                const label = restCount > 0 ? `Other (${restCount} purchases)` : 'Other';
                const moreName = `CardTx: ${label} (${item.id.slice(-4)}-more)`;
                nodes.push({ name: moreName, itemStyle: { color: '#d97706', borderColor: '#d97706' }, depth: 3 });
                links.push({ source: catName, target: moreName, value: rest, lineStyle: { color: '#d97706', opacity: 0.25 } });
                meta.set(moreName, { items: [], side: 'right' });
            }
        });

        // Savings or Deficit node
        if (hasSavings) {
            const savingsCatName = 'Savings';
            nodes.push({
                name: savingsCatName,
                itemStyle: { color: GREEN, borderColor: GREEN },
                depth: 2,
            });
            links.push({
                source: centerNodeName,
                target: savingsCatName,
                value: netChange,
                lineStyle: { color: GREEN, opacity: 0.3 },
            });
            meta.set(savingsCatName, { items: [], side: 'right' });

            // Extend to depth 3
            const savingsItemName = 'Net Savings';
            nodes.push({
                name: savingsItemName,
                itemStyle: { color: GREEN, borderColor: GREEN },
                depth: 3,
            });
            links.push({
                source: savingsCatName,
                target: savingsItemName,
                value: netChange,
                lineStyle: { color: GREEN, opacity: 0.3 },
            });
            meta.set(savingsItemName, { items: [], side: 'right' });
        } else if (hasDeficit) {
            const deficitName = 'From Previous Balance';
            nodes.push({
                name: deficitName,
                itemStyle: { color: AMBER, borderColor: AMBER },
                depth: 0,
            });
            links.push({
                source: deficitName,
                target: centerNodeName,
                value: Math.abs(netChange),
                lineStyle: { color: AMBER, opacity: 0.3 },
            });
            meta.set(deficitName, { items: [], side: 'left' });
        }

        // Actualized month: expense/income flows are planned amounts while netChange
        // is the adjusted (still-ahead) net, so the Budget node wouldn't balance.
        // The gap is what already settled out of today's balance — show it as an
        // explicit flow instead of letting the node widths lie.
        const settled = data.alreadySettledNet ?? 0;
        const SLATE = '#64748b';
        if (settled > 0.005) {
            // Expenses already paid (net of income already received) were funded by
            // the money already in the account, not by this month's remaining income.
            const settledName = 'Already Paid';
            nodes.push({
                name: settledName,
                itemStyle: { color: SLATE, borderColor: SLATE },
                depth: 0,
            });
            links.push({
                source: settledName,
                target: centerNodeName,
                value: settled,
                lineStyle: { color: SLATE, opacity: 0.3 },
            });
            meta.set(settledName, { items: [], side: 'left' });
        } else if (settled < -0.005) {
            // Income already received (net of expenses already paid) sits in today's
            // balance — it isn't part of the still-ahead savings flow.
            const settledName = 'Already Received';
            nodes.push({
                name: settledName,
                itemStyle: { color: SLATE, borderColor: SLATE },
                depth: 2,
            });
            links.push({
                source: centerNodeName,
                target: settledName,
                value: Math.abs(settled),
                lineStyle: { color: SLATE, opacity: 0.3 },
            });
            meta.set(settledName, { items: [], side: 'right' });
        }

        // Decide which nodes get a text label. Always label the structural nodes
        // (income / budget / categories / cards), but for the depth-3 leaves only
        // label the largest few — otherwise dozens of card purchases pile their
        // labels on top of each other. The rest stay visible as flows (hover for
        // detail). This is the main fix for the overlapping-label clutter.
        const LABEL_LEAF_LIMIT = 12;
        const valueByName = new Map<string, number>();
        for (const l of links) valueByName.set(l.target, (valueByName.get(l.target) ?? 0) + l.value);
        const labeledNodes = new Set(nodes.filter(n => n.depth !== 3).map(n => n.name));
        nodes
            .filter(n => n.depth === 3)
            .map(n => ({ name: n.name, v: valueByName.get(n.name) ?? 0 }))
            .sort((a, b) => b.v - a.v)
            .slice(0, LABEL_LEAF_LIMIT)
            .forEach(d => labeledNodes.add(d.name));

        // Densest column → used to grow the chart height so nodes have room.
        const depthCounts = new Map<number, number>();
        for (const n of nodes) depthCounts.set(n.depth ?? 0, (depthCounts.get(n.depth ?? 0) ?? 0) + 1);
        const maxCol = Math.max(1, ...depthCounts.values());

        // Place each node's label to its side, vertically centered on the node —
        // not above it (the previous 'outside' stacked a node's label on top of
        // the node above). The rightmost column reads to the right (into the
        // right margin); every other column reads to its left, so each column's
        // labels sit in their own horizontal band and never pile up.
        const maxDepth = Math.max(0, ...nodes.map(n => n.depth ?? 0));
        for (const n of nodes) {
            n.label = { position: (n.depth ?? 0) === maxDepth ? 'right' : 'left' };
        }

        return { nodes, links, metaMap: meta, labeledNodes, maxCol };
    }, [data, cardBreakdowns, GREEN, RED, BLUE, AMBER]);

    // Sync metaMap to ref-stable map for event handlers
    useEffect(() => {
        nodeMetaMap.clear();
        metaMap.forEach((v, k) => nodeMetaMap.set(k, v));
    }, [metaMap, nodeMetaMap]);

    const option = useMemo(() => {
        const cleanNodeName = (name: string) => name.replace(/^(Income|Expense|Category|Deduction|Card|CardTx): /, '').replace(/ \([a-f0-9]{4}(-(\d+|more))?\)$/, '');

        return {
            tooltip: {
                trigger: 'item' as const,
                formatter: (params: Record<string, unknown>) => {
                    if (params.dataType === 'node') {
                        const name = params.name as string;
                        const value = params.value as number;
                        const m = metaMap.get(name);
                        let html = `<strong>${cleanNodeName(name)}</strong><br/>${formatCurrency(value, currency)}`;
                        if (m && m.items.length > 1) {
                            html += '<br/><br/>';
                            m.items.slice(0, 8).forEach(item => {
                                html += `${item.name}: ${formatCurrency(item.amount, currency)}<br/>`;
                            });
                            if (m.items.length > 8) {
                                html += `+${m.items.length - 8} more`;
                            }
                        }
                        return html;
                    }
                    if (params.dataType === 'edge') {
                        const d = params.data as { source: string; target: string; value: number };
                        return `${cleanNodeName(d.source)} → ${cleanNodeName(d.target)}<br/>${formatCurrency(d.value, currency)}`;
                    }
                    return '';
                },
            },
            series: [
                {
                    type: 'sankey',
                    layoutIterations: 0,
                    nodeGap: 10,
                    nodeWidth: 16,
                    left: 90,
                    right: 90,
                    top: 40,
                    bottom: 20,
                    data: nodes,
                    links,
                    orient: 'horizontal',
                    draggable: false,
                    // Per-node `position` (set on each data node) decides the side;
                    // this block supplies the shared text/contrast styling. A halo
                    // shadow (light in light theme, dark in dark theme) keeps labels
                    // legible where they cross over the flow ribbons.
                    label: {
                        show: true,
                        formatter: (params: { name: string; value: number }) => {
                            // Only the structural nodes and the largest leaves are
                            // labeled — see labeledNodes. Others render unlabeled
                            // (still visible as flows; hover shows the detail).
                            if (!labeledNodes.has(params.name)) return '';
                            const clean = cleanNodeName(params.name);
                            const truncated = clean.length > 18 ? clean.slice(0, 16) + '…' : clean;
                            return `${truncated}\n${formatCurrency(params.value, currency)}`;
                        },
                        fontSize: 10,
                        color: isDark ? '#e5e7eb' : '#1f2937',
                        textShadowColor: isDark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.9)',
                        textShadowBlur: 3,
                    },
                    emphasis: {
                        focus: 'adjacency',
                        lineStyle: {
                            opacity: 0.6,
                        },
                    },
                    lineStyle: {
                        curveness: 0.5,
                    },
                },
            ],
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
    }, [nodes, links, isDark, metaMap, currency, labeledNodes, demoMasked]);

    // Grow the chart when a column is crowded (e.g. many card purchases) so the
    // nodes and their labels have vertical room instead of being squashed.
    const computedHeight = useMemo(() => {
        const base = parseInt(height, 10) || 350;
        return `${Math.min(900, Math.max(base, maxCol * 20 + 60))}px`;
    }, [height, maxCol]);

    const onEvents = useMemo(() => ({
        click: (params: Record<string, unknown>) => {
            if (!onClickItem) return;
            const name = params.name as string | undefined;
            if (!name) return;
            const m = nodeMetaMap.get(name);
            if (m && m.items.length === 1) {
                onClickItem(m.items[0]);
            }
            // Category nodes with multiple items — no action (they expand to individual items)
        },
    }), [onClickItem, nodeMetaMap]);

    // Explain / plain-words / guided tour
    const explain = useChartExplain();
    const getChart = useCallback(() => chartRef.current?.getEchartsInstance() ?? null, []);

    const description = useMemo(
        () => describeMonthlyFlow(data, (n) => formatCurrency(n, currency)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCurrency output depends on demo mode
        [data, currency, demoMasked]
    );

    const howToRead: ReadCue[] = useMemo(
        () => [
            { shape: 'square', color: GREEN, text: 'Green blocks on the left are money coming in — one per source.' },
            { shape: 'square', color: BLUE, text: 'The blue block in the middle gathers it into your budget for the month.' },
            { shape: 'band', color: '#94a3b8', text: 'Bands flow to the right, where money goes. A thicker band is more money.' },
            { shape: 'updown', color: GREEN, color2: AMBER, text: 'A green band at the end is what you keep; amber means you overspent.' },
        ],
        [GREEN, BLUE, AMBER]
    );

    const tourSteps: ChartTourStep[] = useMemo(() => {
        const namesAtDepth = (d: number) => nodes.filter((n) => (n.depth ?? 0) === d).map((n) => n.name);
        const incomeNames = namesAtDepth(0);
        const destNames = namesAtDepth(2);
        const cardNames = nodes.filter((n) => n.name.startsWith('Card: ')).map((n) => n.name);
        const leftoverNames = nodes.filter((n) => n.name === 'Savings' || n.name === 'Net Savings').map((n) => n.name);
        const hl = (names: string[]) => (chart: EChartsType) => {
            if (names.length) chart.dispatchAction({ type: 'highlight', seriesIndex: 0, name: names });
        };
        const dp = (names: string[]) => (chart: EChartsType) => {
            if (names.length) chart.dispatchAction({ type: 'downplay', seriesIndex: 0, name: names });
        };
        const steps: ChartTourStep[] = [
            { text: 'The left side is money coming in — one block per source.', apply: hl(incomeNames), clear: dp(incomeNames) },
            { text: 'The middle knot gathers it into one pot: your budget.', apply: hl(['Budget']), clear: dp(['Budget']) },
            { text: 'From there, bands fan out to where money goes. Thicker means more.', apply: hl(destNames), clear: dp(destNames) },
        ];
        if (cardNames.length) {
            steps.push({ text: 'An amber "Card" block opens into your card purchases.', apply: hl(cardNames), clear: dp(cardNames) });
        }
        if (leftoverNames.length) {
            steps.push({ text: "This green band is what's left over at the end of the month.", apply: hl(leftoverNames), clear: dp(leftoverNames) });
        } else {
            steps.push({ text: 'When the bands out are wider than money in, you spend more than comes in.', apply: hl(['Budget']), clear: dp(['Budget']) });
        }
        return steps;
    }, [nodes]);

    const tour = useChartTour(tourSteps, getChart);

    return (
        <div className="relative">
            <div className="mb-2 flex items-center justify-end">
                <ChartExplainButton open={explain.open} onClick={explain.toggle} controls={explain.panelId} />
            </div>
            <ChartExplainPanel
                id={explain.panelId}
                open={explain.open}
                chartLabel="Monthly flow"
                howToRead={howToRead}
                description={description}
                onStartTour={tour.start}
                describedById={explain.descId}
            />

            {/* Summary header */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-2 px-1 text-sm">
                <span className="text-green-500 font-semibold">
                    Income: +{formatCurrency(data.totalInflows, currency)}
                </span>
                <span className={`font-semibold ${data.netChange >= 0 ? 'text-green-600' : 'text-amber-500'}`}>
                    Net: {data.netChange >= 0 ? '+' : ''}{formatCurrency(data.netChange, currency)}
                </span>
                <span className="text-red-500 font-semibold">
                    Expenses: −{formatCurrency(data.totalOutflows, currency)}
                </span>
            </div>

            <ReactEChartsCore
                key={demoMasked ? 'masked' : 'plain'}
                ref={chartRef}
                echarts={echarts}
                option={option}
                style={{ height: computedHeight, width: '100%' }}
                notMerge
                onEvents={onEvents}
                theme={isDark ? 'dark' : undefined}
                opts={{ renderer: 'canvas' }}
                aria-describedby={explain.descId}
            />

            {tour.active && <ChartTourBar tour={tour} label="Monthly flow" />}

            {/* Balance footer */}
            <div className={`flex items-center justify-between px-1 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                <span>Start: {formatCurrency(data.startingBalance, currency)}</span>
                <span>End: {formatCurrency(data.endingBalance, currency)}</span>
            </div>
        </div>
    );
}
