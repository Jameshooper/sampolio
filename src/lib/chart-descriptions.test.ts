import { describe, it, expect } from 'vitest';
import {
    shareToWords,
    describeMonthlyFlow,
    describeExpenseBreakdown,
    describeWaterfall,
    describeWealth,
    describeScenario,
    describeSplitSpend,
    describeSplitNet,
    describeGroupPeriod,
    describeBudgetMonths,
    describeMortgageBalance,
    describeOwnershipProgress,
    describePrincipalInterest,
    describeCumulativeCost,
    describeRateHistory,
    describePaymentBreakdown,
    describeEquityBuildup,
    describeMortgageSankey,
    describeTransferComparison,
    type WaterfallMonthLike,
} from './chart-descriptions';
import type { MonthFlowData, CashflowItem, ProjectionLineItem } from '@/types';
import type { GroupPeriodInsights, SplitInsights } from '@/lib/split-insights';

// Trivial money formatter — deterministic and locale-free so assertions can
// match exact substrings without depending on Intl output.
const fmt = (n: number) => `€${Math.round(n)}`;

function inflow(name: string, amount: number, source: CashflowItem['source'] = 'recurring'): CashflowItem {
    return { id: name, name, amount, type: 'income', source, isRecurring: false };
}
function outflow(name: string, amount: number, category?: string, source: CashflowItem['source'] = 'recurring'): CashflowItem {
    return { id: name, name, amount, category, type: 'expense', source, isRecurring: false };
}
function flow(partial: Partial<MonthFlowData>): MonthFlowData {
    return {
        yearMonth: '2026-07',
        accountId: 'acc',
        startingBalance: 0,
        endingBalance: 0,
        inflows: [],
        outflows: [],
        totalInflows: 0,
        totalOutflows: 0,
        netChange: 0,
        isReconciled: false,
        ...partial,
    };
}
function expense(name: string, amount: number, category?: string): ProjectionLineItem {
    return { itemId: name, name, amount, category, source: 'recurring' };
}

describe('shareToWords', () => {
    it('returns "almost all" above 85%', () => {
        expect(shareToWords(90, 100)).toBe('almost all');
        expect(shareToWords(86, 100)).toBe('almost all');
    });
    it('returns "about half" in (45%, 85%]', () => {
        expect(shareToWords(50, 100)).toBe('about half');
        expect(shareToWords(85, 100)).toBe('about half'); // exactly 85 is NOT > 85
        expect(shareToWords(46, 100)).toBe('about half');
        expect(shareToWords(80, 100)).toBe('about half');
    });
    it('returns "about a third" in (30%, 45%]', () => {
        expect(shareToWords(35, 100)).toBe('about a third');
        expect(shareToWords(45, 100)).toBe('about a third'); // exactly 45 is NOT > 45
        expect(shareToWords(31, 100)).toBe('about a third');
    });
    it('returns "about a quarter" in (20%, 30%]', () => {
        expect(shareToWords(25, 100)).toBe('about a quarter');
        expect(shareToWords(30, 100)).toBe('about a quarter'); // exactly 30 is NOT > 30
        expect(shareToWords(21, 100)).toBe('about a quarter');
    });
    it('returns "a small part" in (8%, 20%]', () => {
        expect(shareToWords(10, 100)).toBe('a small part');
        expect(shareToWords(20, 100)).toBe('a small part'); // exactly 20 is NOT > 20
        expect(shareToWords(9, 100)).toBe('a small part');
    });
    it('returns "a tiny part" at or below 8%', () => {
        expect(shareToWords(8, 100)).toBe('a tiny part'); // exactly 8 is NOT > 8
        expect(shareToWords(1, 100)).toBe('a tiny part');
        expect(shareToWords(0, 100)).toBe('a tiny part');
    });
    it('guards against a zero or invalid whole', () => {
        expect(shareToWords(10, 0)).toBe('a tiny part');
        expect(shareToWords(10, -5)).toBe('a tiny part');
    });
});

describe('describeMonthlyFlow', () => {
    it('summarises money in, top source, money out, costs and leftover', () => {
        const data = flow({
            inflows: [inflow('Salary', 3000), inflow('Side gig', 1000)],
            outflows: [outflow('Rent', 1200, 'Housing'), outflow('Food', 600, 'Food & Groceries')],
            totalInflows: 4000,
            totalOutflows: 1800,
            netChange: 2200,
        });
        const out = describeMonthlyFlow(data, fmt);
        const text = out.join(' ');
        expect(text).toContain('€4000'); // money in
        expect(text).toContain('Salary is the biggest source'); // top source
        expect(text).toContain('€1800'); // money out total
        expect(text).toContain('Housing'); // biggest cost category
        expect(text).toContain('you keep €2200'); // leftover
    });

    it('classifies the top source share correctly', () => {
        const data = flow({
            inflows: [inflow('Salary', 3000), inflow('Side gig', 1000)],
            outflows: [outflow('Rent', 1200, 'Housing')],
            totalInflows: 4000,
            totalOutflows: 1200,
            netChange: 2800,
        });
        const text = describeMonthlyFlow(data, fmt).join(' ');
        expect(text).toContain('about half of it'); // 3000/4000 = 75% -> about half
        expect(text).toContain('you keep €2800');
    });

    it('notes gross pay when a salary source is present', () => {
        const data = flow({
            inflows: [inflow('Gross Salary: Employer', 5000, 'salary')],
            outflows: [outflow('Tax (25%)', 1250, 'Taxes', 'salary')],
            totalInflows: 5000,
            totalOutflows: 1250,
            netChange: 3750,
        });
        const text = describeMonthlyFlow(data, fmt).join(' ');
        expect(text).toContain('before tax');
        // The chart-internal "Gross Salary:" prefix is stripped for readability.
        expect(text).toContain('It all comes from Employer');
    });

    it('reports a deficit when spending exceeds income', () => {
        const data = flow({
            inflows: [inflow('Salary', 2000)],
            outflows: [outflow('Rent', 2500, 'Housing')],
            totalInflows: 2000,
            totalOutflows: 2500,
            netChange: -500,
        });
        const text = describeMonthlyFlow(data, fmt).join(' ');
        expect(text).toContain('spend €500 more than comes in');
    });

    it('mentions the card block when a credit-card outflow exists', () => {
        const data = flow({
            inflows: [inflow('Salary', 2000)],
            outflows: [outflow('Card bill', 400, 'Shopping', 'credit-card')],
            totalInflows: 2000,
            totalOutflows: 400,
            netChange: 1600,
        });
        const text = describeMonthlyFlow(data, fmt).join(' ');
        expect(text).toContain('Card');
        expect(text.toLowerCase()).toContain('card purchases');
    });

    it('handles an empty month gracefully', () => {
        const out = describeMonthlyFlow(flow({}), fmt);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('no money in or out');
    });
});

describe('describeExpenseBreakdown', () => {
    it('summarises total, dominant category and biggest item', () => {
        const expenses = [
            expense('Rent', 1200, 'Housing'),
            expense('Groceries', 400, 'Food & Groceries'),
            expense('Bus pass', 80, 'Transportation'),
        ];
        const out = describeExpenseBreakdown(expenses, fmt);
        const text = out.join(' ');
        expect(text).toContain('€1680'); // total
        expect(text).toContain('Housing is the biggest slice'); // 1200/1680 = 71% -> about half
        expect(text).toContain('about half of it');
        expect(text).toContain('Rent at €1200'); // biggest single item
    });

    it('collapses to one category when it dominates', () => {
        const out = describeExpenseBreakdown([expense('Rent', 1000, 'Housing')], fmt);
        expect(out.join(' ')).toContain("almost all Housing");
    });

    it('handles no expenses', () => {
        const out = describeExpenseBreakdown([], fmt);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('no expenses');
    });
});

describe('describeWaterfall', () => {
    const months: WaterfallMonthLike[] = [
        { month: '2026-04', netChange: 300, endingBalance: 5300, isActual: true },
        { month: '2026-05', netChange: -200, endingBalance: 5100, isActual: true },
        { month: '2026-06', netChange: 500, endingBalance: 5600, isActual: true },
        { month: '2026-07', netChange: 100, endingBalance: 5700 },
        { month: '2026-08', netChange: 800, endingBalance: 6500 },
        { month: '2026-12', netChange: -50, endingBalance: 9000 },
    ];

    it('counts up/down past months, best/worst and the ending balance', () => {
        const out = describeWaterfall(months, '2026-07', fmt);
        const text = out.join(' ');
        expect(text).toContain('last 3 months'); // three isActual months
        expect(text).toContain('2 ended up and 1 ended down'); // +300, +500 up; -200 down
        expect(text).toContain('best month is August 2026'); // +800 is the max
        expect(text).toContain('down €200'); // worst netChange is -200 (May)
        expect(text).toContain('December 2026'); // last month heading
        expect(text).toContain('€9000');
    });

    it('notes a forecast when there is no bank history', () => {
        const forecast: WaterfallMonthLike[] = [
            { month: '2026-07', netChange: 100, endingBalance: 5700 },
            { month: '2026-08', netChange: 200, endingBalance: 5900 },
        ];
        const text = describeWaterfall(forecast, '2026-07', fmt).join(' ');
        expect(text).toContain('forecast');
        expect(text).toContain('no real bank history');
    });

    it('handles an empty projection', () => {
        expect(describeWaterfall([], '2026-07', fmt)[0]).toContain('no projection');
    });
});

describe('describeWealth', () => {
    it('summarises current worth, its makeup and where it heads', () => {
        const points = [
            { month: '2026-07', netWorth: 100000 },
            { month: '2031-07', netWorth: 150000 },
        ];
        const components = [
            { label: 'Cash', value: 40000, kind: 'asset' as const },
            { label: 'Investments', value: 80000, kind: 'asset' as const },
            { label: 'Mortgage', value: 20000, kind: 'liability' as const },
        ];
        const text = describeWealth(points, components, 'net worth', fmt).join(' ');
        expect(text).toContain('net worth is about €100000');
        expect(text).toContain('Investments'); // largest asset listed first
        expect(text).toContain('you owe');
        expect(text).toContain('grows to about €150000');
    });

    it('notes a decline when the end is lower', () => {
        const text = describeWealth(
            [{ month: '2026-07', netWorth: 50000 }, { month: '2027-07', netWorth: 30000 }],
            [],
            'spendable money',
            fmt
        ).join(' ');
        expect(text).toContain('drops to about €30000');
    });

    it('handles no data', () => {
        expect(describeWealth([], [], 'net worth', fmt)[0]).toContain('nothing to show');
    });
});

describe('describeScenario', () => {
    const cur = [
        { yearMonth: '2026-07', endingBalance: 1000 },
        { yearMonth: '2026-08', endingBalance: 1200 },
    ];
    it('reports a better-off difference and staying above zero', () => {
        const mod = [
            { yearMonth: '2026-07', endingBalance: 1000 },
            { yearMonth: '2026-08', endingBalance: 1500 },
        ];
        const text = describeScenario(cur, mod, fmt).join(' ');
        expect(text).toContain('better off');
        expect(text).toContain('€300'); // 1500 - 1200
        expect(text).toContain('above zero');
    });
    it('warns when the modified run dips below zero', () => {
        const mod = [
            { yearMonth: '2026-07', endingBalance: 1000 },
            { yearMonth: '2026-08', endingBalance: -500 },
        ];
        const text = describeScenario(cur, mod, fmt).join(' ');
        expect(text).toContain('worse off');
        expect(text).toContain('drops below zero in August 2026');
    });
    it('handles no changes', () => {
        expect(describeScenario([], [], fmt)[0]).toContain('Add a change');
    });
});

function insights(partial: Partial<SplitInsights>): SplitInsights {
    return {
        months: [],
        groups: [],
        members: [],
        currencies: ['EUR'],
        spendByGroup: {},
        paidByMember: {},
        spendByCategory: {},
        categories: [],
        viewerNetByMonth: {},
        viewerNetBaseline: 0,
        ...partial,
    };
}

describe('describeSplitSpend', () => {
    it('totals shared spend and names the biggest group', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [
                { id: 'g1', name: 'Flat', currency: 'EUR' },
                { id: 'g2', name: 'Trip', currency: 'EUR' },
            ],
            spendByGroup: {
                '2026-06': { g1: 8000, g2: 1000 },
                '2026-07': { g1: 8000, g2: 1000 },
            },
        });
        const text = describeSplitSpend(ins, 'group', fmt).join(' ');
        expect(text).toContain('€18000'); // grand total in cents via stub
        expect(text).toContain('Flat'); // biggest group
    });
    it('names the biggest payer in member mode', () => {
        const ins = insights({
            months: ['2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            members: [
                { userId: 'u1', name: 'Ana' },
                { userId: 'u2', name: 'Bob' },
            ],
            spendByGroup: { '2026-07': { g1: 1000 } },
            paidByMember: { '2026-07': { u1: 900, u2: 100 } },
        });
        const text = describeSplitSpend(ins, 'member', fmt).join(' ');
        expect(text).toContain('Ana fronts the most');
    });
    it('names the biggest category in category mode', () => {
        const ins = insights({
            months: ['2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: { '2026-07': { g1: 10000 } },
            spendByCategory: { '2026-07': { Rent: 9000, Groceries: 1000 } },
            categories: ['Rent', 'Groceries'],
        });
        const text = describeSplitSpend(ins, 'category', fmt).join(' ');
        expect(text).toContain('€10000');
        expect(text).toContain('Rent is the biggest category');
        expect(text).toContain('almost all');
    });
    it('handles no spending', () => {
        expect(describeSplitSpend(insights({ months: ['2026-07'] }), 'group', fmt)[0]).toContain('no shared spending');
    });

    // --- current-month sentences ------------------------------------------
    // `months` always ends at the current calendar month, so the last entry is
    // "this month" — the function never reads the clock.

    it('reports what this month has shared so far', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: { '2026-06': { g1: 8000 }, '2026-07': { g1: 3000 } },
        });
        expect(describeSplitSpend(ins, 'group', fmt).join(' ')).toContain('This month so far: €3000.');
    });

    it('says when nothing has been shared yet this month', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: { '2026-06': { g1: 8000 }, '2026-07': {} },
        });
        const text = describeSplitSpend(ins, 'group', fmt).join(' ');
        expect(text).toContain('No shared expenses yet this month.');
        expect(text).not.toContain('This month so far');
    });

    it('compares this month with a typical month (above)', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: {
                '2026-05': { g1: 1000 },
                '2026-06': { g1: 3000 },
                '2026-07': { g1: 5000 },
            },
        });
        // prior months average (1000 + 3000) / 2 = 2000, and 5000 beats it
        expect(describeSplitSpend(ins, 'group', fmt).join(' ')).toContain(
            "That's already more than your typical month of €2000."
        );
    });

    it('compares this month with a typical month (below)', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: {
                '2026-05': { g1: 4000 },
                '2026-06': { g1: 6000 },
                '2026-07': { g1: 1000 },
            },
        });
        expect(describeSplitSpend(ins, 'group', fmt).join(' ')).toContain(
            'Your typical month is about €5000.'
        );
    });

    it('skips the typical-month sentence with only one prior month of spending', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            // May had nothing, so only June counts as a prior month
            spendByGroup: { '2026-05': {}, '2026-06': { g1: 6000 }, '2026-07': { g1: 1000 } },
        });
        const text = describeSplitSpend(ins, 'group', fmt).join(' ');
        expect(text).not.toContain('typical month');
    });

    it('flags a different group leading this month', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [
                { id: 'g1', name: 'Flat', currency: 'EUR' },
                { id: 'g2', name: 'Trip', currency: 'EUR' },
            ],
            spendByGroup: {
                '2026-06': { g1: 9000, g2: 500 },
                '2026-07': { g1: 200, g2: 3000 },
            },
        });
        const text = describeSplitSpend(ins, 'group', fmt).join(' ');
        expect(text).toContain('This month, "Trip" leads instead.');
    });

    it('flags a different payer leading this month', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            members: [
                { userId: 'u1', name: 'Ana' },
                { userId: 'u2', name: 'Bob' },
            ],
            spendByGroup: { '2026-06': { g1: 9000 }, '2026-07': { g1: 2000 } },
            paidByMember: { '2026-06': { u1: 9000 }, '2026-07': { u2: 2000 } },
        });
        const text = describeSplitSpend(ins, 'member', fmt).join(' ');
        expect(text).toContain('Ana fronts the most');
        expect(text).toContain('This month, Bob leads instead.');
    });

    it('flags a different category leading this month', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [{ id: 'g1', name: 'Flat', currency: 'EUR' }],
            spendByGroup: { '2026-06': { g1: 9000 }, '2026-07': { g1: 2000 } },
            spendByCategory: { '2026-06': { Rent: 9000 }, '2026-07': { Groceries: 2000 } },
            categories: ['Rent', 'Groceries'],
        });
        expect(describeSplitSpend(ins, 'category', fmt).join(' ')).toContain(
            'This month, Groceries leads instead.'
        );
    });

    it('omits the leader-shift sentence when the same group still leads', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            groups: [
                { id: 'g1', name: 'Flat', currency: 'EUR' },
                { id: 'g2', name: 'Trip', currency: 'EUR' },
            ],
            spendByGroup: {
                '2026-06': { g1: 9000, g2: 500 },
                '2026-07': { g1: 3000, g2: 200 },
            },
        });
        expect(describeSplitSpend(ins, 'group', fmt).join(' ')).not.toContain('leads instead');
    });

    it('keeps the mixed-currency caveat as the final sentence', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            currencies: ['EUR', 'USD'],
            groups: [
                { id: 'g1', name: 'Flat', currency: 'EUR' },
                { id: 'g2', name: 'Trip', currency: 'USD' },
            ],
            spendByGroup: {
                '2026-05': { g1: 4000 },
                '2026-06': { g1: 6000 },
                '2026-07': { g2: 9000 },
            },
        });
        const out = describeSplitSpend(ins, 'group', fmt);
        expect(out[out.length - 1]).toBe('Amounts mix more than one currency, so totals are rough.');
        // …and the new sentences really did land before it
        expect(out.join(' ')).toContain('This month so far');
        expect(out.join(' ')).toContain('leads instead');
    });
});

describe('describeSplitNet', () => {
    it('reports being owed and the overall lean', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            viewerNetByMonth: { '2026-05': 5000, '2026-06': 3000, '2026-07': 4000 },
        });
        const text = describeSplitNet(ins, fmt).join(' ');
        expect(text).toContain("you're owed €4000");
        expect(text).toContain('mostly been owed');
    });
    it('reports owing money', () => {
        const ins = insights({ months: ['2026-07'], viewerNetByMonth: { '2026-07': -2500 } });
        const text = describeSplitNet(ins, fmt).join(' ');
        expect(text).toContain('you owe €2500');
    });
    it('names the month that moved the balance most', () => {
        const ins = insights({
            months: ['2026-05', '2026-06', '2026-07'],
            viewerNetByMonth: { '2026-05': 1000, '2026-06': 5000, '2026-07': 4500 },
            viewerNetBaseline: 500,
        });
        const text = describeSplitNet(ins, fmt).join(' ');
        // deltas: +500, +4000, −500 ⇒ June is the biggest move
        expect(text).toContain('June 2026 moved it most, up €4000');
    });
    it('measures the first month against the pre-window baseline', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            viewerNetByMonth: { '2026-06': 9000, '2026-07': 9100 },
            viewerNetBaseline: 8000,
        });
        const text = describeSplitNet(ins, fmt).join(' ');
        // delta[0] is 1000 (not 9000), so June still wins but only by 1000
        expect(text).toContain('June 2026 moved it most, up €1000');
    });
    it('omits the biggest-move sentence when nothing moved', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            viewerNetByMonth: { '2026-06': 0, '2026-07': 0 },
        });
        expect(describeSplitNet(ins, fmt).join(' ')).not.toContain('moved it most');
    });

    it('reports how far this month has moved the balance up', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            viewerNetByMonth: { '2026-06': 1000, '2026-07': 2500 },
            viewerNetBaseline: 500,
        });
        expect(describeSplitNet(ins, fmt).join(' ')).toContain('This month it moved up €1500 so far.');
    });

    it('reports how far this month has moved the balance down', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            viewerNetByMonth: { '2026-06': 4000, '2026-07': 1000 },
        });
        expect(describeSplitNet(ins, fmt).join(' ')).toContain('This month it moved down €3000 so far.');
    });

    it('measures a single-month window against the pre-window baseline', () => {
        const ins = insights({
            months: ['2026-07'],
            viewerNetByMonth: { '2026-07': 9000 },
            viewerNetBaseline: 8000,
        });
        // 1000, not the whole 9000 position
        expect(describeSplitNet(ins, fmt).join(' ')).toContain('This month it moved up €1000 so far.');
    });

    it('omits the this-month sentence when the balance barely moved', () => {
        const ins = insights({
            months: ['2026-06', '2026-07'],
            viewerNetByMonth: { '2026-06': 4000, '2026-07': 4000 },
        });
        expect(describeSplitNet(ins, fmt).join(' ')).not.toContain('This month it moved');
    });
});

describe('describeGroupPeriod', () => {
    const period = (partial: Partial<GroupPeriodInsights>): GroupPeriodInsights => ({
        totalSpendCents: 0,
        expenseCount: 0,
        settledCents: 0,
        paidByMember: [],
        topCategories: [],
        topExpenses: [],
        hasImportedRows: false,
        ...partial,
    });

    it('reports the empty period first', () => {
        expect(describeGroupPeriod(period({}), 2, fmt)).toEqual(['No shared expenses in this period.']);
    });

    it('covers total, top payer, top category and biggest expense', () => {
        const text = describeGroupPeriod(
            period({
                totalSpendCents: 12000,
                expenseCount: 4,
                paidByMember: [
                    { userId: 'u1', name: 'Ana', cents: 9000, pct: 0.75 },
                    { userId: 'u2', name: 'Bob', cents: 3000, pct: 0.25 },
                ],
                topCategories: [
                    { category: 'Groceries', cents: 7000, count: 2 },
                    { category: 'Taxi', cents: 5000, count: 2 },
                ],
                topExpenses: [{ id: 'e1', title: 'Big shop', category: 'Groceries', cents: 5000, date: '2026-07-04' }],
            }),
            2,
            fmt
        );
        expect(text).toHaveLength(4);
        const joined = text.join(' ');
        expect(joined).toContain('€12000 across 4 expenses');
        expect(joined).toContain('Ana fronted the most');
        expect(joined).toContain('Groceries is the biggest category, at €7000');
        expect(joined).toContain('biggest expense is Big shop at €5000');
    });

    it('skips the payer sentence in a one-member group', () => {
        const text = describeGroupPeriod(
            period({
                totalSpendCents: 2000,
                expenseCount: 1,
                paidByMember: [{ userId: 'u1', name: 'Ana', cents: 2000, pct: 1 }],
                topCategories: [{ category: 'Taxi', cents: 2000, count: 1 }],
                topExpenses: [{ id: 'e1', title: 'Ride', category: 'Taxi', cents: 2000, date: '2026-07-04' }],
            }),
            1,
            fmt
        ).join(' ');
        expect(text).toContain('one expense of €2000');
        expect(text).not.toContain('fronted');
        expect(text).toContain('It is all Taxi.');
    });
});

describe('describeBudgetMonths', () => {
    it('totals costs and funding and flags a shortfall', () => {
        const perMonth = [
            { yearMonth: '2026-07', plannedCosts: 500, fundingReceived: 300, cumulativeNet: -200 },
            { yearMonth: '2026-08', plannedCosts: 100, fundingReceived: 0, cumulativeNet: -300 },
        ];
        const text = describeBudgetMonths(perMonth, fmt).join(' ');
        expect(text).toContain('costs add up to €600');
        expect(text).toContain('€300 short');
        expect(text).toContain('July 2026'); // most expensive month
    });
    it('reports spare funding', () => {
        const text = describeBudgetMonths(
            [{ yearMonth: '2026-07', plannedCosts: 100, fundingReceived: 300, cumulativeNet: 200 }],
            fmt
        ).join(' ');
        expect(text).toContain('€200 to spare');
    });
});

describe('mortgage descriptions', () => {
    it('describeMortgageBalance covers now, direction and payoff', () => {
        const text = describeMortgageBalance(200000, 0, '2045-01', fmt).join(' ');
        expect(text).toContain('still owe about €200000');
        expect(text).toContain('fully paid off');
    });
    it('describeOwnershipProgress reads current vs target', () => {
        const text = describeOwnershipProgress([{ name: 'Ana', currentPercent: 40, targetPercent: 50 }]).join(' ');
        expect(text).toContain('Ana owns 40% now, heading toward 50%');
    });
    it('describePrincipalInterest explains the split', () => {
        const text = describePrincipalInterest(10000, 3000, fmt).join(' ');
        expect(text).toContain('splits in two');
        expect(text).toContain('€10000');
        expect(text).toContain('€3000');
    });
    it('describeCumulativeCost reports paid-to-date', () => {
        const text = describeCumulativeCost(50000, 12000, fmt).join(' ');
        expect(text).toContain('€50000');
        expect(text).toContain('€12000');
    });
    it('describeRateHistory reports current and range', () => {
        const text = describeRateHistory(3.5, 1.2, 4.1).join(' ');
        expect(text).toContain('3.50% right now');
        expect(text).toContain('1.20%');
        expect(text).toContain('4.10%');
    });
    it('describePaymentBreakdown names the biggest slice', () => {
        const text = describePaymentBreakdown(
            [{ label: 'Principal', value: 700 }, { label: 'Interest', value: 300 }],
            fmt
        ).join(' ');
        expect(text).toContain("payment is €1000");
        expect(text).toContain('Principal');
        expect(text).toContain("bank's fee");
    });
    it('describeEquityBuildup lists member equity', () => {
        const text = describeEquityBuildup([{ name: 'Ana', equity: 40000 }], fmt).join(' ');
        expect(text).toContain('Ana has about €40000');
    });
    it('describeMortgageSankey splits paid-in money', () => {
        const text = describeMortgageSankey(
            { totalPaidIn: 60000, interestPaid: 15000, amortizationPaid: 45000, amortizationLeft: 155000 },
            fmt
        ).join(' ');
        expect(text).toContain('€60000 has been paid');
        expect(text).toContain('€155000 of the loan is still left');
    });
    it('describeTransferComparison reports savings and break-even', () => {
        const text = describeTransferComparison(300000, 280000, 24, fmt).join(' ');
        expect(text).toContain('save you €20000');
        expect(text).toContain('24 months');
    });
    it('describeTransferComparison reports never breaking even', () => {
        const text = describeTransferComparison(280000, 300000, null, fmt).join(' ');
        expect(text).toContain('cost you €20000 more');
        expect(text).toContain('never quite pays back');
    });
});
