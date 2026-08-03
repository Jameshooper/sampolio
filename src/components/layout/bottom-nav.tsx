'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from '@/components/providers/theme-provider';
import { navItems, isNavItemActive, type NavItem } from '@/components/layout/nav-config';
import { useAppContext } from '@/components/layout/app-layout';
import { resolveBottomNavIds } from '@/lib/bottom-nav-prefs';
import { MdMoreHoriz } from 'react-icons/md';

interface BottomNavProps {
    onOpenMore: () => void;
}

/**
 * Fixed bottom tab bar for < lg screens. N+1 equal cells — the user's 1-4 chosen
 * tabs plus "More" (opens the nav drawer, always the last cell). The tab list
 * comes from `resolveBottomNavIds` (per-display-mode defaults unless the user
 * picked their own in Settings → General → Mobile navigation); labels/icons are
 * pulled from the shared nav-config by id so they never drift. Each cell is a
 * ≥44px touch target. Sits at z-40 (below overlays).
 *
 * Height is `4rem + env(safe-area-inset-bottom)` with matching bottom padding, so
 * the 4rem content area is preserved and the inset extends the bar *below* it over
 * the iOS home indicator (in a standalone PWA). Do NOT use a fixed `h-16` plus the
 * inset padding — border-box sizing would subtract the inset from the 4rem and
 * squish the icons/labels. `<main>` reserves the same `4rem + inset` so content
 * never hides behind the bar.
 *
 * A small pill under the active cell slides between tabs (`left` animated with
 * `ease-fluid`) and fades out when no primary tab matches the current route
 * (e.g. on a "More" page like /settings or /bank).
 */
export function BottomNav({ onOpenMore }: BottomNavProps) {
    const pathname = usePathname();
    const { theme } = useTheme();
    const appContext = useAppContext();
    const isDark = theme === 'dark';

    const chosenIds = resolveBottomNavIds(appContext?.bottomNavIds, appContext?.displayMode);
    const primary = chosenIds
        .map((id) => navItems.find((n) => n.id === id))
        .filter((n): n is NavItem => Boolean(n));
    const activeIndex = primary.findIndex((item) => isNavItemActive(pathname, item.href));
    const cells = primary.length + 1; // +1 = the fixed More cell

    const cell = 'flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 h-full text-[0.7rem] font-medium transition-colors duration-150 active:opacity-60';
    const activeCls = isDark ? 'text-accent-400' : 'text-accent-700';
    const idleCls = isDark ? 'text-gray-400' : 'text-gray-500';

    return (
        <nav
            // No `relative` here: `fixed` already makes the nav the containing block
            // for the absolutely-positioned indicator (and `relative` would win the
            // cascade and un-fix the bar).
            className="lg:hidden fixed bottom-0 left-0 right-0 z-40 flex items-stretch h-[calc(4rem+env(safe-area-inset-bottom))] border-t pb-[env(safe-area-inset-bottom)] glass-chrome"
        >
            <span
                aria-hidden
                className={`absolute top-1 h-1 w-8 -translate-x-1/2 rounded-full transition-[left,opacity] duration-[250ms] ease-fluid ${isDark ? 'bg-accent-400' : 'bg-accent-700'} ${activeIndex >= 0 ? 'opacity-100' : 'opacity-0'}`}
                // Pill centers on the active cell: (index + 0.5) × cell width.
                style={{ left: `${((activeIndex >= 0 ? activeIndex : 0) + 0.5) * (100 / cells)}%` }}
            />
            {primary.map((item) => {
                const active = isNavItemActive(pathname, item.href);
                return (
                    <Link
                        key={item.id}
                        href={item.href}
                        className={`${cell} no-underline ${active ? activeCls : idleCls}`}
                    >
                        {item.icon}
                        <span className="truncate max-w-full px-0.5">{item.label}</span>
                    </Link>
                );
            })}
            <button type="button" onClick={onOpenMore} aria-label="More" className={`${cell} ${idleCls}`}>
                <MdMoreHoriz size={20} />
                <span>More</span>
            </button>
        </nav>
    );
}
