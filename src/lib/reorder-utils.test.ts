import { describe, it, expect } from 'vitest';
import { arrayMove, targetIndexFromCenters, siblingOffsets, sortByPreferredOrder } from './reorder-utils';

describe('arrayMove', () => {
  it('moves an element forward', () => {
    expect(arrayMove(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an element backward', () => {
    expect(arrayMove(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('is a no-op (copy) when from === to', () => {
    const arr = ['a', 'b', 'c'];
    const out = arrayMove(arr, 1, 1);
    expect(out).toEqual(arr);
    expect(out).not.toBe(arr); // immutable — never returns the input reference
  });

  it('returns an unchanged copy for out-of-range indices', () => {
    const arr = ['a', 'b', 'c'];
    expect(arrayMove(arr, -1, 0)).toEqual(arr);
    expect(arrayMove(arr, 0, 5)).toEqual(arr);
    expect(arrayMove(arr, 9, 9)).toEqual(arr);
  });

  it('never mutates the input', () => {
    const arr = ['a', 'b', 'c', 'd'];
    arrayMove(arr, 0, 3);
    expect(arr).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('targetIndexFromCenters', () => {
  const centers = [50, 150, 250, 350]; // 4 uniform 100px slots

  it('keeps the item in place near its own center', () => {
    expect(targetIndexFromCenters(centers, 0, 60)).toBe(0);
    expect(targetIndexFromCenters(centers, 2, 240)).toBe(2);
  });

  it('moves forward once the dragged center passes the midpoint', () => {
    expect(targetIndexFromCenters(centers, 0, 120)).toBe(1); // past midpoint 100
    expect(targetIndexFromCenters(centers, 0, 260)).toBe(2);
    expect(targetIndexFromCenters(centers, 0, 360)).toBe(3);
  });

  it('moves backward once the dragged center passes the midpoint', () => {
    expect(targetIndexFromCenters(centers, 3, 240)).toBe(2);
    expect(targetIndexFromCenters(centers, 3, 40)).toBe(0);
  });

  it('clamps beyond either end', () => {
    expect(targetIndexFromCenters(centers, 0, -500)).toBe(0);
    expect(targetIndexFromCenters(centers, 0, 5000)).toBe(3);
  });

  it('breaks an exact midpoint tie toward the direction of travel', () => {
    // draggedCenter 100 is equidistant from slot 0 (50) and slot 1 (150).
    expect(targetIndexFromCenters(centers, 0, 100)).toBe(1); // travelling forward → later slot
    expect(targetIndexFromCenters(centers, 3, 300)).toBe(2); // travelling backward → earlier slot
  });

  it('returns 0 for an empty centers array', () => {
    expect(targetIndexFromCenters([], 0, 123)).toBe(0);
  });
});

describe('siblingOffsets', () => {
  it('shifts the items between from and to back when moving forward', () => {
    // item 0 → slot 2: items 1 and 2 slide back by one slot; 0 and 3 unchanged.
    expect(siblingOffsets(4, 0, 2, 100)).toEqual([0, -100, -100, 0]);
  });

  it('shifts the items between to and from forward when moving backward', () => {
    // item 3 → slot 1: items 1 and 2 slide forward by one slot; 0 and 3 unchanged.
    expect(siblingOffsets(4, 3, 1, 100)).toEqual([0, 100, 100, 0]);
  });

  it('is all zeros when from === to (identity)', () => {
    expect(siblingOffsets(4, 2, 2, 100)).toEqual([0, 0, 0, 0]);
  });

  it('never assigns an offset to the dragged item itself', () => {
    expect(siblingOffsets(3, 0, 2, 50)[0]).toBe(0);
    expect(siblingOffsets(3, 2, 0, 50)[2]).toBe(0);
  });
});

describe('sortByPreferredOrder', () => {
  const id = (s: string) => s;

  it('returns the input by identity when order is undefined or empty', () => {
    const arr = ['a', 'b', 'c'];
    expect(sortByPreferredOrder(arr, id, undefined)).toBe(arr);
    expect(sortByPreferredOrder(arr, id, [])).toBe(arr);
  });

  it('orders known ids first, then unknowns in insertion order', () => {
    expect(sortByPreferredOrder(['a', 'b', 'c', 'd'], id, ['c', 'a'])).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores stale order ids not present in items', () => {
    expect(sortByPreferredOrder(['a', 'b'], id, ['z', 'b', 'x', 'a'])).toEqual(['b', 'a']);
  });

  it('honours first occurrence of a duplicated order id', () => {
    expect(sortByPreferredOrder(['a', 'b', 'c'], id, ['b', 'a', 'b'])).toEqual(['b', 'a', 'c']);
  });

  it('is stable among unknown ids', () => {
    expect(sortByPreferredOrder(['a', 'b', 'c', 'd'], id, ['b'])).toEqual(['b', 'a', 'c', 'd']);
  });
});
