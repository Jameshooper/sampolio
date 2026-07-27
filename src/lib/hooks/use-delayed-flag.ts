'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `true` only after `active` has stayed `true` for `delayMs`, and flips
 * back to `false` the instant `active` goes false.
 *
 * This is the "spinner only after a short delay" behavior: gate loading
 * indicators (spinners, skeletons) on this so that fast operations — which are
 * now the common case after the HKDF encryption fix — never flash a spinner
 * (the UI feels instant), while genuinely slow ones still get feedback.
 *
 *   const loading = isFetching;
 *   const showSpinner = useDelayedFlag(loading); // 300ms default
 *   {showSpinner && <ProgressSpinner />}
 */
export function useDelayedFlag(active: boolean, delayMs = 300): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setShown(true), delayMs);
    // Cleanup runs when `active` turns off (or deps change): cancel the pending
    // reveal and reset, so the next activation waits the full delay again. This
    // is a deferred (cleanup) setState, not a synchronous in-body one.
    return () => {
      clearTimeout(t);
      setShown(false);
    };
  }, [active, delayMs]);

  // Gate on `active` too, so the flag drops to false the instant `active` does —
  // before the cleanup's reset lands — preventing a stale spinner flash.
  return active && shown;
}
