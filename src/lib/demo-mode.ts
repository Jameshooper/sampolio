/**
 * Demo mode — a UI-only privacy toggle for showing the app to friends.
 *
 * When on, every monetary value rendered through `formatCurrency` (and its
 * wrappers, e.g. `formatCents`) is replaced by a fixed placeholder mask
 * (`€✱✱✱,✱✱`) so real balances never appear on screen or in a screenshot.
 * Chart *shapes* stay real — only their axis/label/tooltip text is masked,
 * because those go through `formatCurrency` too. The `/mortgage` and `/split`
 * pages are exempt: real values stay visible there (see `isDemoExemptPath`).
 *
 * Why a module-level flag instead of React state/context: `formatCurrency` is a
 * pure formatter invoked from hundreds of non-component call sites (chart option
 * builders, tooltip/label formatters, table cell renderers, CSV builders) that
 * cannot subscribe to a React context. A single process-wide boolean lets every
 * formatter branch synchronously. `AppLayout` is the sole writer: it syncs this
 * flag DURING RENDER (before returning JSX) from `demoMode && !isDemoExemptPath`,
 * so the very first paint after a toggle — or after a navigation onto/off an
 * exempt page — already formats with the correct setting (an effect would be one
 * paint late). The write is idempotent, so repeated render-phase calls under
 * StrictMode / concurrent re-renders are harmless.
 *
 * This module intentionally has zero imports so `constants.ts` can import it
 * without creating a cycle.
 *
 * The flag lives on `globalThis` (not a module-scoped `let`) on purpose: code
 * that formats money runs from several lazily-loaded chunks (route chunks, the
 * `next/dynamic` chart chunks), and a production bundler is allowed to
 * instantiate a shared module once per chunk graph. A module-local flag could
 * then be set in one instance (AppLayout's) while a chart chunk's tooltip
 * formatter reads another that never changes — masked/unmasked values that
 * survive a toggle until a full reload. One process-wide slot on `globalThis`
 * makes every copy of this module read and write the same boolean.
 */

const FLAG = '__sampolioDemoMask' as const;
type DemoGlobal = typeof globalThis & { [FLAG]?: boolean };

/** Set by AppLayout during render. Idempotent. */
export function setDemoMask(on: boolean): void {
  (globalThis as DemoGlobal)[FLAG] = on;
}

/** Whether monetary values should currently render masked. */
export function isDemoMasked(): boolean {
  return (globalThis as DemoGlobal)[FLAG] === true;
}

// Placeholder body: three + two U+2731 HEAVY ASTERISKs around a fi-FI decimal
// comma. The negative prefix is U+2212 MINUS SIGN, matching `formatCurrency`.
const MASK_BODY = '✱✱✱,✱✱';

/** `€✱✱✱,✱✱`, with a `−` (U+2212) prefix when the value is negative. */
export function maskMoney(symbol: string, isNegative: boolean): string {
  return `${isNegative ? '−' : ''}${symbol}${MASK_BODY}`;
}

/**
 * Pages where real monetary values stay visible even in demo mode: `/mortgage`
 * and `/split` (and their sub-paths). The match is exact-or-prefix-with-slash,
 * so unrelated paths that merely share a leading string (e.g. `/splitters`,
 * `/mortgages-fake`) are NOT exempt.
 */
export function isDemoExemptPath(pathname: string): boolean {
  const EXEMPT = ['/mortgage', '/split'];
  return EXEMPT.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

/** localStorage key for the persisted demo-mode preference ('1' = on). */
export const DEMO_MODE_STORAGE_KEY = 'demo-mode';
