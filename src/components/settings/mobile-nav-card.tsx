'use client';

import { useCallback, useMemo, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { MdCheck, MdMoreHoriz } from 'react-icons/md';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { navItems } from '@/components/layout/nav-config';
import { useJiggleReorder, JiggleModeBar } from '@/components/ui/jiggle-reorder';
import { updateBottomNavIds } from '@/lib/actions/user-preferences';
import {
    MAX_BOTTOM_NAV_TABS,
    resolveBottomNavIds,
    toggleBottomNavId,
} from '@/lib/bottom-nav-prefs';
import type { NavigationPage } from '@/types';

/**
 * Settings → General card for customizing the mobile bottom-nav tabs: pick up to
 * `MAX_BOTTOM_NAV_TABS` pages and drag them into order. "More" is rendered as a
 * greyed, non-reorderable trailing cell because it is always the last tab.
 *
 * Two distinct surfaces on purpose: the preview row carries the jiggle-reorder
 * hook (whose `onClickCapture` swallows clicks inside `[data-jiggle-item]` while
 * jiggling, so it can't host selection), and the chip grid below does the
 * selecting. Persistence lives here rather than in AppLayout because it needs the
 * ApiResponse for rollback + a toast.
 */
export function MobileNavCard() {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const appContext = useAppContext();
    const toast = useToast();

    const heading = `text-lg font-semibold mb-1 ${isDark ? 'text-gray-100' : 'text-gray-900'}`;
    const subtext = `text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`;
    const idleCls = isDark ? 'text-gray-400' : 'text-gray-500';

    const storedIds = appContext?.bottomNavIds ?? null;
    const displayMode = appContext?.displayMode;
    // Uncustomized users see (and can immediately drag) the resolved defaults;
    // the first mutation persists the full explicit list.
    const chosen = useMemo(() => resolveBottomNavIds(storedIds, displayMode), [storedIds, displayMode]);
    const isCustomized = Boolean(storedIds);

    const setBottomNavIds = appContext?.setBottomNavIds;
    const persist = useCallback(
        (next: string[] | null) => {
            if (!setBottomNavIds) return;
            const prev = storedIds;
            setBottomNavIds(next); // the real bar updates the same frame
            void updateBottomNavIds(next).then((res) => {
                if (!res.success) {
                    setBottomNavIds(prev);
                    toast.error('Could not save navigation', res.error);
                } else if (next === null) {
                    toast.success('Default tabs restored');
                }
            });
        },
        [setBottomNavIds, storedIds, toast],
    );

    const [jiggling, setJiggling] = useState(false);
    const reorder = useJiggleReorder({
        ids: chosen,
        axis: 'x',
        jiggling,
        onJiggleChange: setJiggling,
        onReorder: (nextIds) => persist(nextIds),
        disabled: chosen.length < 2,
    });
    const { ref: previewRef, ...previewRest } = reorder.containerProps;

    const toggle = (id: NavigationPage) => {
        const next = toggleBottomNavId(chosen, id);
        if (next) persist(next); // null ⇒ at the min/max bound: silent no-op
    };

    return (
        <Card>
            <h2 className={heading}>Mobile navigation</h2>
            <p className={subtext}>
                Choose up to {MAX_BOTTOM_NAV_TABS} tabs for the bottom bar on your phone, and drag to
                reorder. &quot;More&quot; is always the last tab.
            </p>

            {chosen.length >= 2 && (
                <button
                    type="button"
                    onClick={() => setJiggling(true)}
                    className="sr-only focus:not-sr-only focus:mb-2 focus:inline-flex focus:items-center focus:min-h-[44px] focus:px-3 focus:rounded-lg focus:border focus:surface-border"
                >
                    Reorder tabs
                </button>
            )}

            {/* Preview of the real bar — reorder surface only (selection lives in
                the chip grid below). */}
            <div
                ref={previewRef as React.Ref<HTMLDivElement>}
                {...previewRest}
                className="mt-4 rounded-xl border surface-border overflow-hidden flex items-stretch h-16"
            >
                {chosen.map((id) => {
                    const item = navItems.find((n) => n.id === id);
                    if (!item) return null;
                    const { ref: itemRef, ...itemRest } = reorder.getItemProps(id);
                    return (
                        <div
                            key={id}
                            ref={itemRef as React.Ref<HTMLDivElement>}
                            {...itemRest}
                            className={`flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 text-[0.7rem] font-medium ${idleCls}`}
                        >
                            <span data-jiggle-inner="" className="flex flex-col items-center gap-0.5">
                                {item.icon}
                                <span className="truncate max-w-full px-0.5">{item.label}</span>
                            </span>
                        </div>
                    );
                })}
                {/* Never registered with the jiggle hook — "More" is fixed. */}
                <div
                    title="Always the last tab"
                    className={`flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 text-[0.7rem] font-medium opacity-50 ${idleCls}`}
                >
                    <MdMoreHoriz size={20} />
                    <span>More</span>
                </div>
            </div>
            <p className={`mt-2 ${subtext}`}>Press and hold a tab to reorder</p>

            <div className="mt-4 flex flex-wrap gap-2">
                {navItems.map((item) => {
                    const selected = chosen.includes(item.id);
                    const disabled = !selected && chosen.length >= MAX_BOTTOM_NAV_TABS;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={selected}
                            disabled={disabled}
                            onClick={() => toggle(item.id)}
                            className={`inline-flex items-center gap-2 rounded-lg border-2 px-3 min-h-[44px] text-sm font-medium transition-colors ${
                                selected
                                    ? 'border-accent-500 bg-accent-50 dark:bg-accent-400/15'
                                    : isDark
                                        ? 'border-gray-700 hover:border-gray-600'
                                        : 'border-gray-200 hover:border-gray-300'
                            } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                            {selected && <MdCheck size={16} className="opacity-70" />}
                        </button>
                    );
                })}
            </div>

            <p className={`mt-3 ${subtext}`} aria-live="polite">
                {chosen.length} of {MAX_BOTTOM_NAV_TABS} tabs selected — at least 1 tab plus More.
            </p>

            {isCustomized && (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button label="Reset to default" text severity="secondary" onClick={() => persist(null)} />
                    <span className={subtext}>Applies in both Simple and Advanced modes.</span>
                </div>
            )}

            <JiggleModeBar
                jiggling={jiggling}
                onDone={() => setJiggling(false)}
                hint="Drag to reorder tabs"
            />
        </Card>
    );
}
