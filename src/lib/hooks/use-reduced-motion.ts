'use client';

import { useMediaQuery } from '@/lib/hooks/use-media-query';

/**
 * True when the OS requests reduced motion. CSS motion is already neutralized
 * globally by the `prefers-reduced-motion` kill-switch in globals.css — reach
 * for this hook only when JS drives an animation (rAF loops, scrollTo with
 * `behavior: 'smooth'`, imperative style tweens) and must bail out itself.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
