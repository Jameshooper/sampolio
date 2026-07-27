'use client';

import { useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Wraps page content in the 250ms `rise-in` entrance and — crucially —
 * RESTARTS the animation on every pathname change. A plain
 * `<div className="animate-rise-in">` is not enough: Next 16 pre-mounts
 * prefetched route trees hidden, so the CSS animation clock is already spent
 * by the time the page is shown and the entrance never plays. Layout effects
 * are deferred until the tree is actually revealed, so the imperative
 * restart below fires exactly at reveal time. The global
 * prefers-reduced-motion kill-switch still neutralizes it (0.01ms duration).
 * Used by the dashboard group's template.tsx and the Home dashboard (which
 * lives outside the group).
 */
export function PageEntrance({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const ref = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.animation = 'none';
        void el.offsetWidth; // reflow so the removal takes effect
        el.style.animation = '';
    }, [pathname]);

    return (
        <div ref={ref} className="animate-rise-in">
            {children}
        </div>
    );
}
