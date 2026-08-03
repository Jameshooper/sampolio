import type { DisplayMode, NavigationPage } from '@/types';

/**
 * Pure, server-safe resolution of the user-customizable mobile bottom-nav tabs.
 *
 * The bottom bar renders 1-4 user-chosen tabs plus a fixed "More" cell (which is
 * never part of the stored list). `UserPreferences.bottomNavIds` holds the
 * explicit choice; undefined ⇒ the per-display-mode default below. An explicit
 * choice wins in BOTH display modes — Simple-mode slimming only decides the
 * default, never overrides a deliberate pick.
 *
 * Shared by `BottomNav` (the real bar) and the Settings picker so the two can
 * never disagree.
 */

/**
 * Runtime mirror of the `NavigationPage` union (types/index.ts is type-only, so
 * the enumerable list has to live here), in `navItems` display order. The guard
 * below fails to compile if the union gains a member this array is missing.
 */
export const NAVIGATION_PAGE_IDS = [
  'home',
  'split',
  'overview',
  'cashflow',
  'mortgage',
  'budgets',
  'goals',
  'bank',
  'playground',
  'settings',
] as const satisfies readonly NavigationPage[];

type _AllPagesListed = NavigationPage extends (typeof NAVIGATION_PAGE_IDS)[number] ? true : never;
const _check: _AllPagesListed = true;
void _check;

/** Hard cap on user-chosen tabs — a 5th cell plus "More" stops being tappable at 375px. */
export const MAX_BOTTOM_NAV_TABS = 4;
/** At least one real tab must remain beside "More". */
export const MIN_BOTTOM_NAV_TABS = 1;

/** Default tabs in Advanced mode (the daily-driver views). */
export const DEFAULT_BOTTOM_NAV_IDS: readonly NavigationPage[] = ['home', 'split', 'overview', 'cashflow'];
/** Default tabs in Simple mode — Overview is hidden there, so Goals takes its slot. */
export const DEFAULT_BOTTOM_NAV_IDS_SIMPLE: readonly NavigationPage[] = ['home', 'split', 'cashflow', 'goals'];

const VALID_IDS: ReadonlySet<string> = new Set<string>(NAVIGATION_PAGE_IDS);

/**
 * The tabs to render: the sanitized custom list when it yields at least one
 * valid id, else the default for `displayMode`. Unknown ids are dropped,
 * duplicates collapse to their first occurrence, and the list is capped at
 * `MAX_BOTTOM_NAV_TABS`.
 */
export function resolveBottomNavIds(
  custom: readonly string[] | null | undefined,
  displayMode: DisplayMode | undefined,
): NavigationPage[] {
  const seen = new Set<string>();
  const cleaned: NavigationPage[] = [];
  for (const id of custom ?? []) {
    if (!VALID_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id as NavigationPage);
    if (cleaned.length >= MAX_BOTTOM_NAV_TABS) break;
  }
  if (cleaned.length > 0) return cleaned;
  const fallback = displayMode === 'simple' ? DEFAULT_BOTTOM_NAV_IDS_SIMPLE : DEFAULT_BOTTOM_NAV_IDS;
  return [...fallback];
}

/**
 * Add or remove `id`. Returns `null` when the change is not allowed (removing
 * the last remaining tab, or adding past `MAX_BOTTOM_NAV_TABS`) so callers can
 * treat it as a silent no-op.
 */
export function toggleBottomNavId(
  current: readonly NavigationPage[],
  id: NavigationPage,
): NavigationPage[] | null {
  if (current.includes(id)) {
    if (current.length <= MIN_BOTTOM_NAV_TABS) return null;
    return current.filter((x) => x !== id);
  }
  if (current.length >= MAX_BOTTOM_NAV_TABS) return null;
  return [...current, id];
}
