import { describe, it, expect } from 'vitest';
import { mergeById, stripOrphanCardLinks } from './data-transfer-utils';

describe('mergeById', () => {
  it('replaces matching ids and appends new ones', () => {
    const existing = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    const incoming = [{ id: 'b', v: 20 }, { id: 'c', v: 3 }];
    expect(mergeById(existing, incoming)).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 20 },
      { id: 'c', v: 3 },
    ]);
  });

  it('handles empty sides', () => {
    expect(mergeById([], [{ id: 'x' }])).toEqual([{ id: 'x' }]);
    expect(mergeById([{ id: 'x' }], [])).toEqual([{ id: 'x' }]);
  });
});

describe('stripOrphanCardLinks', () => {
  it('strips refs to unknown links and counts them', () => {
    const items = [
      { id: '1', paidByCardLinkId: 'known' },
      { id: '2', paidByCardLinkId: 'unknown' },
      { id: '3' },
    ];
    const { items: cleaned, strippedCount } = stripOrphanCardLinks(items, new Set(['known']));
    expect(strippedCount).toBe(1);
    expect(cleaned[0].paidByCardLinkId).toBe('known');
    expect(cleaned[1].paidByCardLinkId).toBeUndefined();
    expect(cleaned[2].paidByCardLinkId).toBeUndefined();
  });

  it('is a no-op when all refs are valid', () => {
    const items = [{ id: '1', paidByCardLinkId: 'a' }];
    const { items: cleaned, strippedCount } = stripOrphanCardLinks(items, new Set(['a']));
    expect(strippedCount).toBe(0);
    expect(cleaned).toEqual(items);
  });
});
