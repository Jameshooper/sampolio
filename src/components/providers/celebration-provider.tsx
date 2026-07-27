'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from '@/lib/hooks/use-reduced-motion';

/**
 * App-wide success celebrations: a checkmark pop (expense created) and a
 * confetti burst (settled up). Mounted once by AppLayout; any client component
 * fires one via useCelebration().
 *
 * `celebrate(kind)` returns whether a visual was actually shown — it returns
 * false under reduced motion (nothing mounts), so callers fall back to their
 * quieter feedback (a row flash + toast). Both effects are pointer-events-none
 * and sit at z-[2000], above PrimeReact dialog masks, so a dialog left open by
 * "Save & add another" keeps working underneath.
 */
type CelebrationKind = 'checkmark' | 'confetti';

/** One burst particle's outward direction/distance (deterministic — fixed
 * angles, no Math.random at render) plus its stagger delay and accent color,
 * fed to `.celebrate-dot` as inline `--dx`/`--dy` custom properties. Six dots
 * at 60° apart, alternating radius for a slightly organic (not perfectly
 * uniform) burst, alternating color for a touch of variety. */
const CHECK_DOT_COUNT = 6;
const CHECK_DOTS = Array.from({ length: CHECK_DOT_COUNT }, (_, i) => {
  const angle = ((i * 360) / CHECK_DOT_COUNT - 90) * (Math.PI / 180);
  const radius = i % 2 === 0 ? 55 : 70;
  return {
    dx: Math.round(Math.cos(angle) * radius),
    dy: Math.round(Math.sin(angle) * radius),
    delay: 220 + i * 15,
    accent: i % 3 === 1,
  };
});

interface CelebrationContextValue {
  celebrate: (kind: CelebrationKind) => boolean;
}

const CelebrationContext = createContext<CelebrationContextValue | null>(null);

export function CelebrationProvider({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();

  // Each celebrate bumps a token; the token is the overlay's React key, so a
  // rapid second call remounts a fresh overlay and re-plays the animation.
  const [checkToken, setCheckToken] = useState(0);
  const [checkVisible, setCheckVisible] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [confettiToken, setConfettiToken] = useState(0);
  const [confettiVisible, setConfettiVisible] = useState(false);

  const celebrate = useCallback(
    (kind: CelebrationKind): boolean => {
      if (reduced) return false;
      if (kind === 'checkmark') {
        setCheckToken((t) => t + 1);
        setCheckVisible(true);
        if (checkTimer.current) clearTimeout(checkTimer.current);
        // Badge pop runs ~1500ms (celebrate-pop) with the ring/dots finishing
        // sooner; unmount just after the badge's own fade-out completes.
        checkTimer.current = setTimeout(() => setCheckVisible(false), 1550);
      } else {
        // A re-trigger while active bumps the key → ConfettiBurst remounts and
        // resets its particle array.
        setConfettiToken((t) => t + 1);
        setConfettiVisible(true);
      }
      return true;
    },
    [reduced],
  );

  useEffect(
    () => () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    },
    [],
  );

  const dismissConfetti = useCallback(() => setConfettiVisible(false), []);
  const value = useMemo(() => ({ celebrate }), [celebrate]);

  return (
    <CelebrationContext.Provider value={value}>
      {children}
      {checkVisible && (
        <div
          key={checkToken}
          className="fixed inset-0 z-[2000] pointer-events-none flex items-center justify-center"
          aria-hidden
        >
          <div className="celebrate-container">
            <div className="celebrate-ring" />
            {CHECK_DOTS.map((d, i) => (
              <div
                key={i}
                className="celebrate-dot"
                style={
                  {
                    '--dx': `${d.dx}px`,
                    '--dy': `${d.dy}px`,
                    animationDelay: `${d.delay}ms`,
                    backgroundColor: d.accent ? 'var(--primary-color)' : 'var(--green-500, #22c55e)',
                  } as React.CSSProperties & { '--dx': string; '--dy': string }
                }
              />
            ))}
            <div className="celebrate-badge">
              <svg viewBox="0 0 52 52" width="34" height="34">
                <path
                  className="celebrate-check"
                  fill="none"
                  stroke="white"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M14 27l8 8 16-18"
                  pathLength="100"
                />
              </svg>
            </div>
          </div>
        </div>
      )}
      {confettiVisible && <ConfettiBurst key={confettiToken} onDone={dismissConfetti} />}
    </CelebrationContext.Provider>
  );
}

/**
 * A one-shot, dependency-free confetti burst on a full-viewport canvas. Runs a
 * ~1.5s rAF loop (gravity + drag + spin, alpha ramp over the final 300ms) then
 * clears itself and calls onDone to unmount. Cancels + clears on effect
 * teardown too (e.g. a re-trigger remount, or the provider unmounting).
 */
function ConfettiBurst({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // onDone is a stable callback from the provider, so the burst runs once on
  // mount; a re-trigger remounts this component (fresh key) rather than re-running.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.scale(dpr, dpr);

    const primary =
      getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#673ab7';
    const colors = [primary, '#f59e0b', '#10b981', '#3b82f6', '#ec4899'];
    const rand = (min: number, max: number) => min + Math.random() * (max - min);

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      size: number;
      color: string;
      circle: boolean;
      angle: number;
      spin: number;
    }
    const particles: Particle[] = Array.from({ length: 70 }, () => ({
      x: w / 2 + rand(-50, 50),
      y: h * 0.6,
      vx: rand(-6, 6),
      vy: rand(-13, -6),
      size: rand(4, 8),
      color: colors[Math.floor(Math.random() * colors.length)],
      circle: Math.random() < 0.5,
      angle: rand(0, Math.PI * 2),
      spin: rand(-0.3, 0.3),
    }));

    const DURATION = 1500;
    const FADE = 300;
    const start = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = elapsed > DURATION - FADE ? Math.max(0, (DURATION - elapsed) / FADE) : 1;
      for (const p of particles) {
        p.vy += 0.26; // gravity (lighter than before so particles stay aloft over the longer ~1.5s run)
        p.vx *= 0.99; // drag
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        if (p.circle) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        }
        ctx.restore();
      }
      if (elapsed < DURATION) {
        raf = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, w, h);
        onDone();
      }
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, w, h);
    };
  }, [onDone]);

  return <canvas ref={canvasRef} className="fixed inset-0 z-[2000] pointer-events-none w-full h-full" aria-hidden />;
}

/** Access the app-wide celebration. Safe outside the provider (no-op → false). */
export function useCelebration(): CelebrationContextValue {
  const ctx = useContext(CelebrationContext);
  return ctx ?? { celebrate: () => false };
}
