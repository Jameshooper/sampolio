'use client';

import { useSyncExternalStore } from 'react';

/**
 * SSR-safe media-query hook (mirrors the theme-provider's useSyncExternalStore
 * pattern). Returns `false` on the server / first paint, then the real value
 * after hydration. Prefer CSS (`lg:hidden` / `hidden lg:block`) for layout
 * VISIBILITY; reach for this only when logic must branch (e.g. which component
 * to mount, a numeric prop like a chart height, or `maximized={isMobile}`).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (callback: () => void) => {
    if (typeof window === 'undefined') return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  };
  const getSnapshot = () =>
    typeof window !== 'undefined' && window.matchMedia(query).matches;
  const getServerSnapshot = () => false;

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True below Tailwind's `lg` breakpoint (1024px) — i.e. mobile/tablet chrome. */
export function useIsMobile(): boolean {
  return useMediaQuery('(max-width: 1023px)');
}
