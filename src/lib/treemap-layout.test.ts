import { describe, it, expect } from 'vitest';
import { computeTreemapLayout, type TreemapRect } from './treemap-layout';

/** Fraction of the 100 × 100 square one rect covers. */
const areaShare = (r: TreemapRect) => (r.w * r.h) / 10000;

describe('computeTreemapLayout', () => {
  it('returns nothing for an empty list', () => {
    expect(computeTreemapLayout([])).toEqual([]);
  });

  it('gives a single value the whole square', () => {
    expect(computeTreemapLayout([42])).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it('returns one rect per value, in input order', () => {
    const rects = computeTreemapLayout([50, 30, 20]);
    expect(rects).toHaveLength(3);
    // The first (largest) value must get the largest rect — order is preserved,
    // so index 0 is still the 50.
    expect(areaShare(rects[0])).toBeGreaterThan(areaShare(rects[1]));
    expect(areaShare(rects[1])).toBeGreaterThan(areaShare(rects[2]));
  });

  it('makes every rect area proportional to its value', () => {
    const values = [40, 25, 15, 10, 6, 4];
    const total = values.reduce((s, v) => s + v, 0);
    const rects = computeTreemapLayout(values);
    rects.forEach((r, i) => {
      expect(areaShare(r)).toBeCloseTo(values[i] / total, 6);
    });
    // …and together they tile the whole square.
    expect(rects.reduce((s, r) => s + areaShare(r), 0)).toBeCloseTo(1, 6);
  });

  it('keeps every rect inside the 100 × 100 square', () => {
    const rects = computeTreemapLayout([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.w).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(100 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('splits evenly (no NaN) when every value is zero', () => {
    const rects = computeTreemapLayout([0, 0, 0, 0]);
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      expect(Number.isNaN(r.x + r.y + r.w + r.h)).toBe(false);
      expect(areaShare(r)).toBeCloseTo(0.25, 6);
    }
  });

  it('clamps negative and non-finite values to zero but keeps their slot', () => {
    const rects = computeTreemapLayout([60, -10, Number.NaN, 40]);
    expect(rects).toHaveLength(4);
    for (const r of rects) expect(Number.isNaN(r.x + r.y + r.w + r.h)).toBe(false);
    expect(areaShare(rects[0])).toBeCloseTo(0.6, 6);
    expect(areaShare(rects[1])).toBeCloseTo(0, 6);
    expect(areaShare(rects[2])).toBeCloseTo(0, 6);
    expect(areaShare(rects[3])).toBeCloseTo(0.4, 6);
  });

  it('avoids degenerate slivers for a realistic descending set', () => {
    const rects = computeTreemapLayout([40, 25, 15, 10, 6, 4]);
    for (const r of rects) {
      const aspect = Math.max(r.w / r.h, r.h / r.w);
      expect(aspect).toBeLessThan(8);
    }
  });

  it('is deterministic', () => {
    const values = [12, 9, 7, 5, 3];
    expect(computeTreemapLayout(values)).toEqual(computeTreemapLayout(values));
  });
});
