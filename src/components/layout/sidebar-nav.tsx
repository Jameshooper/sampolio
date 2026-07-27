'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useRef } from 'react';
import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import { Tooltip } from 'primereact/tooltip';
import { useTheme } from '@/components/providers/theme-provider';
import { isNavItemActive, useUserMenuItems, useVisibleNavItems } from '@/components/layout/nav-config';
import { BrandLogo } from '@/components/layout/brand-logo';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { MdSearch, MdChevronRight, MdChevronLeft } from 'react-icons/md';

interface SidebarNavProps {
    onOpenCommandPalette: () => void;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}

export function SidebarNav({
    onOpenCommandPalette,
    collapsed = false,
    onToggleCollapse,
}: SidebarNavProps) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const { theme } = useTheme();
    const userMenuRef = useRef<Menu>(null);

    const isDark = theme === 'dark';

    const myId = session?.user?.id;
    const myName = session?.user?.name || 'User';
    const profiles = useUserProfiles(myId ? [myId] : []);
    const myAvatarUrl = myId ? profiles[myId]?.avatarUrl : undefined;

    const isActive = (href: string) => isNavItemActive(pathname, href);

    const userMenuItems = useUserMenuItems();
    const visibleNavItems = useVisibleNavItems();

    const expanded = !collapsed;

    return (
        <aside
            className={`hidden lg:flex fixed left-0 top-0 h-screen z-50 flex-col transition-all duration-300 border-r glass-chrome pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${expanded ? 'w-64' : 'w-16'}`}
        >
            {/* Logo */}
            <div className={`flex items-center h-16 px-4 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                <Link href="/" className="flex items-center gap-3 no-underline">
                    <BrandLogo size={30} className="shrink-0" />
                    {expanded && (
                        <h1 className={`text-2xl font-extrabold whitespace-nowrap ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                            Sampolio
                        </h1>
                    )}
                </Link>
            </div>

            {/* Quick Actions — check-in deliberately lives on Overview (and ⌘M /
                the palette), not here, to keep the chrome low-key. Styled as a
                nav row (not a PrimeReact Button) so it aligns and sizes exactly
                like the menu items below it. */}
            <div className="px-2 py-4">
                <button
                    type="button"
                    onClick={onOpenCommandPalette}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors duration-150 ${isDark
                        ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 active:bg-gray-800'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 active:bg-gray-100'
                        }`}
                    data-pr-tooltip={!expanded ? 'Search (⌘K)' : undefined}
                    data-pr-position="right"
                >
                    <MdSearch size={20} className="shrink-0" />
                    {expanded && <span className="font-medium whitespace-nowrap">Search</span>}
                </button>
            </div>

            {/* Navigation */}
            <nav className="flex-1 px-2 py-4">
                <ul className="space-y-1">
                    {visibleNavItems.map((item) => {
                        const active = isActive(item.href);
                        return (
                            <li key={item.id}>
                                <Link
                                    href={item.href}
                                    className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors duration-150 no-underline ${active
                                        ? isDark
                                            ? 'bg-accent-400/20 text-accent-300 active:bg-accent-400/30'
                                            : 'bg-accent-100 text-accent-800 active:bg-accent-200'
                                        : isDark
                                            ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 active:bg-gray-800'
                                            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 active:bg-gray-100'
                                        }`}
                                    data-pr-tooltip={!expanded ? item.label : undefined}
                                    data-pr-position="right"
                                >
                                    {item.icon}
                                    {expanded && (
                                        <span className="font-medium whitespace-nowrap">{item.label}</span>
                                    )}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </nav>

            {/* User Section — collapse toggle sits above the user button, full-width */}
            <div className={`mt-auto border-t ${isDark ? 'border-gray-700' : 'border-gray-200'} ${expanded ? 'p-3' : 'p-1'} overflow-hidden`}>
                {onToggleCollapse && (
                    <Button
                        icon={collapsed ? <MdChevronRight /> : <MdChevronLeft />}
                        label={expanded ? 'Collapse' : undefined}
                        text
                        severity="secondary"
                        size="small"
                        className={`w-full mb-1 overflow-hidden ${expanded ? 'justify-start' : 'justify-center !px-0'}`}
                        onClick={onToggleCollapse}
                        tooltip={!expanded ? 'Expand sidebar' : undefined}
                        tooltipOptions={{ position: 'right' }}
                    />
                )}
                <Menu model={userMenuItems} popup ref={userMenuRef} />
                <Button
                    className={`w-full overflow-hidden ${expanded ? 'justify-start' : 'justify-center !px-0'}`}
                    text
                    severity="secondary"
                    onClick={(e) => userMenuRef.current?.toggle(e)}
                    tooltip={!expanded ? myName : undefined}
                    tooltipOptions={{ position: 'right' }}
                >
                    <UserAvatar userId={myId ?? ''} name={myName} avatarUrl={myAvatarUrl} size={22} className="shrink-0" />
                    {expanded && (
                        <span className="ml-3 truncate">{myName}</span>
                    )}
                </Button>
            </div>

            <Tooltip target="[data-pr-tooltip]" />
        </aside>
    );
}
