'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import type { MenuItem } from 'primereact/menuitem';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import type { NavigationPage } from '@/types';
import {
  MdHome, MdSpaceDashboard, MdSettings, MdLightMode, MdDarkMode, MdLogout,
  MdExplore, MdTune, MdHouse, MdLuggage, MdAccountBalance, MdInsights, MdGroups, MdFlag,
  MdVisibility, MdVisibilityOff,
} from 'react-icons/md';

export interface NavItem {
  id: NavigationPage;
  label: string;
  icon: ReactNode;
  href: string;
  /** Shown in Simple display mode. Hidden pages stay reachable from the Home
   *  feature grid, the command palette, and direct links. */
  simpleModeVisible?: boolean;
}

/**
 * Single source of truth for primary navigation, consumed by the desktop
 * sidebar, the mobile bottom-nav, and the mobile drawer. Order matters: the
 * bottom-nav shows the first N as tabs (see bottom-nav.tsx).
 */
export const navItems: NavItem[] = [
  { id: 'home', label: 'Home', icon: <MdHome size={20} />, href: '/', simpleModeVisible: true },
  { id: 'split', label: 'Split', icon: <MdGroups size={20} />, href: '/split', simpleModeVisible: true },
  { id: 'overview', label: 'Overview', icon: <MdSpaceDashboard size={20} />, href: '/overview' },
  { id: 'cashflow', label: 'Cashflow', icon: <MdInsights size={20} />, href: '/cashflow', simpleModeVisible: true },
  { id: 'mortgage', label: 'Mortgage', icon: <MdHouse size={20} />, href: '/mortgage' },
  { id: 'budgets', label: 'Trips & Budgets', icon: <MdLuggage size={20} />, href: '/budgets' },
  { id: 'goals', label: 'Goals', icon: <MdFlag size={20} />, href: '/goals', simpleModeVisible: true },
  { id: 'bank', label: 'Bank', icon: <MdAccountBalance size={20} />, href: '/bank' },
  { id: 'playground', label: 'What If?', icon: <MdExplore size={20} />, href: '/playground' },
  { id: 'settings', label: 'Settings', icon: <MdSettings size={20} />, href: '/settings', simpleModeVisible: true },
];

/**
 * The nav entries visible for the current display mode — every nav surface
 * (sidebar, bottom-nav tabs, mobile drawer) must render from this, never from
 * `navItems` directly, so Simple mode slims all surfaces at once.
 */
export function useVisibleNavItems(): NavItem[] {
  const appContext = useAppContext();
  const isSimple = appContext?.displayMode === 'simple';
  return isSimple ? navItems.filter((n) => n.simpleModeVisible) : navItems;
}

/** Active-route test shared by every nav surface. Home (`/`) matches exactly;
 * everything else matches by path prefix. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/' || pathname === '/dashboard';
  }
  return pathname.startsWith(href);
}

/**
 * Custom `template` for the actionable items (theme toggle, simple/advanced,
 * sign out): PrimeReact's built-in `.p-menuitem-icon` margin only applies to
 * the default (non-templated) render path, so react-icons JSX passed via
 * `icon` ends up touching the label. Renders the same anchor/label structure
 * (`options.className`/`options.onClick` per the v10 Menu template signature)
 * with an explicit gap instead.
 */
function actionItemTemplate(icon: ReactNode): MenuItem['template'] {
  return function ActionItemTemplate(item, options) {
    return (
      // Explicit padding: the theme pads menu items via its default
      // (non-templated) markup, so a templated anchor renders flush without it.
      <a className={`${options.className} px-3 py-2 cursor-pointer`} onClick={options.onClick}>
        <span className="flex items-center gap-2">
          {icon}
          <span className={options.labelClassName}>{item.label}</span>
        </span>
      </a>
    );
  };
}

/**
 * Builds the user-account menu model (clickable name/email/avatar header →
 * Settings › Account, theme toggle, simple/advanced, sign out). Shared by the
 * sidebar popup Menu and the mobile drawer so the two never drift.
 *
 * `onNavigate` (optional) fires after the header item routes to Settings — the
 * mobile drawer passes its `onHide` so the drawer closes on navigation; the
 * sidebar's popup Menu auto-closes on selection and passes nothing.
 */
export function useUserMenuItems(onNavigate?: () => void): MenuItem[] {
  const { data: session } = useSession();
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const appContext = useAppContext();
  const isDark = theme === 'dark';
  const isSimple = appContext?.displayMode === 'simple';
  const darkModeIcon = isDark ? <MdLightMode /> : <MdDarkMode />;
  const demoMode = appContext?.demoMode ?? false;
  // Icon reflects the target state (like the theme toggle): while demo mode is
  // on, the action shows amounts again (eye); while off, it hides them (eye-off).
  const demoIcon = demoMode ? <MdVisibility /> : <MdVisibilityOff />;

  const myId = session?.user?.id;
  const myName = session?.user?.name || 'User';
  const myEmail = session?.user?.email || '';
  const profiles = useUserProfiles(myId ? [myId] : []);
  const myAvatarUrl = myId ? profiles[myId]?.avatarUrl : undefined;

  return [
    {
      label: myName,
      // Clickable header → Settings › Account. Rendered via `options.className`
      // / `options.onClick` (the v10 Menu template signature, same as the
      // action items below) so it gets the theme's hover styling and cursor.
      command: () => {
        router.push('/settings?tab=account');
        onNavigate?.();
      },
      template: (item, options) => (
        <a className={`${options.className} px-3 py-2 cursor-pointer`} onClick={options.onClick}>
          <span className="flex items-center gap-3 max-w-[220px]">
            <UserAvatar userId={myId ?? ''} name={myName} avatarUrl={myAvatarUrl} size={36} className="shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-semibold truncate">{myName}</span>
              <span className="block text-xs opacity-70 truncate">{myEmail}</span>
            </span>
          </span>
        </a>
      ),
    },
    { separator: true },
    {
      label: isDark ? 'Light Mode' : 'Dark Mode',
      icon: darkModeIcon,
      command: toggleTheme,
      template: actionItemTemplate(darkModeIcon),
    },
    {
      label: isSimple ? 'Switch to Advanced' : 'Switch to Simple',
      icon: <MdTune />,
      command: () => appContext?.setDisplayMode(isSimple ? 'advanced' : 'simple'),
      template: actionItemTemplate(<MdTune />),
    },
    {
      label: demoMode ? 'Exit demo mode' : 'Demo mode (hide amounts)',
      icon: demoIcon,
      command: () => appContext?.setDemoMode(!demoMode),
      template: actionItemTemplate(demoIcon),
    },
    { separator: true },
    {
      label: 'Sign Out',
      icon: <MdLogout />,
      command: () => signOut({ callbackUrl: '/auth/signin' }),
      template: actionItemTemplate(<MdLogout />),
    },
  ];
}
