'use client';

import { useEffect, useRef } from 'react';

interface UseDwellSeenOptions {
  /** The ids to watch this run. Elements not currently in the DOM are skipped. */
  ids: string[];
  /** Resolve an id to its DOM element (or null if not mounted). */
  getElement: (id: string) => Element | null;
  /** Fired once an id has been continuously ≥50% visible for `dwellMs`. */
  onDwelled: (id: string) => void;
  /** Continuous-visibility threshold before firing (default 1600ms). */
  dwellMs?: number;
}

/**
 * Fire `onDwelled(id)` once an element has lingered on screen (≥50% visible for
 * a continuous `dwellMs`). A quick scroll-past never counts — leaving the
 * viewport clears that id's timer. Used to mark "new since last visit" split
 * rows as actually seen.
 *
 * One IntersectionObserver per effect run; the effect re-runs when the id set
 * changes (its join key is the dep). `onDwelled`/`getElement` are read through
 * refs so they needn't be referentially stable.
 */
export function useDwellSeen({ ids, getElement, onDwelled, dwellMs = 1600 }: UseDwellSeenOptions): void {
  const onDwelledRef = useRef(onDwelled);
  onDwelledRef.current = onDwelled;
  const getElementRef = useRef(getElement);
  getElementRef.current = getElement;

  const joinKey = ids.join('|');

  useEffect(() => {
    if (ids.length === 0 || typeof IntersectionObserver === 'undefined') return;

    const elementToId = new Map<Element, string>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = elementToId.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!timers.has(id)) {
              timers.set(
                id,
                setTimeout(() => {
                  timers.delete(id);
                  observer.unobserve(entry.target);
                  elementToId.delete(entry.target);
                  onDwelledRef.current(id);
                }, dwellMs),
              );
            }
          } else {
            // Left before dwelling — reset (dwell must be continuous).
            const t = timers.get(id);
            if (t) {
              clearTimeout(t);
              timers.delete(id);
            }
          }
        }
      },
      { threshold: 0.5 },
    );

    for (const id of ids) {
      const el = getElementRef.current(id);
      if (!el) continue; // not in the DOM this run
      elementToId.set(el, id);
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      for (const t of timers.values()) clearTimeout(t);
    };
    // ids is intentionally excluded — joinKey is its stable stand-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinKey, dwellMs]);
}
