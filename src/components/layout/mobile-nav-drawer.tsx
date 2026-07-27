'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar } from 'primereact/sidebar';
import { Menu } from 'primereact/menu';
import { useTheme } from '@/components/providers/theme-provider';
import { isNavItemActive, useUserMenuItems, useVisibleNavItems } from '@/components/layout/nav-config';
import { BrandLogo } from '@/components/layout/brand-logo';

interface MobileNavDrawerProps {
    visible: boolean;
    onHide: () => void;
}

/**
 * Off-canvas navigation for < lg screens. Reuses the PrimeReact Sidebar pattern
 * already proven in entity-list-drawer (children + header prop + the built-in
 * close button) and the shared nav-config so it never drifts from the desktop
 * sidebar. Opened by both the top-bar hamburger and the bottom-nav "More" tab.
 */
export function MobileNavDrawer({ visible, onHide }: MobileNavDrawerProps) {
    const pathname = usePathname();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const userMenuItems = useUserMenuItems(onHide);
    const visibleNavItems = useVisibleNavItems();

    const header = (
        <Link href="/" onClick={onHide} className="flex items-center gap-2 no-underline">
            <BrandLogo size={30} className="shrink-0" />
            <span className={`text-2xl font-extrabold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>Sampolio</span>
        </Link>
    );

    return (
        <Sidebar
            visible={visible}
            onHide={onHide}
            position="left"
            header={header}
            className="w-[80vw] max-w-[20rem]"
            modal
            dismissable
        >
            <nav className="-mt-2">
                <ul className="space-y-1">
                    {visibleNavItems.map((item) => {
                        const active = isNavItemActive(pathname, item.href);
                        return (
                            <li key={item.id}>
                                <Link
                                    href={item.href}
                                    onClick={onHide}
                                    className={`flex items-center gap-3 px-3 py-3 rounded-lg transition-colors duration-150 no-underline ${active
                                        ? isDark ? 'bg-accent-400/20 text-accent-300 active:bg-accent-400/30' : 'bg-accent-100 text-accent-800 active:bg-accent-200'
                                        : isDark ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200 active:bg-gray-800' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 active:bg-gray-100'
                                        }`}
                                >
                                    {item.icon}
                                    <span className="font-medium">{item.label}</span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            </nav>

            {/* Account / preferences */}
            <div className={`mt-4 pt-2 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                <Menu model={userMenuItems} className="w-full border-none" />
            </div>
        </Sidebar>
    );
}
