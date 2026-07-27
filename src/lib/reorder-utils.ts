/**
 * Pure geometry + ordering helpers for the iOS-style "jiggle mode" reorder
 * primitive (`src/components/ui/jiggle-reorder.tsx`). No DOM, no React —
 * everything here is deterministic and unit-tested in reorder-utils.test.ts.
 *
 * All coordinates are along a single drag axis (x for horizontal chip rows,
 * y for vertical card lists); the hook feeds this module offsets/sizes it has
 * already projected onto that axis.
 */

/** Immutable move of one element; out-of-range indices return a copy of the
 * input array unchanged (never mutates the input). */
export function arrayMove<T>(items: readonly T[], from: number, to: number): T[] {
  const n = items.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) {
    return items.slice();
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Given pre-drag slot centers along the drag axis, the dragged item's original
 * index, and its current translated center, return the slot index it should
 * occupy (clamped to [0, centers.length-1]).
 *
 * Nearest-center: the target is the slot whose center is closest to the dragged
 * center, so the item swaps exactly when it passes the midpoint between two
 * slots. Exact-midpoint ties break toward the direction of travel (`from` tells
 * us which way we started), so movement always feels responsive.
 */
export function targetIndexFromCenters(
  centers: readonly number[],
  from: number,
  draggedCenter: number,
): number {
  const n = centers.length;
  if (n === 0) return 0;
  const clampedFrom = Math.max(0, Math.min(n - 1, from));
  const forward = draggedCenter >= (centers[clampedFrom] ?? draggedCenter);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(centers[i] - draggedCenter);
    // Strictly-closer always wins; on an exact tie prefer the later index only
    // while travelling forward (so the item keeps advancing at the midpoint).
    if (d < bestDist || (d === bestDist && forward)) {
      bestDist = d;
      best = i;
    }
  }
  return Math.max(0, Math.min(n - 1, best));
}

/**
 * Per-sibling translate (px) while the item at `from` hovers slot `to`: items
 * strictly between the two slots shift by ±slotSpan (the dragged item's own
 * size + gap) to open a gap at `to`; every other item — including the dragged
 * item itself — gets 0 (the dragged item is translated separately by the drag
 * transform). Returns an array of length `count`.
 */
export function siblingOffsets(count: number, from: number, to: number, slotSpan: number): number[] {
  const out = new Array<number>(count).fill(0);
  if (from === to) return out;
  if (to > from) {
    // Dragged item moves forward; items in (from, to] slide back to fill it.
    for (let i = from + 1; i <= to && i < count; i++) out[i] = -slotSpan;
  } else {
    // Dragged item moves backward; items in [to, from) slide forward.
    for (let i = Math.max(0, to); i < from && i < count; i++) out[i] = slotSpan;
  }
  return out;
}

/**
 * Curated-order sort: ids present in `order` come first (by their order index,
 * first occurrence wins), then unknown ids in their original insertion order;
 * stale order ids (not in `items`) are ignored. Stable within each group.
 * Returns the input array by identity (same reference) when `order` is
 * undefined or empty, so callers can cheaply detect "no curated order".
 */
export function sortByPreferredOrder<T>(
  items: readonly T[],
  getId: (t: T) => string,
  order: string[] | undefined,
): T[] {
  if (!order || order.length === 0) return items as T[];
  const rank = new Map<string, number>();
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i); // first occurrence wins
  });
  const known: { item: T; r: number; idx: number }[] = [];
  const unknown: T[] = [];
  items.forEach((item, idx) => {
    const r = rank.get(getId(item));
    if (r === undefined) unknown.push(item);
    else known.push({ item, r, idx });
  });
  known.sort((a, b) => a.r - b.r || a.idx - b.idx);
  return [...known.map((k) => k.item), ...unknown];
}
