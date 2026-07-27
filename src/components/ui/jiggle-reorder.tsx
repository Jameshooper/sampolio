'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Button } from 'primereact/button';
import { arrayMove, siblingOffsets, targetIndexFromCenters } from '@/lib/reorder-utils';
import { useReducedMotion } from '@/lib/hooks/use-reduced-motion';

/**
 * iOS-style "jiggle mode" reorder. A long press enters a mode where every item
 * wobbles and any item can be dragged to a new slot; a floating "Done" bar (or
 * Escape) exits. The hook is id-based and mode-CONTROLLED — the bank page shares
 * one jiggle mode across two independent rows, so `jiggling` lives in the caller.
 *
 * Callers must wrap each item's visible content in an element carrying
 * `data-jiggle-inner` (the wobble rotation lives there; the drag translate lives
 * on the outer `data-jiggle-item`, so the two transforms never collide). See the
 * companion CSS block in `globals.css`.
 *
 * Design notes that are load-bearing on iOS PWA:
 * - React's synthetic touch handlers are passive, so a native `touchmove`
 *   listener with `{ passive: false }` is attached per item; only that listener
 *   can `preventDefault()` the in-flight gesture once dragging begins (changing
 *   `touch-action` mid-gesture does NOT stop a scroll the browser already owns).
 * - Live transforms are written straight to the DOM during a drag (no React
 *   re-render per pointermove); React only reorders on pointerup.
 */

export interface JiggleReorderOptions {
  /** Item ids in current display order; the hook is entirely id-based. */
  ids: readonly string[];
  axis: 'x' | 'y';
  /** CONTROLLED mode flag (shared across rows on the bank page). */
  jiggling: boolean;
  onJiggleChange: (next: boolean) => void;
  /** Fired on drop / arrow-key move with the reordered id list and the move. */
  onReorder: (nextIds: string[], move: { id: string; from: number; to: number }) => void;
  disabled?: boolean;
  /** Long-press duration to enter jiggle mode (ms). */
  longPressMs?: number;
}

export interface JiggleItemProps {
  ref: (el: HTMLElement | null) => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onClickCapture: (e: ReactMouseEvent) => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  draggable: false;
  style: CSSProperties;
  'data-jiggle-item': '';
  'data-dragging'?: '';
  tabIndex?: number;
  role?: 'button';
  'aria-roledescription'?: string;
  'aria-label'?: string;
}

export interface UseJiggleReorderResult {
  draggingId: string | null;
  containerProps: { ref: (el: HTMLElement | null) => void; 'data-jiggling'?: '' };
  getItemProps: (id: string) => JiggleItemProps;
}

const MOVE_SLOP_PX = 3; // slop before a jiggle-mode press turns into a drag
const CANCEL_SLOP_PX = 8; // movement that cancels a pending long press (lets scroll win)
const EDGE_ZONE_PX = 40; // pointer this close to a scroll edge triggers auto-scroll
const EDGE_SCROLL_STEP_PX = 8; // per-frame auto-scroll while held near an edge

type Mode = 'idle' | 'pending-longpress' | 'press-candidate' | 'dragging';

interface Gesture {
  mode: Mode;
  pointerId: number | null;
  startClientX: number;
  startClientY: number;
  lastClientX: number;
  lastClientY: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  fromIndex: number;
  draggedId: string | null;
  centers: number[];
  slotSpan: number;
  scrollStart: number;
  lastTo: number;
  touchEl: HTMLElement | null;
  touchHandler: ((e: TouchEvent) => void) | null;
  rafId: number | null;
}

function freshGesture(): Gesture {
  return {
    mode: 'idle',
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    lastClientX: 0,
    lastClientY: 0,
    longPressTimer: null,
    fromIndex: -1,
    draggedId: null,
    centers: [],
    slotSpan: 0,
    scrollStart: 0,
    lastTo: -1,
    touchEl: null,
    touchHandler: null,
    rafId: null,
  };
}

export function useJiggleReorder(opts: JiggleReorderOptions): UseJiggleReorderResult {
  const { axis, onJiggleChange, onReorder, disabled = false, longPressMs = 500 } = opts;
  const jiggling = opts.jiggling && !disabled;
  const reduced = useReducedMotion();

  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Latest props kept in refs so imperative gesture code (event handlers,
  // timers, rAF) never reads a stale closure (ids reorder on drop; jiggling
  // toggles from the parent). Written in an effect — never during render.
  const idsRef = useRef<readonly string[]>(opts.ids);
  const jigglingRef = useRef(jiggling);
  const callbacksRef = useRef({ onJiggleChange, onReorder });
  useEffect(() => {
    idsRef.current = opts.ids;
    jigglingRef.current = jiggling;
    callbacksRef.current = { onJiggleChange, onReorder };
  }, [opts.ids, jiggling, onJiggleChange, onReorder]);

  const containerElRef = useRef<HTMLElement | null>(null);
  const itemEls = useRef<Map<string, HTMLElement>>(new Map());
  const refCbCache = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());
  const suppressNextClick = useRef(false);
  const g = useRef<Gesture>(freshGesture());

  const containerRef = useCallback((el: HTMLElement | null) => {
    containerElRef.current = el;
  }, []);

  const getRefCb = useCallback((id: string) => {
    let cb = refCbCache.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) itemEls.current.set(id, el);
        else itemEls.current.delete(id);
      };
      refCbCache.current.set(id, cb);
    }
    return cb;
  }, []);

  // ---- axis helpers ----
  const clientAlongAxis = useCallback(
    (clientX: number, clientY: number) => (axis === 'x' ? clientX : clientY),
    [axis],
  );

  const clearItemTouchListener = useCallback(() => {
    const cur = g.current;
    if (cur.touchEl && cur.touchHandler) {
      cur.touchEl.removeEventListener('touchmove', cur.touchHandler);
    }
    cur.touchEl = null;
    cur.touchHandler = null;
  }, []);

  const stopAutoScroll = useCallback(() => {
    const cur = g.current;
    if (cur.rafId != null) {
      cancelAnimationFrame(cur.rafId);
      cur.rafId = null;
    }
  }, []);

  // Snapshot the pre-drag geometry of every item along the drag axis.
  const snapshotGeometry = useCallback(
    (fromIndex: number) => {
      const ids = idsRef.current;
      const centers: number[] = [];
      let draggedSize = 0;
      for (let i = 0; i < ids.length; i++) {
        const el = itemEls.current.get(ids[i]);
        if (!el) {
          centers.push(NaN);
          continue;
        }
        const start = axis === 'x' ? el.offsetLeft : el.offsetTop;
        const size = axis === 'x' ? el.offsetWidth : el.offsetHeight;
        centers.push(start + size / 2);
        if (i === fromIndex) draggedSize = size;
      }
      // slotSpan = typical centre-to-centre distance (= item size + gap for a
      // uniform row); average the finite adjacent deltas, fall back to the
      // dragged item's own size when there is only one item.
      const deltas: number[] = [];
      for (let i = 1; i < centers.length; i++) {
        const d = Math.abs(centers[i] - centers[i - 1]);
        if (Number.isFinite(d)) deltas.push(d);
      }
      const slotSpan = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : draggedSize;
      return { centers, slotSpan };
    },
    [axis],
  );

  // Write the live drag transform + sibling offsets straight to the DOM.
  const applyDragVisuals = useCallback(() => {
    const cur = g.current;
    if (cur.mode !== 'dragging' || cur.draggedId == null) return;
    const ids = idsRef.current;
    const from = cur.fromIndex;
    const draggedEl = itemEls.current.get(cur.draggedId);
    if (!draggedEl) return;

    const container = containerElRef.current;
    const scrollDelta = axis === 'x' && container ? container.scrollLeft - cur.scrollStart : 0;
    const pointerAxis = clientAlongAxis(cur.lastClientX, cur.lastClientY);
    const startAxis = clientAlongAxis(cur.startClientX, cur.startClientY);
    const translate = pointerAxis - startAxis + scrollDelta;

    draggedEl.style.transform = axis === 'x' ? `translateX(${translate}px)` : `translateY(${translate}px)`;

    const draggedCenter = (cur.centers[from] ?? 0) + translate;
    const to = targetIndexFromCenters(cur.centers, from, draggedCenter);
    cur.lastTo = to;

    const offsets = siblingOffsets(ids.length, from, to, cur.slotSpan);
    for (let i = 0; i < ids.length; i++) {
      if (i === from) continue;
      const el = itemEls.current.get(ids[i]);
      if (!el) continue;
      const off = offsets[i];
      el.style.transform = off ? (axis === 'x' ? `translateX(${off}px)` : `translateY(${off}px)`) : '';
    }
  }, [axis, clientAlongAxis]);

  // rAF edge auto-scroll (x axis only): keep scrolling while the pointer is
  // parked near a horizontal edge of the scroll container. The loop re-schedules
  // itself through `tickRef` (a latest-value ref) so the recursive reference
  // never reads a stale closure.
  const tickRef = useRef<() => void>(() => {});
  const tickAutoScroll = useCallback(() => {
    const cur = g.current;
    if (cur.mode !== 'dragging' || axis !== 'x') {
      cur.rafId = null;
      return;
    }
    const container = containerElRef.current;
    if (!container) {
      cur.rafId = null;
      return;
    }
    const rect = container.getBoundingClientRect();
    const x = cur.lastClientX;
    let dir = 0;
    if (x < rect.left + EDGE_ZONE_PX) dir = -1;
    else if (x > rect.right - EDGE_ZONE_PX) dir = 1;

    if (dir !== 0) {
      const before = container.scrollLeft;
      container.scrollLeft = before + dir * EDGE_SCROLL_STEP_PX;
      if (container.scrollLeft !== before) applyDragVisuals();
      cur.rafId = requestAnimationFrame(() => tickRef.current());
    } else {
      cur.rafId = null;
    }
  }, [axis, applyDragVisuals]);
  useEffect(() => {
    tickRef.current = tickAutoScroll;
  }, [tickAutoScroll]);

  const maybeStartAutoScroll = useCallback(() => {
    const cur = g.current;
    if (axis !== 'x' || cur.mode !== 'dragging' || cur.rafId != null) return;
    const container = containerElRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = cur.lastClientX;
    if (x < rect.left + EDGE_ZONE_PX || x > rect.right - EDGE_ZONE_PX) {
      cur.rafId = requestAnimationFrame(tickAutoScroll);
    }
  }, [axis, tickAutoScroll]);

  const cancelLongPress = useCallback(() => {
    const cur = g.current;
    if (cur.longPressTimer) {
      clearTimeout(cur.longPressTimer);
      cur.longPressTimer = null;
    }
  }, []);

  // Clear every inline transform with transitions suppressed, so the drop +
  // React reorder land in one paint with no snap-back animation; restore the
  // stylesheet transition on the next frame for the following drag.
  const clearAllTransforms = useCallback(() => {
    const els = Array.from(itemEls.current.values());
    for (const el of els) {
      el.style.transition = 'none';
      el.style.transform = '';
    }
    // Force a reflow so the "no transition" state is committed before the
    // stylesheet transition is handed back.
    if (els[0]) void els[0].offsetHeight;
    requestAnimationFrame(() => {
      for (const el of els) el.style.transition = '';
    });
  }, []);

  const endGesture = useCallback(() => {
    stopAutoScroll();
    cancelLongPress();
    clearItemTouchListener();
    const cur = g.current;
    if (cur.pointerId != null && cur.draggedId) {
      const el = itemEls.current.get(cur.draggedId);
      try {
        if (el && cur.pointerId != null) el.releasePointerCapture(cur.pointerId);
      } catch {
        /* capture may already be released */
      }
    }
    g.current = freshGesture();
  }, [stopAutoScroll, cancelLongPress, clearItemTouchListener]);

  const beginDrag = useCallback(
    (id: string, el: HTMLElement, pointerId: number) => {
      const ids = idsRef.current;
      const from = ids.indexOf(id);
      if (from < 0) return;
      const cur = g.current;
      const { centers, slotSpan } = snapshotGeometry(from);
      cur.mode = 'dragging';
      cur.fromIndex = from;
      cur.draggedId = id;
      cur.centers = centers;
      cur.slotSpan = slotSpan;
      cur.lastTo = from;
      cur.scrollStart = axis === 'x' && containerElRef.current ? containerElRef.current.scrollLeft : 0;
      try {
        el.setPointerCapture(pointerId);
      } catch {
        /* best effort */
      }
      setDraggingId(id);
      if (typeof navigator !== 'undefined') navigator.vibrate?.(10);
      applyDragVisuals();
    },
    [axis, snapshotGeometry, applyDragVisuals],
  );

  // ---- item pointer handlers ----
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent, id: string) => {
      if (disabled) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      const cur = g.current;
      if (cur.mode !== 'idle') return; // one gesture at a time

      // Drop any leftover suppression from a prior drag that never emitted a
      // trailing click (a click always fires before the next pointerdown, so a
      // still-set flag here is stale and would eat this fresh interaction).
      suppressNextClick.current = false;

      cur.pointerId = e.pointerId;
      cur.startClientX = e.clientX;
      cur.startClientY = e.clientY;
      cur.lastClientX = e.clientX;
      cur.lastClientY = e.clientY;

      // A native, non-passive touchmove listener: a no-op until dragging, then
      // the only reliable way to stop the browser from scrolling the gesture.
      const handler = (ev: TouchEvent) => {
        if (g.current.mode === 'dragging') ev.preventDefault();
      };
      el.addEventListener('touchmove', handler, { passive: false });
      cur.touchEl = el;
      cur.touchHandler = handler;

      if (jigglingRef.current) {
        // Already in jiggle mode: this press becomes a drag after a small slop.
        cur.mode = 'press-candidate';
      } else {
        // Idle: arm the long-press that enters jiggle mode + starts the drag.
        cur.mode = 'pending-longpress';
        cur.longPressTimer = setTimeout(() => {
          const c = g.current;
          if (c.mode !== 'pending-longpress') return;
          c.longPressTimer = null;
          callbacksRef.current.onJiggleChange(true);
          beginDrag(id, el, c.pointerId ?? e.pointerId);
        }, longPressMs);
      }
    },
    [disabled, longPressMs, beginDrag],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent, id: string) => {
      const cur = g.current;
      if (cur.mode === 'idle' || cur.pointerId !== e.pointerId) return;
      cur.lastClientX = e.clientX;
      cur.lastClientY = e.clientY;
      const dx = e.clientX - cur.startClientX;
      const dy = e.clientY - cur.startClientY;
      const dist = Math.hypot(dx, dy);

      if (cur.mode === 'pending-longpress') {
        // Moved before the long press fired → it was a scroll/tap, not a hold.
        if (dist > CANCEL_SLOP_PX) endGesture();
        return;
      }
      if (cur.mode === 'press-candidate') {
        if (dist > MOVE_SLOP_PX) {
          const el = e.currentTarget as HTMLElement;
          beginDrag(id, el, e.pointerId);
        }
        return;
      }
      if (cur.mode === 'dragging') {
        applyDragVisuals();
        maybeStartAutoScroll();
      }
    },
    [endGesture, beginDrag, applyDragVisuals, maybeStartAutoScroll],
  );

  const finishDrag = useCallback(() => {
    const cur = g.current;
    const from = cur.fromIndex;
    const to = cur.lastTo;
    const draggedId = cur.draggedId;
    const wasDragging = cur.mode === 'dragging' && draggedId != null;

    if (wasDragging) {
      suppressNextClick.current = true;
      clearAllTransforms();
      if (to !== from && to >= 0 && draggedId) {
        const ids = idsRef.current;
        callbacksRef.current.onReorder(arrayMove(ids, from, to), { id: draggedId, from, to });
      }
      setDraggingId(null);
    }
    endGesture();
  }, [clearAllTransforms, endGesture]);

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const cur = g.current;
      if (cur.pointerId !== e.pointerId) return;
      finishDrag();
    },
    [finishDrag],
  );

  const handlePointerCancel = useCallback(
    (e: ReactPointerEvent) => {
      const cur = g.current;
      if (cur.pointerId !== e.pointerId) return;
      // Revert transforms but stay in jiggle mode (per spec).
      if (cur.mode === 'dragging') {
        clearAllTransforms();
        setDraggingId(null);
      }
      endGesture();
    },
    [clearAllTransforms, endGesture],
  );

  const handleClickCapture = useCallback(
    (e: ReactMouseEvent) => {
      if (jigglingRef.current || suppressNextClick.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick.current = false;
      }
    },
    [],
  );

  const handleContextMenu = useCallback((e: ReactMouseEvent) => {
    const cur = g.current;
    if (jigglingRef.current || cur.mode === 'pending-longpress' || cur.mode === 'press-candidate' || cur.mode === 'dragging') {
      e.preventDefault();
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent, id: string) => {
      if (!jigglingRef.current) return;
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const fwd = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (e.key !== back && e.key !== fwd) return;
      const ids = idsRef.current;
      const from = ids.indexOf(id);
      if (from < 0) return;
      const to = e.key === fwd ? from + 1 : from - 1;
      if (to < 0 || to >= ids.length) return;
      e.preventDefault();
      callbacksRef.current.onReorder(arrayMove(ids, from, to), { id, from, to });
    },
    [axis],
  );

  // Escape exits jiggle mode.
  useEffect(() => {
    if (!jiggling) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') callbacksRef.current.onJiggleChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [jiggling]);

  // Tear the gesture down if jiggle mode is switched off mid-gesture, or on
  // unmount, so no timers/listeners leak.
  useEffect(() => {
    if (!jiggling && g.current.mode !== 'idle') {
      if (g.current.mode === 'dragging') {
        clearAllTransforms();
        // Reconcile React state with the external mode flag being switched off
        // mid-gesture (e.g. Escape); a rare defensive path, not a render loop.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraggingId(null);
      }
      endGesture();
    }
  }, [jiggling, clearAllTransforms, endGesture]);

  useEffect(() => endGesture, [endGesture]);

  const getItemProps = useCallback(
    (id: string): JiggleItemProps => {
      // Use the CURRENT render's ids here (not idsRef, which lags by one commit)
      // so the position label / wobble phase are correct right after a reorder.
      const ids = opts.ids;
      const index = ids.indexOf(id);
      const style: CSSProperties = {};
      if (!reduced) {
        (style as Record<string, string>)['--jiggle-phase'] = `${(Math.max(0, index) % 3) * -80}ms`;
      }
      if (draggingId === id) style.transition = 'none';

      const props: JiggleItemProps = {
        ref: getRefCb(id),
        onPointerDown: (e) => handlePointerDown(e, id),
        onPointerMove: (e) => handlePointerMove(e, id),
        onPointerUp: handlePointerUp,
        onPointerCancel: handlePointerCancel,
        onClickCapture: handleClickCapture,
        onContextMenu: handleContextMenu,
        onKeyDown: (e) => handleKeyDown(e, id),
        draggable: false,
        style,
        'data-jiggle-item': '',
      };
      if (draggingId === id) props['data-dragging'] = '';
      if (jiggling) {
        props.tabIndex = 0;
        props.role = 'button';
        props['aria-roledescription'] = 'reorderable item';
        props['aria-label'] = `Reorderable item ${Math.max(0, index) + 1} of ${ids.length}`;
      }
      return props;
    },
    [
      opts.ids,
      reduced,
      draggingId,
      jiggling,
      getRefCb,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      handlePointerCancel,
      handleClickCapture,
      handleContextMenu,
      handleKeyDown,
    ],
  );

  return {
    draggingId,
    containerProps: jiggling ? { ref: containerRef, 'data-jiggling': '' } : { ref: containerRef },
    getItemProps,
  };
}

/**
 * Floating "Drag to reorder … Done" bar shown while jiggle mode is active.
 * Renders nothing when inactive. The `animate-fade-in` entrance sits on the
 * INNER pill (never on the translated outer wrapper — a filled/transformed
 * entrance on a translated element is a CLAUDE.md motion no-no).
 */
export function JiggleModeBar({
  jiggling,
  onDone,
  hint = 'Drag to reorder',
}: {
  jiggling: boolean;
  onDone: () => void;
  hint?: string;
}): ReactNode {
  if (!jiggling) return null;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-50 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] lg:bottom-6">
      <div className="animate-fade-in flex items-center gap-3 rounded-full border surface-border bg-white/90 dark:bg-gray-800/90 backdrop-blur px-4 py-2 shadow-lg">
        <span className="sr-only" role="status" aria-live="polite">
          Reorder mode on — drag or use arrow keys; press Done to finish
        </span>
        <span className="text-sm font-medium">{hint}</span>
        <Button label="Done" size="small" severity="success" className="min-h-[44px]" onClick={onDone} />
      </div>
    </div>
  );
}
