'use client';

import { SessionProvider } from 'next-auth/react';
import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, startTransition } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { SidebarNav } from './sidebar-nav';
import { MobileTopBar } from './mobile-top-bar';
import { BottomNav } from './bottom-nav';
import { MobileNavDrawer } from './mobile-nav-drawer';
import { CommandPalette, useCommandPalette } from '@/components/ui/command-palette';
import { ReconcileWizard } from '@/components/reconcile/reconcile-wizard';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';
import { EntityModalRouter } from '@/components/ui/entity-modal-router';
import { ConfirmDialog } from 'primereact/confirmdialog';
import { ToastProvider } from '@/components/providers/toast-provider';
import { CelebrationProvider } from '@/components/providers/celebration-provider';
import { CheckinNotifier } from '@/components/providers/checkin-notifier';
import { getAccounts } from '@/lib/actions/accounts';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { MdAdd, MdVisibilityOff } from 'react-icons/md';
import { isDemoExemptPath, setDemoMask, DEMO_MODE_STORAGE_KEY } from '@/lib/demo-mode';
import type { FinancialAccount, DrawerState, DisplayMode } from '@/types';

interface AppLayoutProps {
    children: React.ReactNode;
}

// Context to communicate with pages for data refresh and drawer control
interface AppContextValue {
    refreshData: () => void;
    setRefreshCallback: (cb: () => void) => void;
    selectedAccountId: string;
    setSelectedAccountId: (id: string) => void;
    accounts: FinancialAccount[];
    // Drawer control
    drawerState: DrawerState;
    openDrawer: (options: Partial<DrawerState>) => void;
    closeDrawer: () => void;
    // Reconcile wizard
    openReconcile: () => void;
    // Selected month for cashflow
    selectedYearMonth: string;
    setSelectedYearMonth: (ym: string) => void;
    // Sidebar collapsed state
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (collapsed: boolean) => void;
    // Display mode
    displayMode: DisplayMode;
    setDisplayMode: (mode: DisplayMode) => void;
    // Demo mode (UI-only monetary masking for showing the app to friends)
    demoMode: boolean;
    /** Whether values render masked right now (demoMode AND not on an exempt page). */
    demoMasked: boolean;
    setDemoMode: (on: boolean) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
    return useContext(AppContext);
}

const initialDrawerState: DrawerState = {
    isOpen: false,
    mode: 'view',
};

export function AppLayout({ children }: AppLayoutProps) {
    const router = useRouter();

    // Reconcile wizard state
    const [reconcileVisible, setReconcileVisible] = useState(false);
    const handleOpenReconcile = useCallback(() => {
        setReconcileVisible(true);
    }, []);

    // Mobile nav drawer (opened by the top-bar hamburger and the bottom-nav "More")
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
    const [selectedAccountId, setSelectedAccountId] = useState<string>('');
    const [refreshCallback, setRefreshCallback] = useState<(() => void) | null>(null);
    const [drawerState, setDrawerState] = useState<DrawerState>(initialDrawerState);
    const [selectedYearMonth, setSelectedYearMonth] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('sidebar-collapsed') === 'true';
        }
        return false;
    });
    // Demo mode — persisted like sidebarCollapsed (lazy initializer + window guard)
    // so the first client render already reflects the saved preference.
    const [demoMode, setDemoModeState] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem(DEMO_MODE_STORAGE_KEY) === '1';
        }
        return false;
    });
    const setDemoMode = useCallback((on: boolean) => {
        setDemoModeState(on);
        if (typeof window !== 'undefined') {
            localStorage.setItem(DEMO_MODE_STORAGE_KEY, on ? '1' : '0');
        }
    }, []);
    // Cross-tab/window sync: toggling demo mode in one tab (e.g. the installed
    // PWA window) updates every other open tab — without this, another tab's
    // React state and the shared mask flag would disagree with localStorage
    // until a full reload there.
    useEffect(() => {
        const onStorage = (e: StorageEvent) => {
            if (e.key === DEMO_MODE_STORAGE_KEY) setDemoModeState(e.newValue === '1');
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    const openDrawer = useCallback((options: Partial<DrawerState>) => {
        setDrawerState({
            isOpen: true,
            mode: options.mode || 'view',
            entityType: options.entityType,
            entityId: options.entityId,
            yearMonth: options.yearMonth,
        });
    }, []);

    const closeDrawer = useCallback(() => {
        setDrawerState(initialDrawerState);
    }, []);

    // AppLayout persists across route changes, so an entity modal / wizard /
    // nav drawer opened on one page would otherwise survive navigation and sit
    // (with its blocking mask) over the next page — the "stuck modal after
    // going back" bug. Close every layout-owned overlay whenever the route
    // actually changes.
    const pathname = usePathname();
    const prevPathnameRef = useRef(pathname);
    useEffect(() => {
        if (prevPathnameRef.current === pathname) return;
        prevPathnameRef.current = pathname;
        setDrawerState(initialDrawerState);
        setMobileNavOpen(false);
        setReconcileVisible(false);
    }, [pathname]);

    // Render-phase sync of the process-wide demo mask (see src/lib/demo-mode.ts).
    // Money formatters are pure and can't subscribe to React state, so AppLayout
    // pushes the effective flag here — DURING render, before returning JSX — so
    // the first paint after a toggle (or after navigating onto/off an exempt
    // page) already formats correctly; an effect would be one paint late. The
    // write is idempotent, hence safe under StrictMode / concurrent re-renders.
    const demoMasked = demoMode && !isDemoExemptPath(pathname);
    setDemoMask(demoMasked);

    // Keyboard shortcuts — declared after openDrawer/selectedYearMonth
    const commandPalette = useCommandPalette({
        onReconcile: handleOpenReconcile,
        onAddIncome: useCallback(() => openDrawer({ mode: 'create', entityType: 'income', yearMonth: selectedYearMonth }), [openDrawer, selectedYearMonth]),
        onAddExpense: useCallback(() => openDrawer({ mode: 'create', entityType: 'expense', yearMonth: selectedYearMonth }), [openDrawer, selectedYearMonth]),
    });

    const handleToggleSidebar = useCallback(() => {
        setSidebarCollapsed(prev => {
            const next = !prev;
            localStorage.setItem('sidebar-collapsed', String(next));
            return next;
        });
    }, []);

    // Display mode
    const [displayMode, setDisplayModeState] = useState<DisplayMode>('advanced');
    const setDisplayMode = useCallback(async (mode: DisplayMode) => {
        setDisplayModeState(mode);
        const { updateDisplayMode } = await import('@/lib/actions/user-preferences');
        await updateDisplayMode(mode);
    }, []);

    // Onboarding wizard state
    const [showOnboarding, setShowOnboarding] = useState(false);

    useEffect(() => {
        getUserPreferences().then(result => {
            if (result.success && result.data) {
                if (!result.data.hasCompletedOnboarding) {
                    setShowOnboarding(true);
                }
                if (result.data.displayMode) {
                    setDisplayModeState(result.data.displayMode);
                } else if (!result.data.hasCompletedOnboarding) {
                    // New users start in Simple mode (onboarding lets them pick and
                    // persists the choice); accounts that predate the mode keep Advanced.
                    setDisplayModeState('simple');
                }
            }
        });
    }, []);

    // Fetch accounts
    const fetchAccounts = useCallback(async () => {
        try {
            const result = await getAccounts();
            if (result.success && result.data) {
                const activeAccounts = result.data.filter((a: FinancialAccount) => !a.isArchived);
                startTransition(() => {
                    setAccounts(result.data!);
                    if (activeAccounts.length > 0 && !selectedAccountId) {
                        setSelectedAccountId(activeAccounts[0].id);
                    }
                });
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
    }, [selectedAccountId]);

    useEffect(() => {
        let isMounted = true;
        if (isMounted) {
            fetchAccounts();
        }
        return () => {
            isMounted = false;
        };
    }, [fetchAccounts]);

    const handleDataChange = useCallback(() => {
        fetchAccounts();
        refreshCallback?.();
    }, [fetchAccounts, refreshCallback]);

    const handleAddItem = (type: 'income' | 'expense', yearMonth?: string) => {
        openDrawer({
            mode: 'create',
            entityType: type === 'income' ? 'income' : 'expense',
            yearMonth: yearMonth || selectedYearMonth,
        });
    };

    const openSplitQuickAdd = useCallback(
        () => openDrawer({ mode: 'create', entityType: 'split-expense' }),
        [openDrawer],
    );

    // Stable identity across renders — pages depend on this via `appContext` in
    // effect deps, so a fresh closure every render (the old inline arrow) caused
    // an infinite fetch-on-mount loop (see contextValue below).
    const registerRefreshCallback = useCallback((cb: () => void) => setRefreshCallback(() => cb), []);

    // Pages read `appContext` in mount-effect deps (to register their refresh
    // callback) — an un-memoized object literal here is a new reference every
    // AppLayout render, re-running those effects and re-triggering their
    // fetch + setRefreshCallback, which re-renders AppLayout: an infinite loop
    // that flickered the page's loading skeleton. Memoize with every value
    // referenced in the object listed as a dep.
    const contextValue: AppContextValue = useMemo(() => ({
        refreshData: handleDataChange,
        setRefreshCallback: registerRefreshCallback,
        selectedAccountId,
        setSelectedAccountId,
        accounts,
        drawerState,
        openDrawer,
        closeDrawer,
        openReconcile: handleOpenReconcile,
        selectedYearMonth,
        setSelectedYearMonth,
        sidebarCollapsed,
        setSidebarCollapsed,
        displayMode,
        setDisplayMode,
        demoMode,
        demoMasked,
        setDemoMode,
    }), [
        handleDataChange,
        registerRefreshCallback,
        selectedAccountId,
        setSelectedAccountId,
        accounts,
        drawerState,
        openDrawer,
        closeDrawer,
        handleOpenReconcile,
        selectedYearMonth,
        setSelectedYearMonth,
        sidebarCollapsed,
        setSidebarCollapsed,
        displayMode,
        setDisplayMode,
        demoMode,
        demoMasked,
        setDemoMode,
    ]);

    return (
        <SessionProvider>
            <AppContext.Provider value={contextValue}>
                <ToastProvider>
                <CelebrationProvider>
                {/* THE single global receiver for PrimeReact's imperative confirmDialog().
                    Never mount another <ConfirmDialog /> in a page/component: every
                    mounted receiver answers every confirmDialog() call, so duplicates
                    stack and the extra copy stays open after accept/reject. */}
                <ConfirmDialog />
                {/* Opt-in local check-in notification (renders nothing). */}
                <CheckinNotifier />
                <div className="min-h-screen bg-transparent">
                    {/* Desktop (lg+) sidebar */}
                    <SidebarNav
                        onOpenCommandPalette={commandPalette.open}
                        collapsed={sidebarCollapsed}
                        onToggleCollapse={handleToggleSidebar}
                    />

                    {/* Mobile (< lg) chrome */}
                    <MobileTopBar
                        onOpenMenu={() => setMobileNavOpen(true)}
                        onOpenCommandPalette={commandPalette.open}
                    />
                    <BottomNav onOpenMore={() => setMobileNavOpen(true)} />
                    <MobileNavDrawer visible={mobileNavOpen} onHide={() => setMobileNavOpen(false)} />

                    {/* Desktop-breakpoint installed PWA (e.g. iPad): the app runs
                        edge-to-edge under the OS status bar (viewport-fit=cover),
                        and the desktop layout has no mobile top bar to clear it.
                        Paint a glass strip under the status bar so scrolled
                        content never shows through the clock/battery area.
                        env() is 0 in a normal desktop browser — zero height. */}
                    <div className="hidden lg:block fixed top-0 inset-x-0 h-[env(safe-area-inset-top)] z-40 glass-chrome" />

                    {/* Demo-mode indicator pill — shown on ALL pages while demo mode
                        is on (including the exempt /mortgage & /split pages, where the
                        title notes amounts are still visible). Tap to turn it off.
                        z-45: above the mobile chrome (z-40), below overlays (z-50). */}
                    {demoMode && (
                        <button
                            type="button"
                            onClick={() => setDemoMode(false)}
                            title={
                                isDemoExemptPath(pathname)
                                    ? 'Demo mode — amounts visible on this page'
                                    : 'Demo mode — amounts hidden. Tap to show them again.'
                            }
                            aria-label="Demo mode active — tap to show amounts"
                            className="fixed z-[45] right-3 top-[calc(0.75rem+env(safe-area-inset-top))] rounded-full border surface-border bg-[var(--surface-card)]/80 backdrop-blur px-3 py-1.5 text-xs flex items-center gap-1.5 shadow-sm cursor-pointer"
                        >
                            <MdVisibilityOff size={14} />
                            <span>Demo</span>
                        </button>
                    )}

                    <main
                        className={`transition-all duration-300 pt-[calc(3.5rem+env(safe-area-inset-top))] pb-[calc(4rem+env(safe-area-inset-bottom))] lg:pt-[env(safe-area-inset-top)] lg:pb-[env(safe-area-inset-bottom)] ${sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'}`}
                    >
                        <div className="px-2 sm:px-4 lg:px-6">
                            {children}
                        </div>
                    </main>

                    {/* Command Palette */}
                    <CommandPalette
                        isOpen={commandPalette.isOpen}
                        onClose={commandPalette.close}
                        onNavigate={(path) => router.push(path)}
                        onAddItem={handleAddItem}
                        onReconcile={() => setReconcileVisible(true)}
                        onAddSplitExpense={openSplitQuickAdd}
                    />

                    {/* Entity Modal Router */}
                    <EntityModalRouter
                        drawerState={drawerState}
                        onClose={closeDrawer}
                        onDataChange={handleDataChange}
                        accounts={accounts}
                        selectedAccountId={selectedAccountId}
                        onAccountChange={setSelectedAccountId}
                    />

                    {/* Reconcile Wizard */}
                    <ReconcileWizard
                        visible={reconcileVisible}
                        onHide={() => setReconcileVisible(false)}
                        onComplete={handleDataChange}
                    />

                    {/* Onboarding Wizard */}
                    <OnboardingWizard
                        visible={showOnboarding}
                        onComplete={() => {
                            setShowOnboarding(false);
                            handleDataChange();
                        }}
                    />

                    {/* Global quick-add FAB for shared (split) expenses — the daily-driver
                        action, reachable from any page. Sits above the mobile bottom nav and
                        bottom-right on desktop; z-40 so PrimeReact overlays still cover it. */}
                    <button
                        type="button"
                        onClick={openSplitQuickAdd}
                        aria-label="Add shared expense"
                        className="fixed right-4 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)] lg:right-6 lg:bottom-6 z-40 flex items-center justify-center w-14 h-14 rounded-full bg-accent-600 hover:bg-accent-700 text-white shadow-lg transition-colors"
                    >
                        <MdAdd size={28} />
                    </button>
                </div>
                </CelebrationProvider>
                </ToastProvider>
            </AppContext.Provider>
        </SessionProvider>
    );
}
