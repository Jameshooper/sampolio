'use client';

/**
 * "Where your wealth sits" — the current distribution of the user's assets,
 * rendered on /overview right below the KPI tiles (both display modes).
 *
 * Deliberately a slim CSS segmented bar + legend, not a canvas chart: it shows
 * one snapshot (no time axis, no series) so it needs neither ECharts/Chart.js
 * nor the `ChartExplain` machinery — the legend and the plain-words footer
 * already say everything the bar says. Colors come from the shared
 * `WEALTH_COLORS` map in `charts/wealth-chart.tsx`, so a category reads the same
 * here as in the net-worth breakdown chart.
 *
 * Dumb display component: every number arrives already computed in the display
 * currency (the page's `kpiValues`); nothing is fetched or converted here.
 */

import { useMemo } from 'react';
import { Card } from 'primereact/card';
import { HelpHint } from '@/components/ui/help-hint';
import { rgb } from '@/components/charts/wealth-chart';
import { formatCurrency } from '@/lib/constants';
import { plainTerm, helpText } from '@/lib/plain-language';
import type { Currency } from '@/types';

/** A value below this (half a cent) is treated as zero — no segment, no footer. */
const EPSILON = 0.005;

/** Keys of the shared wealth-color map (kept in sync via `rgb`'s signature). */
type WealthColorKey = Parameters<typeof rgb>[0];

interface Segment {
    /** Stable key — also picks the category color. */
    key: WealthColorKey;
    label: string;
    /** Amount in the display currency. */
    value: number;
    /** Share of the asset total, 0–1. */
    share: number;
}

interface WealthDistributionProps {
    values: {
        cashTotal: number;
        investmentsTotal: number;
        receivablesTotal: number;
        mortgageEquity: number;
        splitNetTotal: number;
        debtsTotal: number;
        cardLiabilitiesTotal: number;
        netWorth: number;
    };
    currency: Currency;
    isMixedCurrency: boolean;
    isSimple: boolean;
}

/** "a", "a and b", "a, b and c" — plain-words list for the footer sentence. */
function joinWords(words: string[]): string {
    if (words.length <= 1) return words[0] ?? '';
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function WealthDistribution({ values, currency, isMixedCurrency, isSimple }: WealthDistributionProps) {
    const { cashTotal, investmentsTotal, receivablesTotal, mortgageEquity, splitNetTotal } = values;
    const { debtsTotal, cardLiabilitiesTotal, netWorth } = values;

    // Numbers only — money strings must be formatted during render so the
    // demo-mask flag (read inside formatCurrency) is always current.
    const { segments, assetTotal } = useMemo(() => {
        const candidates: Array<{ key: WealthColorKey; label: string; value: number }> = [
            { key: 'cash', label: 'Cash', value: cashTotal },
            { key: 'investments', label: plainTerm('investments', isSimple), value: investmentsTotal },
            { key: 'receivables', label: plainTerm('receivables', isSimple), value: receivablesTotal },
            { key: 'homeValue', label: plainTerm('homeEquity', isSimple), value: mortgageEquity },
            // Only a positive split net is an asset; owing shows up in the footer.
            { key: 'split', label: plainTerm('splitBalance', isSimple), value: splitNetTotal },
        ];
        const present = candidates.filter(c => c.value > EPSILON);
        const total = present.reduce((sum, c) => sum + c.value, 0);
        return {
            assetTotal: total,
            segments: total > EPSILON
                ? present.map<Segment>(c => ({ ...c, share: c.value / total }))
                : [],
        };
    }, [cashTotal, investmentsTotal, receivablesTotal, mortgageEquity, splitNetTotal, isSimple]);

    // Nothing owned yet (a brand-new account) — a bar of nothing says nothing.
    // A single segment DOES render: "all of it is cash" is a real answer, and
    // hiding it would make the card appear only once a second asset exists.
    if (segments.length === 0) return null;

    const title = plainTerm('wealthMix', isSimple);
    const barLabel = `${title}: ${segments
        .map(s => `${s.label} ${Math.round(s.share * 100)}%`)
        .join(', ')}.`;

    // What has to come off the assets to reach net worth. Mortgage liability is
    // deliberately absent — `mortgageEquity` is already net of the loan share.
    const owedParts: string[] = [];
    if (debtsTotal > EPSILON) owedParts.push('debts');
    if (cardLiabilitiesTotal > EPSILON) owedParts.push('credit cards');
    if (splitNetTotal < -EPSILON) owedParts.push('shared expenses');
    const owedTotal = debtsTotal + cardLiabilitiesTotal + Math.max(0, -splitNetTotal);

    return (
        <Card>
            <div className="flex items-baseline justify-between gap-x-3 gap-y-1 flex-wrap mb-3">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {title}
                    <HelpHint text={helpText('wealthMix')} />
                </h2>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                    Assets{' '}
                    <span className="tabular-nums font-medium text-gray-700 dark:text-gray-200">
                        {formatCurrency(assetTotal, currency)}
                    </span>
                    {isMixedCurrency && <span className="ml-2 text-xs">(mixed currencies)</span>}
                </span>
            </div>

            {/* The bar. Segment widths are exact shares; a tiny-but-nonzero
                category keeps a sliver of width so it stays visible (min-width
                is a hard floor, and flex shrinking absorbs the overflow). */}
            <div
                role="img"
                aria-label={barLabel}
                className="h-3 rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-700"
            >
                {segments.map(s => (
                    <span
                        key={s.key}
                        className="h-full"
                        style={{ width: `${s.share * 100}%`, minWidth: '0.375rem', background: rgb(s.key) }}
                    />
                ))}
            </div>

            {/* Legend */}
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
                {segments.map(s => (
                    <span key={s.key} className="inline-flex items-center gap-1.5 min-w-0">
                        <span
                            aria-hidden
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ background: rgb(s.key) }}
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-200 truncate">{s.label}</span>
                        <span className="text-sm tabular-nums font-medium text-gray-900 dark:text-gray-100">
                            {formatCurrency(s.value, currency)}
                        </span>
                        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                            {Math.round(s.share * 100)}%
                        </span>
                    </span>
                ))}
            </div>

            {owedTotal > EPSILON && (
                <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    After {formatCurrency(owedTotal, currency)} of {joinWords(owedParts)}, your net worth
                    is {formatCurrency(netWorth, currency)}.
                </p>
            )}
        </Card>
    );
}
