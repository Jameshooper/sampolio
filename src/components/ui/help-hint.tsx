'use client';

import { useId } from 'react';
import { Tooltip } from 'primereact/tooltip';
import { MdHelpOutline } from 'react-icons/md';

interface HelpHintProps {
    /** Plain-language explanation shown in the tooltip. */
    text: string;
    /** Accessible label; defaults to "What does this mean?". */
    ariaLabel?: string;
}

/**
 * Small tap-friendly "?" affordance that explains a finance term in plain
 * words. Renders inline next to a label; the tooltip opens on hover and on
 * focus (a tap focuses the button on mobile). Feed it text from
 * `helpText(...)` in src/lib/plain-language.ts so wording stays consistent.
 */
export function HelpHint({ text, ariaLabel = 'What does this mean?' }: HelpHintProps) {
    // useId contains ":" which is invalid in a CSS selector — strip it.
    const id = `help-hint-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

    return (
        <>
            <Tooltip target={`#${id}`} content={text} event="both" position="top" className="max-w-xs" />
            <button
                type="button"
                id={id}
                aria-label={ariaLabel}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center justify-center align-middle ml-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 rounded-full"
            >
                <MdHelpOutline size={16} aria-hidden />
            </button>
        </>
    );
}
