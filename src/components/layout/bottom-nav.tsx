'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from '@/components/providers/theme-provider';
import { navItems, isNavItemActive } from '@/components/layout/nav-config';
import { useAppContext } from '@/components/layout/app-layout';
import { MdMoreHoriz } from 'react-icons/md';

interface BottomNavProps {
    onOpenMore: () => void;
}

// Primary tabs (the daily-driver views). Bank / What If? / Settings live behind
// "More" (the drawer). Pulled from the shared nav-config by id so labels/icons
// never drift. Simple mode swaps Overview (hidden there) for Goals.
const PRIMARY_IDS = ['home', 'split', 'overview', 'cashflow'] as const;
const PRIMARY_IDS_SIMPLE = ['home', 'split', 'cashflow', 'goals'] as const;

/**
 * Fixed bottom tab bar for < lg screens. Five equal cells — four primary
 * sections plus "More" (opens the nav drawer). Each cell is a ≥44px touch
 * target. Sits at z-40 (below overlays).
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
    const isSimple = appContext?.displayMode === 'simple';

    const primaryIds: readonly string[] = isSimple ? PRIMARY_IDS_SIMPLE : PRIMARY_IDS;
    const primary = primaryIds.map((id) => navItems.find((n) => n.id === id)!).filter(Boolean);
    const activeIndex = primary.findIndex((item) => isNavItemActive(pathname, item.href));

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
                style={{ left: `calc(${activeIndex >= 0 ? activeIndex : 0} * 20% + 10%)` }}
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
