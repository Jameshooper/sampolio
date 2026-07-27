/**
 * Pure natural-language description engine for the cashflow charts.
 *
 * Each `describe*` function takes the SAME data its chart receives and returns
 * an array of short, plain-English sentences (≤ ~15 words each) meant to be
 * read aloud to someone who doesn't "see" charts. No React, no side effects.
 *
 * Money is formatted through an injected `MoneyFn` rather than imported
 * directly, so the caller can pass `(n) => formatCurrency(n, currency)` — which
 * is demo-mask aware at call time — and unit tests can pass a trivial stub.
 * Month names use the pure `formatYearMonth` (locale-only, never masked).
 *
 * The input shapes are kept minimal/structural so a later pass can reuse these
 * helpers for other pages' charts.
 */

import { formatYearMonth } from '@/lib/constants';
import type { MonthFlowData, ProjectionLineItem } from '@/types';
import type { SplitInsights } from '@/lib/split-insights';

/** Formats a money amount to a display string (demo-mask aware at call time). */
export type MoneyFn = (amount: number) => string;

/**
 * Turn a part-of-whole ratio into a rough spoken share. Thresholds are checked
 * top-down with a strict `>` so the buckets are exhaustive and deterministic;
 * exported for direct unit testing.
 */
export function shareToWords(part: number, whole: number): string {
    if (!(whole > 0) || !Number.isFinite(part / whole)) return 'a tiny part';
    const r = part / whole;
    if (r > 0.85) return 'almost all';
    if (r > 0.45) return 'about half';
    if (r > 0.3) return 'about a third';
    if (r > 0.2) return 'about a quarter';
    if (r > 0.08) return 'a small part';
    return 'a tiny part';
}

/** Strip the chart-internal "Kind: " prefixes so names read naturally. */
function cleanName(name: string): string {
    return name
        .replace(/^(Gross Salary|Gross|Income|Expense|Category|Deduction|Card|CardTx):\s*/i, '')
        .trim();
}

/** Sum a list of {amount} rows. */
function sum(items: { amount: number }[]): number {
    return items.reduce((s, i) => s + i.amount, 0);
}

/** Group rows by their category label, returning totals sorted high → low. */
function topCategories(
    items: { amount: number; category?: string }[],
    fallback = 'Other'
): { category: string; total: number }[] {
    const map = new Map<string, number>();
    for (const i of items) {
        const key = i.category || fallback;
        map.set(key, (map.get(key) ?? 0) + i.amount);
    }
    return Array.from(map.entries())
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total);
}

/** Join up to three category names as a plain-English list. */
function listCategories(cats: { category: string; total: number }[], fmt: MoneyFn): string {
    const parts = cats.map((c) => `${c.category} (${fmt(c.total)})`);
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Monthly Flow (Sankey): where money comes from, where it goes, what's left.
 * `data.totalInflows` / `totalOutflows` are the GROSS figures the Sankey draws
 * (pay before tax, with tax as an outflow), while `netChange` is the real
 * take-home leftover — the sentences say so instead of pretending they match.
 */
export function describeMonthlyFlow(data: MonthFlowData, fmt: MoneyFn): string[] {
    const totalIn = data.totalInflows;
    const totalOut = data.totalOutflows;

    if (totalIn <= 0 && totalOut <= 0) {
        return ['There is no money in or out for this month yet.'];
    }

    const sentences: string[] = [];
    const inflows = [...data.inflows].sort((a, b) => b.amount - a.amount);
    const showsGross = data.inflows.some((i) => i.source === 'salary' || i.source === 'taxed-income');

    // Money in + biggest source.
    if (totalIn > 0) {
        sentences.push(
            showsGross
                ? `Money coming in is ${fmt(totalIn)}, counting your pay before tax.`
                : `Money coming in adds up to ${fmt(totalIn)}.`
        );
        const top = inflows[0];
        if (top) {
            sentences.push(
                inflows.length > 1
                    ? `${cleanName(top.name)} is the biggest source — ${shareToWords(top.amount, totalIn)} of it.`
                    : `It all comes from ${cleanName(top.name)}.`
            );
        }
    }

    // Money out + biggest destinations (grouped by category, like the chart's
    // right-hand side).
    if (totalOut > 0) {
        const cats = topCategories(data.outflows);
        sentences.push(`Money going out adds up to ${fmt(totalOut)}.`);
        if (cats.length > 0) {
            sentences.push(`The biggest costs are ${listCategories(cats.slice(0, 3), fmt)}.`);
        }
    }

    // What's left (real take-home net).
    const net = data.netChange;
    if (net > 0.005) {
        sentences.push(`After everything, you keep ${fmt(net)}.`);
    } else if (net < -0.005) {
        sentences.push(`You spend ${fmt(Math.abs(net))} more than comes in.`);
    } else {
        sentences.push('Money in and money out come out about even.');
    }

    // Card block hint.
    if (data.outflows.some((o) => o.source === 'credit-card')) {
        sentences.push('The amber "Card" block bundles your card purchases together.');
    }

    return sentences;
}

/**
 * Expenses Breakdown (Treemap): total spend, the dominant category in rough
 * words, and the single largest item.
 */
export function describeExpenseBreakdown(expenses: ProjectionLineItem[], fmt: MoneyFn): string[] {
    if (expenses.length === 0) {
        return ['There are no expenses to show this month.'];
    }

    const total = sum(expenses);
    const sentences: string[] = [`Your spending this month is ${fmt(total)}.`];

    const cats = topCategories(expenses, 'Uncategorized');
    const top = cats[0];
    if (top && cats.length > 1) {
        sentences.push(`${top.category} is the biggest slice — ${shareToWords(top.total, total)} of it.`);
    } else if (top) {
        sentences.push(`It's almost all ${top.category}.`);
    }

    const biggestItem = [...expenses].sort((a, b) => b.amount - a.amount)[0];
    if (biggestItem) {
        sentences.push(`Your single biggest expense is ${cleanName(biggestItem.name)} at ${fmt(biggestItem.amount)}.`);
    }

    return sentences;
}

/** Minimal month shape the waterfall description needs (structural, reusable). */
export interface WaterfallMonthLike {
    /** "YYYY-MM". */
    month: string;
    netChange: number;
    endingBalance: number;
    /** True for real bank-reconstructed past months. */
    isActual?: boolean;
}

/**
 * Cashflow Projection (Waterfall): how past months landed, the best/tightest
 * month, and where the balance is heading by the end of the visible range.
 */
export function describeWaterfall(
    months: WaterfallMonthLike[],
    nowMonth: string,
    fmt: MoneyFn
): string[] {
    if (months.length === 0) {
        return ['There is no projection to describe yet.'];
    }

    const sentences: string[] = [];
    const past = months.filter((m) => m.isActual);

    // How past months landed (or a forecast note when there's no bank history).
    if (past.length > 0) {
        const up = past.filter((m) => m.netChange > 0).length;
        const down = past.filter((m) => m.netChange < 0).length;
        sentences.push(`Of your last ${past.length} months, ${up} ended up and ${down} ended down.`);
    } else {
        sentences.push('These months are a forecast — no real bank history is loaded yet.');
    }

    // Best and tightest month across the whole visible range.
    if (months.length >= 2) {
        const best = months.reduce((a, b) => (b.netChange > a.netChange ? b : a));
        const worst = months.reduce((a, b) => (b.netChange < a.netChange ? b : a));
        if (best.month !== worst.month) {
            sentences.push(`Your best month is ${formatYearMonth(best.month)}, up ${fmt(Math.abs(best.netChange))}.`);
            sentences.push(
                worst.netChange < 0
                    ? `The tightest is ${formatYearMonth(worst.month)}, down ${fmt(Math.abs(worst.netChange))}.`
                    : `The smallest gain is ${formatYearMonth(worst.month)}, up ${fmt(Math.abs(worst.netChange))}.`
            );
        }
    }

    // Where the balance is heading by the end of the range.
    const last = months[months.length - 1];
    sentences.push(`By ${formatYearMonth(last.month)}, your balance is around ${fmt(last.endingBalance)}.`);

    // Keep nowMonth meaningful for callers/future reuse even when unused above.
    void nowMonth;

    return sentences;
}

// ---------------------------------------------------------------------------
// Wealth / Net worth (Overview)
// ---------------------------------------------------------------------------

/** A month's already-scoped net worth (the number the line plots). */
export interface WealthNetPoint {
    /** "YYYY-MM". */
    month: string;
    netWorth: number;
}

/** One asset or liability slice at the latest month (magnitude, not signed). */
export interface WealthComponentLike {
    label: string;
    /** Positive magnitude. */
    value: number;
    kind: 'asset' | 'liability';
}

/**
 * Wealth / Net worth chart: what you're worth now, what it's made of, and where
 * it heads by the end of the visible range. `scopeLabel` is the everyday name of
 * the number being described ("net worth" vs "spendable money"), so the same
 * function serves both the stacked WealthChart and the plain NetWorthChart.
 */
export function describeWealth(
    points: WealthNetPoint[],
    components: WealthComponentLike[],
    scopeLabel: string,
    fmt: MoneyFn
): string[] {
    if (points.length === 0) {
        return ['There is nothing to show here yet.'];
    }

    const now = points[0];
    const end = points[points.length - 1];
    const sentences: string[] = [`Right now your ${scopeLabel} is about ${fmt(now.netWorth)}.`];

    const assets = components
        .filter((c) => c.kind === 'asset' && c.value > 0.005)
        .sort((a, b) => b.value - a.value);
    const debts = components
        .filter((c) => c.kind === 'liability' && c.value > 0.005)
        .sort((a, b) => b.value - a.value);

    if (assets.length > 0) {
        const top = assets.slice(0, 2).map((a) => ({ category: a.label, total: a.value }));
        sentences.push(`Most of what you own is ${listCategories(top, fmt)}.`);
    }
    if (debts.length > 0) {
        const top = debts.slice(0, 2).map((d) => ({ category: d.label, total: d.value }));
        sentences.push(`Against that, you owe ${listCategories(top, fmt)}.`);
    }

    if (points.length >= 2) {
        const diff = end.netWorth - now.netWorth;
        if (diff > 0.005) {
            sentences.push(`By ${formatYearMonth(end.month)} it grows to about ${fmt(end.netWorth)}.`);
        } else if (diff < -0.005) {
            sentences.push(`By ${formatYearMonth(end.month)} it drops to about ${fmt(end.netWorth)}.`);
        } else {
            sentences.push(`By ${formatYearMonth(end.month)} it stays about the same.`);
        }
    }

    return sentences;
}

// ---------------------------------------------------------------------------
// Scenario comparison ("What If?" Playground)
// ---------------------------------------------------------------------------

/** A projected month for either the current or the modified run. */
export interface ScenarioPointLike {
    /** "YYYY-MM". */
    yearMonth: string;
    endingBalance: number;
}

/**
 * Scenario comparison: the gap the change makes by the end, each run's lowest
 * point, and whether the changed plan ever dips below zero.
 */
export function describeScenario(
    current: ScenarioPointLike[],
    modified: ScenarioPointLike[],
    fmt: MoneyFn
): string[] {
    if (current.length === 0 || modified.length === 0) {
        return ['Add a change to see how it compares.'];
    }

    const sentences: string[] = [];
    const curEnd = current[current.length - 1];
    const modEnd = modified[modified.length - 1];
    const diff = modEnd.endingBalance - curEnd.endingBalance;

    if (diff > 0.005) {
        sentences.push(`By ${formatYearMonth(modEnd.yearMonth)} the change leaves you ${fmt(diff)} better off.`);
    } else if (diff < -0.005) {
        sentences.push(`By ${formatYearMonth(modEnd.yearMonth)} the change leaves you ${fmt(Math.abs(diff))} worse off.`);
    } else {
        sentences.push(`By ${formatYearMonth(modEnd.yearMonth)} the change makes almost no difference.`);
    }

    const lowest = (rows: ScenarioPointLike[]) => rows.reduce((a, b) => (b.endingBalance < a.endingBalance ? b : a));
    const modLow = lowest(modified);
    sentences.push(`The changed plan's lowest point is ${fmt(modLow.endingBalance)}, in ${formatYearMonth(modLow.yearMonth)}.`);

    const firstBelow = modified.find((m) => m.endingBalance < 0);
    if (firstBelow) {
        sentences.push(`Watch out: it drops below zero in ${formatYearMonth(firstBelow.yearMonth)}.`);
    } else {
        sentences.push('The change keeps your balance above zero the whole time.');
    }

    return sentences;
}

// ---------------------------------------------------------------------------
// Split insights (spend + running net)
// ---------------------------------------------------------------------------

/** Sum a month→key→cents map over the given months into key→total. */
function sumByKey(byMonth: Record<string, Record<string, number>>, months: string[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of months) {
        const row = byMonth[m];
        if (!row) continue;
        for (const [k, v] of Object.entries(row)) out.set(k, (out.get(k) ?? 0) + v);
    }
    return out;
}

/**
 * Split spend chart: total shared spending over the window and who/which group
 * accounts for most of it. `fmt` formats integer cents (the caller passes a
 * cents formatter).
 */
export function describeSplitSpend(insights: SplitInsights, mode: 'group' | 'member', fmt: MoneyFn): string[] {
    const totalByGroup = sumByKey(insights.spendByGroup, insights.months);
    const grand = Array.from(totalByGroup.values()).reduce((s, v) => s + v, 0);

    if (grand <= 0) {
        return ['There is no shared spending in this period yet.'];
    }

    const sentences: string[] = [`Across these months you shared ${fmt(grand)} in expenses.`];

    if (mode === 'group') {
        const ranked = insights.groups
            .map((g) => ({ name: g.name, total: totalByGroup.get(g.id) ?? 0 }))
            .filter((g) => g.total > 0)
            .sort((a, b) => b.total - a.total);
        const top = ranked[0];
        if (top) {
            sentences.push(
                ranked.length > 1
                    ? `Most runs through "${top.name}" — ${shareToWords(top.total, grand)} of it.`
                    : `It all runs through "${top.name}".`
            );
        }
    } else {
        const byMember = sumByKey(insights.paidByMember, insights.months);
        const grandPaid = Array.from(byMember.values()).reduce((s, v) => s + v, 0);
        const ranked = insights.members
            .map((m) => ({ name: m.name, total: byMember.get(m.userId) ?? 0 }))
            .filter((m) => m.total > 0)
            .sort((a, b) => b.total - a.total);
        const top = ranked[0];
        if (top) {
            sentences.push(
                ranked.length > 1
                    ? `${top.name} fronts the most money — ${shareToWords(top.total, grandPaid)} of it.`
                    : `${top.name} fronts all of it.`
            );
        }
    }

    if (insights.currencies.length > 1) {
        sentences.push('Amounts mix more than one currency, so totals are rough.');
    }

    return sentences;
}

/**
 * Split running-net chart: where you stand now and which way it's leaned over
 * the window. `net > 0` ⇒ you're owed; `< 0` ⇒ you owe.
 */
export function describeSplitNet(insights: SplitInsights, fmt: MoneyFn): string[] {
    const months = insights.months;
    if (months.length === 0) {
        return ['There is nothing to show here yet.'];
    }

    const latest = insights.viewerNetByMonth[months[months.length - 1]] ?? 0;
    const sentences: string[] = [];

    if (latest > 0.5) {
        sentences.push(`Right now you're owed ${fmt(latest)} in total.`);
    } else if (latest < -0.5) {
        sentences.push(`Right now you owe ${fmt(Math.abs(latest))} in total.`);
    } else {
        sentences.push("Right now you're about settled up.");
    }

    let owed = 0;
    let owing = 0;
    for (const m of months) {
        const v = insights.viewerNetByMonth[m] ?? 0;
        if (v > 0.5) owed++;
        else if (v < -0.5) owing++;
    }
    if (owed > owing) {
        sentences.push('Over this time you have mostly been owed money.');
    } else if (owing > owed) {
        sentences.push('Over this time you have mostly owed money.');
    } else {
        sentences.push('Over this time it has stayed close to even.');
    }

    sentences.push('The line rising means people owe you more; falling means you owe more.');

    return sentences;
}

// ---------------------------------------------------------------------------
// Budget month-by-month (Trips & Budgets → budget detail)
// ---------------------------------------------------------------------------

/** Minimal per-month budget row the description needs. */
export interface BudgetMonthLike {
    /** "YYYY-MM". */
    yearMonth: string;
    plannedCosts: number;
    fundingReceived: number;
    cumulativeNet: number;
}

/**
 * Budget month chart: costs vs money coming in per month, and whether the
 * funding covers the plan by the end.
 */
export function describeBudgetMonths(perMonth: BudgetMonthLike[], fmt: MoneyFn): string[] {
    if (perMonth.length === 0) {
        return ['There is nothing planned month by month yet.'];
    }

    const totalCosts = perMonth.reduce((s, m) => s + m.plannedCosts, 0);
    const totalFunding = perMonth.reduce((s, m) => s + m.fundingReceived, 0);
    const sentences: string[] = [`Over the whole plan, costs add up to ${fmt(totalCosts)}.`];

    sentences.push(`Money coming in adds up to ${fmt(totalFunding)}.`);

    const finalNet = perMonth[perMonth.length - 1].cumulativeNet;
    if (finalNet > 0.005) {
        sentences.push(`Funding covers it, with ${fmt(finalNet)} to spare.`);
    } else if (finalNet < -0.005) {
        sentences.push(`You are ${fmt(Math.abs(finalNet))} short — that comes out of your own pocket.`);
    } else {
        sentences.push('Funding covers the costs almost exactly.');
    }

    const busiest = perMonth.reduce((a, b) => (b.plannedCosts > a.plannedCosts ? b : a));
    if (busiest.plannedCosts > 0.005) {
        sentences.push(`The most expensive month is ${formatYearMonth(busiest.yearMonth)}, at ${fmt(busiest.plannedCosts)}.`);
    }

    return sentences;
}

// ---------------------------------------------------------------------------
// Mortgage charts
// ---------------------------------------------------------------------------

/** Balance-over-time: what's still owed now and where it's heading. */
export function describeMortgageBalance(currentOwed: number, endOwed: number, endMonth: string, fmt: MoneyFn): string[] {
    const sentences = [`You still owe about ${fmt(currentOwed)} on the home loan.`];
    sentences.push('Each payment shrinks it a little more.');
    if (endOwed <= 0.005) {
        sentences.push(`By ${formatYearMonth(endMonth)} it is fully paid off.`);
    } else {
        sentences.push(`By ${formatYearMonth(endMonth)} it drops to about ${fmt(endOwed)}.`);
    }
    return sentences;
}

/** One member's current vs target ownership share (both as percentages). */
export interface OwnershipMemberLike {
    name: string;
    /** Current ownership, 0–100. */
    currentPercent: number;
    /** Target ownership, 0–100. */
    targetPercent: number;
}

/** Ownership-progress: each member's share now, heading toward the target. */
export function describeOwnershipProgress(members: OwnershipMemberLike[]): string[] {
    if (members.length === 0) {
        return ['There is no ownership split to show yet.'];
    }
    const sentences = ['This shows how much of the home each person owns as the loan is paid.'];
    for (const m of members.slice(0, 3)) {
        const cur = Math.round(m.currentPercent);
        const tgt = Math.round(m.targetPercent);
        sentences.push(
            cur === tgt
                ? `${m.name} owns ${cur}%, right on target.`
                : `${m.name} owns ${cur}% now, heading toward ${tgt}%.`
        );
    }
    return sentences;
}

/** Principal-vs-interest: how payments split between the loan and the fee. */
export function describePrincipalInterest(principal: number, interest: number, fmt: MoneyFn): string[] {
    return [
        'Every payment splits in two.',
        `Part shrinks the loan (${fmt(principal)} over this span) and part is the bank's fee (${fmt(interest)} in interest).`,
        'Early on more goes to interest; later, more goes to the loan.',
    ];
}

/** Cumulative cost: how much of the loan and how much interest paid to date. */
export function describeCumulativeCost(principalPaid: number, interestPaid: number, fmt: MoneyFn): string[] {
    return [
        `So far you've paid ${fmt(principalPaid)} off what you borrowed.`,
        `On top of that, interest — the bank's fee — has cost you ${fmt(interestPaid)}.`,
    ];
}

/** Rate history: the current rate and its range (percentages as digits). */
export function describeRateHistory(currentPercent: number, minPercent: number, maxPercent: number): string[] {
    const sentences = [`Your interest rate is about ${currentPercent.toFixed(2)}% right now.`];
    if (maxPercent - minPercent > 0.005) {
        sentences.push(`It has moved between ${minPercent.toFixed(2)}% and ${maxPercent.toFixed(2)}% over this period.`);
    } else {
        sentences.push('It has stayed flat over this period.');
    }
    sentences.push('A higher rate means a bigger fee, so more of each payment is interest.');
    return sentences;
}

/** One slice of this month's payment doughnut. */
export interface PaymentSegmentLike {
    label: string;
    value: number;
}

/** This month's payment, broken down into its parts. */
export function describePaymentBreakdown(segments: PaymentSegmentLike[], fmt: MoneyFn): string[] {
    const shown = segments.filter((s) => s.value > 0.005);
    if (shown.length === 0) {
        return ['There is no payment this month.'];
    }
    const total = shown.reduce((s, x) => s + x.value, 0);
    const sentences = [`This month's payment is ${fmt(total)}.`];
    const top = [...shown].sort((a, b) => b.value - a.value)[0];
    sentences.push(`Most of it is ${top.label} — ${shareToWords(top.value, total)} of the payment.`);
    if (shown.some((s) => /interest/i.test(s.label))) {
        sentences.push("Interest is the bank's fee; the rest shrinks the loan.");
    }
    return sentences;
}

/** One member's built-up equity (a money amount). */
export interface EquityMemberLike {
    name: string;
    equity: number;
}

/** Equity build-up: each member's share of the home so far. */
export function describeEquityBuildup(members: EquityMemberLike[], fmt: MoneyFn): string[] {
    const withEquity = members.filter((m) => m.equity > 0.005);
    if (withEquity.length === 0) {
        return ['No home equity has built up yet.'];
    }
    const sentences = ['Equity is the part of the home you actually own — it grows as the loan shrinks.'];
    for (const m of withEquity.slice(0, 3)) {
        sentences.push(`${m.name} has about ${fmt(m.equity)} of equity so far.`);
    }
    return sentences;
}

/** The money-flow snapshot the mortgage Sankey draws. */
export interface MortgageSankeyLike {
    totalPaidIn: number;
    interestPaid: number;
    amortizationPaid: number;
    amortizationLeft: number;
}

/** Mortgage Sankey: where the money paid into the loan has gone. */
export function describeMortgageSankey(snapshot: MortgageSankeyLike, fmt: MoneyFn): string[] {
    const sentences = [`So far ${fmt(snapshot.totalPaidIn)} has been paid into the mortgage.`];
    sentences.push(
        `Of that, ${fmt(snapshot.interestPaid)} was interest — the bank's fee — and ${fmt(snapshot.amortizationPaid)} shrank the loan.`
    );
    if (snapshot.amortizationLeft > 0.005) {
        sentences.push(`About ${fmt(snapshot.amortizationLeft)} of the loan is still left to pay.`);
    }
    return sentences;
}

/** Transfer comparison: is the offer cheaper, and does it pay for itself? */
export function describeTransferComparison(
    currentLifetime: number,
    offerLifetime: number,
    breakEvenMonths: number | null,
    fmt: MoneyFn
): string[] {
    const diff = currentLifetime - offerLifetime;
    const sentences: string[] = [];
    if (diff > 0.005) {
        sentences.push(`Over the loan's life, this offer would save you ${fmt(diff)}.`);
    } else if (diff < -0.005) {
        sentences.push(`Over the loan's life, this offer would cost you ${fmt(Math.abs(diff))} more.`);
    } else {
        sentences.push("Over the loan's life, the two cost about the same.");
    }
    if (breakEvenMonths != null && breakEvenMonths >= 0) {
        const years = (breakEvenMonths / 12).toFixed(1);
        sentences.push(`It pays back its switching costs in about ${breakEvenMonths} months (~${years} years).`);
    } else {
        sentences.push('It never quite pays back its switching costs.');
    }
    sentences.push('The red line is your current loan; the green line is the offer.');
    return sentences;
}
