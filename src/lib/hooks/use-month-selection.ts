'use client';

import { useMemo, useState } from 'react';
import type { MonthlyProjection } from '@/types';

/**
 * Single source of truth for the cashflow page's month selection. Every
 * selection surface (month strip, projection table rows, mobile month cards)
 * reads `selectedMonth` and calls the same `setSelectedMonth`, so the views
 * can never disagree.
 *
 * `displayMonths` is the merged retrospective + forecast list; `nowMonth` is
 * the first forecast month (the anchor) that scroll-into-view targets use.
 */
export function useMonthSelection(displayMonths: MonthlyProjection[], forecastMonths: MonthlyProjection[]) {
    const [selectedMonth, setSelectedMonth] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

    const months = useMemo(() => displayMonths.map((p) => p.yearMonth), [displayMonths]);

    const selectedProjection = useMemo(
        () => displayMonths.find((p) => p.yearMonth === selectedMonth) || null,
        [displayMonths, selectedMonth]
    );

    // "Now" = the first forecast month (the anchor). The retrospective sits to
    // its left; tables/cards default-scroll here so the view starts at the
    // current month (past months remain reachable by scrolling up).
    const nowMonth = useMemo(() => {
        if (forecastMonths.length > 0) return forecastMonths[0].yearMonth;
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }, [forecastMonths]);

    return { selectedMonth, setSelectedMonth, months, selectedProjection, nowMonth };
}
