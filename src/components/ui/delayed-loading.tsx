'use client';

import { ProgressSpinner } from 'primereact/progressspinner';
import { useDelayedFlag } from '@/lib/hooks/use-delayed-flag';

/**
 * A centered spinner that only appears after a short delay, so fast loads never
 * flash it. Use as a Suspense fallback or while a client fetch is in flight —
 * pass `active` for the latter (defaults to always-loading, which is right for a
 * Suspense fallback that unmounts once its content is ready).
 */
export function DelayedSpinner({
  active = true,
  delayMs = 300,
  className = 'flex items-center justify-center py-16',
}: {
  active?: boolean;
  delayMs?: number;
  className?: string;
}) {
  const show = useDelayedFlag(active, delayMs);
  return (
    <div className={className} aria-busy={active} aria-live="polite">
      {show && <ProgressSpinner style={{ width: 44, height: 44 }} strokeWidth="4" />}
    </div>
  );
}

/**
 * Reveals its children (a content-shaped Skeleton) only after `delayMs`. Ideal
 * as a Suspense fallback: instant renders show nothing, slow ones get a skeleton
 * that matches the eventual layout instead of a jarring spinner.
 */
export function DelayedSkeleton({
  children,
  delayMs = 300,
}: {
  children: React.ReactNode;
  delayMs?: number;
}) {
  const show = useDelayedFlag(true, delayMs);
  return show ? <>{children}</> : null;
}
