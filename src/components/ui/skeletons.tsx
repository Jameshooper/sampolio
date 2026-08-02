'use client';

import { Skeleton } from 'primereact/skeleton';
import { DelayedSkeleton } from './delayed-loading';

/**
 * Content-shaped loading skeletons for the heavy pages. Each is wrapped in
 * DelayedSkeleton, so on a fast load (the common case after the HKDF fix) nothing
 * flashes, and on a slow one the user sees the page's *shape* — which reads as
 * "the page is here, loading" far better than a lone centered spinner.
 *
 * Available: KpiGridSkeleton (Overview), ChartsPageSkeleton (Cashflow/Mortgage),
 * ListPageSkeleton (Split/Budgets/Bank lists), HomeSkeleton (Home dashboard),
 * SplitDetailSkeleton (Split group detail).
 */

/** Overview: title + KPI tiles + a chart block. */
export function KpiGridSkeleton() {
  return (
    <DelayedSkeleton>
      <div className="space-y-6 max-w-360 mx-auto py-8">
        <Skeleton width="14rem" height="2.5rem" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} height="7rem" borderRadius="0.75rem" />
          ))}
        </div>
        <Skeleton height="20rem" borderRadius="0.75rem" />
      </div>
    </DelayedSkeleton>
  );
}

/** Cashflow / mortgage: title + toolbar + charts row. */
export function ChartsPageSkeleton() {
  return (
    <DelayedSkeleton>
      <div className="space-y-6 py-6">
        <Skeleton width="16rem" height="2.25rem" />
        <Skeleton height="3.5rem" borderRadius="0.75rem" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton height="22rem" borderRadius="0.75rem" className="lg:col-span-2" />
          <Skeleton height="22rem" borderRadius="0.75rem" />
        </div>
      </div>
    </DelayedSkeleton>
  );
}

/**
 * Split / budgets / bank: an optional title + a stack of rows. Pass
 * `showTitle={false}` when the page already renders its real header above the
 * loading region (so only the list is skeletonized).
 */
export function ListPageSkeleton({ rows = 5, showTitle = true }: { rows?: number; showTitle?: boolean }) {
  return (
    <DelayedSkeleton>
      <div className="space-y-4 py-6 max-w-3xl mx-auto">
        {showTitle && <Skeleton width="12rem" height="2rem" />}
        <div className="flex flex-col gap-3">
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} height="4rem" borderRadius="0.75rem" />
          ))}
        </div>
      </div>
    </DelayedSkeleton>
  );
}

/**
 * Home dashboard: glance tile + split-balances card + a few activity rows.
 * (Was two skeletons split around an always-mounted quick-add card; the card
 * was removed in favor of the global FAB, so one contiguous block is correct.)
 */
export function HomeSkeleton() {
  return (
    <DelayedSkeleton>
      <div className="w-full">
        <Skeleton height="6rem" borderRadius="0.75rem" className="mb-5 w-full" />
        <Skeleton height="9rem" borderRadius="0.75rem" className="mb-5 w-full" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} height="2.5rem" borderRadius="0.5rem" className="w-full" />
          ))}
        </div>
      </div>
    </DelayedSkeleton>
  );
}

/** Split group detail: the balance banner + a stack of expense rows. */
export function SplitDetailSkeleton() {
  return (
    <DelayedSkeleton>
      <div className="max-w-3xl mx-auto py-4 lg:py-6 space-y-4">
        <Skeleton height="4.5rem" borderRadius="0.75rem" className="w-full" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height="3.5rem" borderRadius="0.75rem" className="w-full" />
          ))}
        </div>
      </div>
    </DelayedSkeleton>
  );
}
