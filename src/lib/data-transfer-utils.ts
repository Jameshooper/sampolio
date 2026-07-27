// Pure helpers for the Settings JSON export/import. No I/O.

/** Upsert `incoming` into `existing` by id: matching ids are replaced, new ids appended. */
export function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const merged = new Map<string, T>(existing.map((e) => [e.id, e]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

/**
 * Bank data is never exported, so an imported item may carry a
 * `paidByCardLinkId` that doesn't exist on the target instance. Left as-is the
 * expense would vanish from projections (the card exclusion filter drops it but
 * no card bill is ever injected for the unknown link) — strip unknown refs and
 * report how many were stripped so the import summary can warn.
 */
export function stripOrphanCardLinks<T extends { paidByCardLinkId?: string }>(
  items: T[],
  validLinkIds: Set<string>
): { items: T[]; strippedCount: number } {
  let strippedCount = 0;
  const cleaned = items.map((item) => {
    if (item.paidByCardLinkId && !validLinkIds.has(item.paidByCardLinkId)) {
      strippedCount++;
      return { ...item, paidByCardLinkId: undefined };
    }
    return item;
  });
  return { items: cleaned, strippedCount };
}
