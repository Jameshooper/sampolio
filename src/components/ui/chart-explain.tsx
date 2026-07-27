'use client';

/**
 * Reusable "explain this chart" primitives — a quiet header button, an inline
 * expander with a canned "how to read" section plus a live plain-words section,
 * and a guided step-through "tour" that highlights parts of the real chart.
 *
 * These are the shared core for making the cashflow charts readable to people
 * who don't think visually; a later pass wires other pages' charts with the
 * same pieces. The plain-words sentences come from the pure engine in
 * `src/lib/chart-descriptions.ts` (money formatted at render, demo-mask aware).
 *
 * Motion: the panel uses the app's `.collapse-grid`/`.is-open` auto-height
 * expander (no library, tokens only). Tours are steppers, not animations — they
 * work identically under reduced motion; only their (absent) CSS animation is
 * the concern, so there's nothing to gate.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { EChartsType } from 'echarts/core';
import { MdLightbulbOutline, MdExpandMore, MdChevronLeft, MdChevronRight } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';

// ---------------------------------------------------------------------------
// State hook
// ---------------------------------------------------------------------------

/**
 * Owns the panel open/closed state and the stable ids that tie the button, the
 * panel and the screen-reader description together. In simple display mode the
 * panel opens by default (words first) until the user closes it themselves.
 */
export function useChartExplain() {
    const isSimple = useAppContext()?.displayMode === 'simple';
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const panelId = `chart-explain-${uid}`;
    const descId = `chart-desc-${uid}`;
    const [touched, setTouched] = useState(false);
    const [open, setOpen] = useState(isSimple);
    const [prevSimple, setPrevSimple] = useState(isSimple);

    // The display-mode preference resolves asynchronously (advanced → simple).
    // When it flips to simple, open the panel once — unless the user has already
    // toggled it. Adjusting state during render (not in an effect) is the
    // React-recommended pattern for "reset state when a prop changes".
    if (isSimple !== prevSimple) {
        setPrevSimple(isSimple);
        if (isSimple && !touched) setOpen(true);
    }

    const toggle = useCallback(() => {
        setTouched(true);
        setOpen((o) => !o);
    }, []);

    return { isSimple, open, setOpen, toggle, panelId, descId };
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

interface ChartExplainButtonProps {
    open: boolean;
    onClick: () => void;
    /** id of the panel this button controls (aria-controls). */
    controls: string;
    className?: string;
}

/** Small, quiet pill button that lives in a chart header and toggles the panel. */
export function ChartExplainButton({ open, onClick, controls, className }: ChartExplainButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-expanded={open}
            aria-controls={controls}
            className={`inline-flex items-center gap-1 min-h-9 rounded-full px-3 py-1.5 text-xs font-medium
                text-gray-600 dark:text-gray-300 bg-black/[0.04] dark:bg-white/[0.06]
                hover:bg-black/[0.07] dark:hover:bg-white/[0.1] transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${className ?? ''}`}
        >
            <MdLightbulbOutline size={15} aria-hidden />
            <span>Explain</span>
            <MdExpandMore
                size={15}
                aria-hidden
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
                style={{ transitionDuration: 'var(--motion-base)' }}
            />
        </button>
    );
}

// ---------------------------------------------------------------------------
// "How to read" visual cues
// ---------------------------------------------------------------------------

export type CueShape = 'square' | 'dot' | 'band' | 'line' | 'group' | 'updown';

export interface ReadCue {
    /** Short line of text (≤ ~15 words). */
    text: string;
    shape?: CueShape;
    /** Primary swatch color (matches the chart's real palette). */
    color?: string;
    /** Second color for the `updown` shape (the "down"/negative chip). */
    color2?: string;
    /** Render the `line` shape dashed (e.g. the "Now" marker). */
    dashed?: boolean;
}

/** A 12–16px inline swatch that mirrors a chart element's look. */
function ChartCueSwatch({ shape = 'square', color = '#9ca3af', color2 = '#ef4444', dashed }: Omit<ReadCue, 'text'>) {
    const wrap = 'inline-flex shrink-0 items-center mt-0.5';
    if (shape === 'updown') {
        return (
            <span className={`${wrap} gap-0.5`} aria-hidden>
                <span className="w-3 h-3 rounded-sm" style={{ background: color }} />
                <span className="w-3 h-3 rounded-sm" style={{ background: color2 }} />
            </span>
        );
    }
    if (shape === 'dot') {
        return <span className={`${wrap} w-3 h-3 rounded-full`} style={{ background: color }} aria-hidden />;
    }
    if (shape === 'band') {
        return <span className={`${wrap} w-4 h-2.5 rounded-sm`} style={{ background: color }} aria-hidden />;
    }
    if (shape === 'line') {
        return dashed ? (
            <span className={`${wrap} w-4 mt-2`} style={{ borderTop: `2px dashed ${color}` }} aria-hidden />
        ) : (
            <span className={`${wrap} w-4 h-[3px] mt-2 rounded-full`} style={{ background: color }} aria-hidden />
        );
    }
    if (shape === 'group') {
        // Hollow box = a tile/node that holds items inside it.
        return <span className={`${wrap} w-3.5 h-3.5 rounded-sm border-2`} style={{ borderColor: color }} aria-hidden />;
    }
    return <span className={`${wrap} w-3 h-3 rounded-sm`} style={{ background: color }} aria-hidden />;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface ChartExplainPanelProps {
    /** DOM id — matches the button's aria-controls. */
    id: string;
    open: boolean;
    /** Human name of the chart, used in the screen-reader description. */
    chartLabel: string;
    /** Canned "shape → meaning" cues for this chart type. */
    howToRead: ReadCue[];
    /** Generated plain-words sentences (already formatted). */
    description: string[];
    /** Starts the guided tour; omit to hide the "Show me on the chart" link. */
    onStartTour?: () => void;
    /** id for the always-present sr-only description (chart's aria-describedby). */
    describedById: string;
    /** Heading for the generated-sentences section. Defaults to the cashflow
     *  charts' monthly wording; non-monthly charts pass their own (e.g.
     *  "In plain words"). */
    plainWordsLabel?: string;
}

/**
 * Inline expander shown between a chart's header and the chart itself. Holds a
 * collapsible "How to read this chart" section and an always-open "This month
 * in plain words" section. Also renders the screen-reader description (outside
 * the collapse) so assistive tech always has the text alternative.
 */
export function ChartExplainPanel({
    id,
    open,
    chartLabel,
    howToRead,
    description,
    onStartTour,
    describedById,
    plainWordsLabel = 'This month in plain words',
}: ChartExplainPanelProps) {
    const isSimple = useAppContext()?.displayMode === 'simple';
    // In simple mode the words lead, so the how-to-read intro starts folded.
    const [introOpen, setIntroOpen] = useState(!isSimple);

    return (
        <>
            {/* Always-on text alternative for screen readers. */}
            <p id={describedById} className="sr-only">
                {chartLabel} in plain words: {description.join(' ')}
            </p>

            <div id={id} className={`collapse-grid ${open ? 'is-open' : ''}`} inert={open ? undefined : true}>
                <div>
                    <div className="mb-3 rounded-lg border border-black/5 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] p-3">
                        {/* How to read this chart (collapsible) */}
                        <button
                            type="button"
                            onClick={() => setIntroOpen((o) => !o)}
                            aria-expanded={introOpen}
                            className="flex w-full items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100 transition-colors"
                        >
                            <MdLightbulbOutline size={16} className="text-amber-500" aria-hidden />
                            <span>How to read this chart</span>
                            <MdExpandMore
                                size={18}
                                aria-hidden
                                className={`ml-auto opacity-60 transition-transform ${introOpen ? 'rotate-180' : ''}`}
                                style={{ transitionDuration: 'var(--motion-base)' }}
                            />
                        </button>
                        <div className={`collapse-grid ${introOpen ? 'is-open' : ''}`} inert={introOpen ? undefined : true}>
                            <div>
                                <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-gray-700 dark:text-gray-300">
                                    {howToRead.map((cue, i) => (
                                        <li key={i} className="flex items-start gap-2">
                                            <ChartCueSwatch
                                                shape={cue.shape}
                                                color={cue.color}
                                                color2={cue.color2}
                                                dashed={cue.dashed}
                                            />
                                            <span>{cue.text}</span>
                                        </li>
                                    ))}
                                </ul>
                                {onStartTour && (
                                    <button
                                        type="button"
                                        onClick={onStartTour}
                                        className="mt-2.5 inline-flex items-center gap-1 rounded-md text-sm font-medium text-accent-600 dark:text-accent-400 hover:underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                                    >
                                        <MdLightbulbOutline size={15} aria-hidden />
                                        Show me on the chart
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Plain-words summary (always shown while the panel is open) */}
                    <div className="text-sm">
                        <p className="mb-1 font-semibold text-gray-800 dark:text-gray-100">{plainWordsLabel}</p>
                        <ul className="list-disc space-y-1 pl-5 leading-relaxed text-gray-700 dark:text-gray-300">
                            {description.map((s, i) => (
                                <li key={i}>{s}</li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        </>
    );
}

// ---------------------------------------------------------------------------
// Convenience wrapper
// ---------------------------------------------------------------------------

interface ChartExplainProps {
    /** Human name of the chart (screen-reader label + description prefix). */
    chartLabel: string;
    howToRead: ReadCue[];
    description: string[];
    /** Heading for the plain-words section (defaults to the monthly wording). */
    plainWordsLabel?: string;
    /** Starts a guided tour; omit for cues-only charts (e.g. all Chart.js ones). */
    onStartTour?: () => void;
    /** Override the button row layout (defaults to a right-aligned row). */
    buttonRowClassName?: string;
    /** The chart itself; wrapped in an `img`-role region tied to the description. */
    children: ReactNode;
}

/**
 * Bundles the Explain button, the panel and the always-present sr-only text for
 * charts whose title lives outside the chart component (most non-cashflow
 * charts). It owns its own open/close state, and wraps the chart in a
 * `role="img"` region carrying `aria-describedby`, so both ECharts and Chart.js
 * canvases get the same text alternative without threading an id back to the
 * canvas element. Tours (which need a live ECharts ref) stay opt-in via
 * `onStartTour`; the low-level primitives above remain available for the
 * cashflow charts that wire tours directly.
 */
export function ChartExplain({
    chartLabel,
    howToRead,
    description,
    plainWordsLabel,
    onStartTour,
    buttonRowClassName,
    children,
}: ChartExplainProps) {
    const explain = useChartExplain();
    return (
        <div className="relative">
            <div className={buttonRowClassName ?? 'mb-2 flex items-center justify-end'}>
                <ChartExplainButton open={explain.open} onClick={explain.toggle} controls={explain.panelId} />
            </div>
            <ChartExplainPanel
                id={explain.panelId}
                open={explain.open}
                chartLabel={chartLabel}
                howToRead={howToRead}
                description={description}
                plainWordsLabel={plainWordsLabel}
                onStartTour={onStartTour}
                describedById={explain.descId}
            />
            <div role="img" aria-label={chartLabel} aria-describedby={explain.descId}>
                {children}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Tour
// ---------------------------------------------------------------------------

export interface ChartTourStep {
    /** One short sentence describing what's highlighted. */
    text: string;
    /** Highlight the relevant chart elements (via dispatchAction). */
    apply?: (chart: EChartsType) => void;
    /** Undo this step's highlight (called before the next step / on finish). */
    clear?: (chart: EChartsType) => void;
}

export interface ChartTour {
    active: boolean;
    index: number;
    total: number;
    step: ChartTourStep | undefined;
    start: () => void;
    next: () => void;
    prev: () => void;
    finish: () => void;
}

/**
 * Drives a step-through tour over a live ECharts instance. Each step's `apply`
 * highlights part of the chart and `clear` undoes it; the hook guarantees the
 * previously-applied step is cleared before the next is applied, and clears on
 * finish/unmount. `getChart` returns the instance (may be null before ready).
 */
export function useChartTour(steps: ChartTourStep[], getChart: () => EChartsType | null): ChartTour {
    const [index, setIndex] = useState(0);
    const [active, setActive] = useState(false);
    const appliedRef = useRef<number | null>(null);

    const clearApplied = useCallback(() => {
        const chart = getChart();
        if (chart && appliedRef.current != null) {
            steps[appliedRef.current]?.clear?.(chart);
        }
        appliedRef.current = null;
    }, [getChart, steps]);

    const applyStep = useCallback(
        (i: number) => {
            const chart = getChart();
            if (!chart) return;
            steps[i]?.apply?.(chart);
            appliedRef.current = i;
        },
        [getChart, steps]
    );

    const goTo = useCallback(
        (i: number) => {
            const clamped = Math.max(0, Math.min(steps.length - 1, i));
            clearApplied();
            setIndex(clamped);
            applyStep(clamped);
        },
        [applyStep, clearApplied, steps.length]
    );

    const finish = useCallback(() => {
        clearApplied();
        // Blanket downplay in case a step highlighted without a matching clear.
        getChart()?.dispatchAction({ type: 'downplay' });
        setActive(false);
    }, [clearApplied, getChart]);

    const start = useCallback(() => {
        if (steps.length === 0) return;
        setActive(true);
        setIndex(0);
        clearApplied();
        applyStep(0);
    }, [applyStep, clearApplied, steps.length]);

    const next = useCallback(() => {
        if (index >= steps.length - 1) finish();
        else goTo(index + 1);
    }, [finish, goTo, index, steps.length]);

    const prev = useCallback(() => goTo(index - 1), [goTo, index]);

    // Clear any lingering highlight if the component unmounts mid-tour.
    useEffect(() => {
        return () => {
            const chart = getChart();
            if (chart && appliedRef.current != null) {
                steps[appliedRef.current]?.clear?.(chart);
                chart.dispatchAction({ type: 'downplay' });
            }
        };
        // Only on unmount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { active, index, total: steps.length, step: steps[index], start, next, prev, finish };
}

interface ChartTourBarProps {
    tour: ChartTour;
    /** Chart name for the a11y group label. */
    label: string;
    className?: string;
}

/**
 * Compact stepper rendered under a chart while a tour is active: prev/next
 * arrows, a step counter, the current sentence, and Done. Focus lands here on
 * mount so ←/→/Escape work immediately.
 */
export function ChartTourBar({ tour, label, className }: ChartTourBarProps) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            tour.next();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            tour.prev();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            tour.finish();
        }
    };

    const atEnd = tour.index >= tour.total - 1;

    return (
        <div
            ref={ref}
            role="group"
            aria-label={`${label}: guided walkthrough`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            className={`mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-accent-500/30 bg-accent-500/5 px-3 py-2 text-sm
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${className ?? ''}`}
        >
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={tour.prev}
                    disabled={tour.index === 0}
                    aria-label="Previous step"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 transition-colors hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                    <MdChevronLeft size={20} aria-hidden />
                </button>
                <span className="tabular-nums text-xs font-medium text-gray-500 dark:text-gray-400" aria-hidden>
                    {tour.index + 1}/{tour.total}
                </span>
                <button
                    type="button"
                    onClick={tour.next}
                    aria-label={atEnd ? 'Finish walkthrough' : 'Next step'}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-600 dark:text-gray-300 transition-colors hover:bg-black/5 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                    <MdChevronRight size={20} aria-hidden />
                </button>
            </div>
            <p className="min-w-0 flex-1 text-gray-700 dark:text-gray-200">{tour.step?.text}</p>
            <button
                type="button"
                onClick={tour.finish}
                className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-accent-600 dark:text-accent-400 transition-colors hover:bg-accent-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
                Done
            </button>
        </div>
    );
}
