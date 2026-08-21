/**
 * Pure binary-split ("slice and dice") treemap layout over a 100 × 100 unit
 * square. No React, no DOM — deterministic and unit-tested in
 * treemap-layout.test.ts.
 *
 * Callers get back one rect per input value, IN INPUT ORDER, with percentage
 * coordinates ready to drop straight into CSS (`left: ${x}%` …). Values are
 * expected to be positive and already in display order (typically descending by
 * size, which is what keeps the tiles compact); filtering out zero/negative
 * entries is the CALLER's job — anything non-positive (or non-finite) is clamped
 * to 0 here but KEEPS its slot, so the output index always matches the input
 * index (such a slot simply gets a zero-width or zero-height rect).
 */

/** One tile, in percent of the 100 × 100 square (`x + w <= 100`, same for y/h). */
export interface TreemapRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Full extent of the layout square, in the same percent units as the output. */
const SIDE = 100;

/**
 * Lay `values` out as a treemap: recursively split the list at the point where
 * the running sum first reaches half of the total (always leaving at least one
 * item on each side), hand the first part a slice of the rect proportional to
 * its sum along the LONGER side, and recurse into both halves.
 *
 * Total area is preserved exactly (the two halves always re-add to the parent),
 * and the result is deterministic for a given input.
 */
export function computeTreemapLayout(values: number[]): TreemapRect[] {
    if (values.length === 0) return [];
    const safe = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    const out: TreemapRect[] = new Array(safe.length);
    split(safe, 0, safe.length, { x: 0, y: 0, w: SIDE, h: SIDE }, out);
    return out;
}

/** Lay out `values[start, end)` inside `rect`, writing into `out` by index. */
function split(values: number[], start: number, end: number, rect: TreemapRect, out: TreemapRect[]): void {
    const count = end - start;
    if (count <= 0) return;
    if (count === 1) {
        out[start] = rect;
        return;
    }

    let total = 0;
    for (let i = start; i < end; i++) total += values[i];

    // Where to cut the list, and how much of the rect the first part gets.
    let cut: number;
    let fraction: number;
    if (total > 0) {
        const half = total / 2;
        let running = 0;
        let i = start;
        // Stop at end - 2 at the latest so the second part is never empty.
        for (; i < end - 1; i++) {
            running += values[i];
            if (running >= half) break;
        }
        // Clamp so the second part is never empty (the loop can run to the end
        // when the tail is all zeros and the running sum never reaches half).
        cut = Math.min(i + 1, end - 1);
        let firstSum = 0;
        for (let j = start; j < cut; j++) firstSum += values[j];
        fraction = firstSum / total;
    } else {
        // Nothing to weigh by: split the items evenly so every slot still gets
        // a real rect instead of NaN.
        cut = start + Math.ceil(count / 2);
        fraction = (cut - start) / count;
    }

    if (rect.w >= rect.h) {
        const firstW = rect.w * fraction;
        split(values, start, cut, { x: rect.x, y: rect.y, w: firstW, h: rect.h }, out);
        split(values, cut, end, { x: rect.x + firstW, y: rect.y, w: rect.w - firstW, h: rect.h }, out);
    } else {
        const firstH = rect.h * fraction;
        split(values, start, cut, { x: rect.x, y: rect.y, w: rect.w, h: firstH }, out);
        split(values, cut, end, { x: rect.x, y: rect.y + firstH, w: rect.w, h: rect.h - firstH }, out);
    }
}
