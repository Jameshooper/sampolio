'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { InputSwitch } from 'primereact/inputswitch';
import { InputText } from 'primereact/inputtext';
import { InputNumber } from 'primereact/inputnumber';
import { Chip } from 'primereact/chip';
import { Divider } from 'primereact/divider';
import { Message } from 'primereact/message';
import { TabView, TabPanel } from 'primereact/tabview';
import { confirmDialog } from 'primereact/confirmdialog';
import { Checkbox } from 'primereact/checkbox';
import { Dialog } from 'primereact/dialog';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { getSettings, updateSettings, revalidateAllCaches } from '@/lib/actions/admin';
import { getUserPreferences, updateCategories, updateTaxDefaults, updateCheckInReminders, updateCheckInNotifications, updateSplitNotificationPrefs, getSplitNotifyStatus } from '@/lib/actions/user-preferences';
import { AlertBanner } from '@/components/ui/alert-banner';
import { MobileNavCard } from '@/components/settings/mobile-nav-card';
import { getAppVersion } from '@/lib/actions/app-info';
import { previewHistoryCompaction, compactHistory, type HistoryCompactionStats } from '@/lib/actions/maintenance';
import { exportUserData, importUserData } from '@/lib/actions/data-transfer';
import { downloadTextFile } from '@/lib/csv-utils';
import { ITEM_CATEGORIES } from '@/lib/constants';
import dynamic from 'next/dynamic';
import { DelayedSpinner } from '@/components/ui/delayed-loading';

// The banking panel is by far the heaviest settings panel — load it only when
// its tab is opened (TabView renders active-only by default).
const BankConnectionsPanel = dynamic(
    () => import('@/components/bank/bank-connections-panel').then((m) => m.BankConnectionsPanel),
    { ssr: false, loading: () => <DelayedSpinner /> }
);
const AccountPanel = dynamic(
    () => import('@/components/settings/account-panel').then((m) => m.AccountPanel),
    { ssr: false, loading: () => <DelayedSpinner /> }
);
import type { TaxDefaults, SplitNotifyEvent } from '@/types';
import { MdDownload, MdUpload, MdAccountBalanceWallet, MdAdd, MdCheck, MdGroup, MdCached, MdStorage, MdDeleteSweep } from 'react-icons/md';
import { FaGithub } from 'react-icons/fa';

/** Split push-notification events, in the order the Settings block lists them. */
const SPLIT_NOTIFY_TOGGLES: { key: SplitNotifyEvent; label: string }[] = [
    { key: 'expense.created', label: 'New expenses' },
    { key: 'expense.updated', label: 'Edited expenses' },
    { key: 'expense.deleted', label: 'Deleted expenses' },
    { key: 'payment.recorded', label: 'Settle-ups' },
    { key: 'expense.generated', label: 'Recurring expenses' },
];

function SettingsPageInner() {
    const { data: session } = useSession();
    // Reactive so a `?tab=…` deep-link switches the tab even when we're already
    // on /settings (e.g. the user-menu "Account" item navigating in place).
    const searchParams = useSearchParams();
    const { theme, toggleTheme } = useTheme();
    const appContext = useAppContext();
    const isDark = theme === 'dark';
    const isAdmin = session?.user?.role === 'admin';
    // Simple mode trims the maintenance-heavy tabs (Data & Storage, Admin);
    // switching to Advanced from the General tab brings them back.
    const isSimple = appContext?.displayMode === 'simple';
    const toast = useToast();

    const [selfSignupEnabled, setSelfSignupEnabled] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Categories state
    const [customCategories, setCustomCategories] = useState<string[]>([]);
    const [removedDefaults, setRemovedDefaults] = useState<string[]>([]);
    const [newCategoryName, setNewCategoryName] = useState('');
    const [isSavingCategories, setIsSavingCategories] = useState(false);

    // Tax defaults state
    const [taxDefaults, setTaxDefaults] = useState<TaxDefaults>({ taxRate: 0, contributionsRate: 0, otherDeductions: 0 });
    const [isSavingTax, setIsSavingTax] = useState(false);

    // Check-in reminder preference (default on)
    const [checkInReminders, setCheckInReminders] = useState(true);
    // Opt-in local device notification when the check-in is due (default off)
    const [checkInNotifications, setCheckInNotifications] = useState(false);

    // Split push notifications (Home Assistant webhook). Opt-OUT: an absent key
    // means enabled, so {} = everything on.
    const [splitNotifyPrefs, setSplitNotifyPrefs] = useState<Partial<Record<SplitNotifyEvent, boolean>>>({});
    // Assume configured until told otherwise, so the "not configured" note never
    // flashes on load.
    const [splitNotifyConfigured, setSplitNotifyConfigured] = useState(true);

    // App version
    const [appVersion, setAppVersion] = useState<string>('');

    // Cache revalidation state
    const [isRevalidating, setIsRevalidating] = useState(false);

    // Data export / import
    const [isExporting, setIsExporting] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [importCandidate, setImportCandidate] = useState<{ fileName: string; payload: unknown; accountCount: number } | null>(null);
    const [importReplaceMode, setImportReplaceMode] = useState(false);
    const importInputRef = useRef<HTMLInputElement>(null);

    // Data & storage (history compaction)
    const [compactPreview, setCompactPreview] = useState<HistoryCompactionStats | null>(null);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [isCompacting, setIsCompacting] = useState(false);
    const [compactMessage, setCompactMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // Active tab (deep-linkable via ?tab=general|finance|banking|data|admin|about)
    const [activeIndex, setActiveIndex] = useState(0);
    const tabKeys = ['general', 'finance', 'banking', ...(!isSimple ? ['data'] : []), ...(isAdmin && !isSimple ? ['admin'] : []), 'account', 'about'];

    // Active categories = built-in minus removed + custom
    const activeCategories = [
        ...ITEM_CATEGORIES.filter(c => !removedDefaults.includes(c)),
        ...customCategories,
    ];

    useEffect(() => {
        async function loadSettings() {
            if (isAdmin) {
                const result = await getSettings();
                if (result.success && result.data) {
                    setSelfSignupEnabled(result.data.selfSignupEnabled);
                }
            }
        }
        async function loadPreferences() {
            const result = await getUserPreferences();
            if (result.success && result.data) {
                setCustomCategories(result.data.customCategories ?? []);
                setRemovedDefaults(result.data.removedDefaultCategories ?? []);
                if (result.data.taxDefaults) {
                    setTaxDefaults(result.data.taxDefaults);
                }
                setCheckInReminders(result.data.checkInRemindersEnabled !== false);
                setCheckInNotifications(result.data.checkInNotificationsEnabled === true);
                setSplitNotifyPrefs(result.data.splitNotificationPrefs ?? {});
            }
        }
        async function loadSplitNotifyStatus() {
            const result = await getSplitNotifyStatus();
            if (result.success && result.data) {
                setSplitNotifyConfigured(result.data.configured);
            }
        }
        async function loadAppInfo() {
            const result = await getAppVersion();
            if (result.success) {
                setAppVersion(result.version);
            }
        }
        loadSettings();
        loadPreferences();
        loadSplitNotifyStatus();
        loadAppInfo();
    }, [isAdmin]);

    // Open the tab named in ?tab= (so links from other pages — and the user-menu
    // "Account" item — land on the right tab). tabKeys is the slug→index map for
    // the tabs actually rendered (Simple mode omits Data & Storage + Admin), so
    // an unknown/absent slug falls through to index 0.
    useEffect(() => {
        const tab = searchParams.get('tab');
        if (!tab) return;
        const i = tabKeys.indexOf(tab);
        if (i >= 0) setActiveIndex(i);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, isAdmin, isSimple]);

    const handleSaveAdminSettings = async () => {
        setIsSaving(true);
        try {
            const result = await updateSettings({ selfSignupEnabled });
            if (result.success) {
                toast.success('Settings saved successfully');
            } else {
                toast.error('Error', result.error || 'Failed to save settings');
            }
        } catch {
            toast.error('Error', 'An error occurred');
        } finally {
            setIsSaving(false);
        }
    };

    const handleRevalidateAllCaches = async () => {
        setIsRevalidating(true);
        try {
            const result = await revalidateAllCaches();
            if (result.success) {
                toast.success('All caches revalidated successfully');
            } else {
                toast.error('Error', result.error || 'Failed to revalidate caches');
            }
        } catch {
            toast.error('Error', 'An error occurred while revalidating caches');
        } finally {
            setIsRevalidating(false);
        }
    };

    const handleExport = async () => {
        setIsExporting(true);
        try {
            const result = await exportUserData();
            if (result.success && result.data) {
                const date = new Date().toISOString().slice(0, 10);
                downloadTextFile(`sampolio-export-${date}.json`, JSON.stringify(result.data, null, 2), 'application/json');
                toast.success('Export ready', 'Your data was downloaded as JSON');
            } else {
                toast.error('Error', result.error || 'Failed to export data');
            }
        } catch {
            toast.error('Error', 'An error occurred while exporting');
        } finally {
            setIsExporting(false);
        }
    };

    const runImport = async (payload: unknown, mode: 'merge' | 'replace') => {
        setIsImporting(true);
        try {
            const result = await importUserData(payload, { mode });
            if (result.success && result.data) {
                const c = result.data.counts;
                toast.success(
                    'Import complete',
                    `${c.accounts} account(s), ${c.accountSubItems} item(s), ${c.investments} investment(s), ${c.debts} debt(s), ${c.receivables} receivable(s), ${c.goals} goal(s), ${c.budgets} budget(s).`
                );
                for (const warning of result.data.warnings) {
                    toast.show({ severity: 'warn', summary: 'Import note', detail: warning, life: 8000 });
                }
                setImportCandidate(null);
                appContext?.refreshData();
            } else {
                toast.error('Import failed', result.error || 'Failed to import data');
            }
        } catch {
            toast.error('Import failed', 'An error occurred while importing');
        } finally {
            setIsImporting(false);
        }
    };

    const handleImportFile = async (file: File) => {
        let payload: unknown;
        try {
            payload = JSON.parse(await file.text());
        } catch {
            toast.error('Import failed', 'The file is not valid JSON');
            return;
        }
        const entities = (payload as { entities?: Record<string, unknown[]> })?.entities;
        const accountCount = Array.isArray(entities?.accounts) ? entities.accounts.length : 0;
        setImportReplaceMode(false);
        setImportCandidate({ fileName: file.name, payload, accountCount });
    };

    const handleConfirmImport = () => {
        if (!importCandidate) return;
        if (importReplaceMode) {
            confirmDialog({
                header: 'Replace all data?',
                icon: 'pi pi-exclamation-triangle',
                acceptClassName: 'p-button-danger',
                acceptLabel: 'Delete and replace',
                message: 'This deletes ALL your current accounts, items, investments, debts, receivables, goals, budgets and reconciliation history, then restores the backup. It cannot be undone.',
                accept: () => runImport(importCandidate.payload, 'replace'),
            });
        } else {
            runImport(importCandidate.payload, 'merge');
        }
    };

    const handlePreviewCompaction = async () => {
        setIsPreviewing(true);
        setCompactMessage(null);
        try {
            const res = await previewHistoryCompaction();
            if (res.success && res.data) setCompactPreview(res.data);
            else setCompactMessage({ type: 'error', text: res.error || 'Failed to analyze history' });
        } finally {
            setIsPreviewing(false);
        }
    };

    const handleCompact = async () => {
        if (!compactPreview) return;
        const total = compactPreview.snapshots + compactPreview.sessions + compactPreview.adjustments;
        if (total === 0) return;
        if (!confirm(`Remove ${total} old history record(s)? Your latest balances and all forecasts stay the same. This cannot be undone.`)) return;
        setIsCompacting(true);
        setCompactMessage(null);
        try {
            const res = await compactHistory();
            if (res.success && res.data) {
                setCompactMessage({ type: 'success', text: `Removed ${res.data.snapshots} snapshots, ${res.data.sessions} check-in logs, ${res.data.adjustments} adjustments.` });
                setCompactPreview(null);
            } else {
                setCompactMessage({ type: 'error', text: res.error || 'Failed to compact history' });
            }
        } finally {
            setIsCompacting(false);
        }
    };

    const heading = `text-lg font-semibold mb-4 ${isDark ? 'text-gray-100' : 'text-gray-900'}`;

    // ---- Section cards (composed into tabs below) ----

    const displayModeCard = (
        <Card>
            <h2 className={heading}>Display Mode</h2>
            <div className="grid grid-cols-2 gap-4">
                <button
                    onClick={() => appContext?.setDisplayMode('simple')}
                    className={`p-4 rounded-lg border-2 text-left transition-colors ${
                        appContext?.displayMode === 'simple'
                            ? 'border-accent-500 bg-accent-50 dark:bg-accent-400/15'
                            : isDark ? 'border-gray-700 hover:border-gray-600' : 'border-gray-200 hover:border-gray-300'
                    }`}
                >
                    <p className={`font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>Simple</p>
                    <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Clean overview with key numbers and trends
                    </p>
                </button>
                <button
                    onClick={() => appContext?.setDisplayMode('advanced')}
                    className={`p-4 rounded-lg border-2 text-left transition-colors ${
                        appContext?.displayMode === 'advanced'
                            ? 'border-accent-500 bg-accent-50 dark:bg-accent-400/15'
                            : isDark ? 'border-gray-700 hover:border-gray-600' : 'border-gray-200 hover:border-gray-300'
                    }`}
                >
                    <p className={`font-semibold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>Advanced</p>
                    <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Full details, charts, and projections
                    </p>
                </button>
            </div>
        </Card>
    );

    const appearanceCard = (
        <Card>
            <h2 className={heading}>Appearance</h2>
            <div className="flex items-center justify-between">
                <div>
                    <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Dark Mode</p>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Use dark theme for the interface
                    </p>
                </div>
                <InputSwitch checked={isDark} onChange={toggleTheme} />
            </div>
        </Card>
    );

    const remindersCard = (
        <Card>
            <h2 className={heading}>Reminders</h2>
            <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                    <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Monthly check-in reminders</p>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        Show the &quot;time to check in&quot; banner on Overview each month. With bank sync
                        keeping balances current, you may only need occasional manual check-ins (e.g. investments).
                    </p>
                </div>
                <InputSwitch
                    className="shrink-0"
                    checked={checkInReminders}
                    onChange={async (e) => {
                        const enabled = e.value ?? true;
                        setCheckInReminders(enabled);
                        const result = await updateCheckInReminders(enabled);
                        if (result.success) {
                            toast.success(enabled ? 'Check-in reminders on' : 'Check-in reminders off');
                        } else {
                            setCheckInReminders(!enabled);
                            toast.error('Error', result.error || 'Failed to save preference');
                        }
                    }}
                />
            </div>
            {/* Sub-toggle: local device notification. Only meaningful while reminders are on. */}
            <div className={`flex items-center justify-between gap-4 mt-4 pl-4 border-l-2 ${isDark ? 'border-gray-700' : 'border-gray-200'} ${!checkInReminders ? 'opacity-50' : ''}`}>
                <div className="min-w-0 flex-1">
                    <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Also notify on this device</p>
                    <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        When a monthly check-in is due, show a notification on this device the next time
                        you open the app. Uses the browser&apos;s notification permission — nothing is sent
                        to any server.
                    </p>
                </div>
                <InputSwitch
                    className="shrink-0"
                    disabled={!checkInReminders}
                    checked={checkInNotifications}
                    onChange={async (e) => {
                        const enabled = e.value ?? false;
                        if (enabled) {
                            // Ask for the browser permission first; revert if it isn't granted.
                            if (typeof window === 'undefined' || !('Notification' in window)) {
                                toast.error('Not supported', 'This browser does not support notifications.');
                                return;
                            }
                            let permission = Notification.permission;
                            if (permission === 'default') {
                                permission = await Notification.requestPermission();
                            }
                            if (permission !== 'granted') {
                                toast.error(
                                    'Notifications blocked',
                                    'Allow notifications for Sampolio in your browser settings, then try again.'
                                );
                                return;
                            }
                        }
                        setCheckInNotifications(enabled);
                        const result = await updateCheckInNotifications(enabled);
                        if (result.success) {
                            toast.success(enabled ? 'Device notifications on' : 'Device notifications off');
                        } else {
                            setCheckInNotifications(!enabled);
                            toast.error('Error', result.error || 'Failed to save preference');
                        }
                    }}
                />
            </div>
        </Card>
    );

    // Opt-out toggles are sent as a full five-key record, so a stale absent key
    // can never re-enable something the user just turned off.
    const handleSplitNotifyToggle = async (key: SplitNotifyEvent, label: string, enabled: boolean) => {
        const previous = splitNotifyPrefs;
        const next: Partial<Record<SplitNotifyEvent, boolean>> = {};
        for (const t of SPLIT_NOTIFY_TOGGLES) {
            next[t.key] = t.key === key ? enabled : previous[t.key] !== false;
        }
        setSplitNotifyPrefs(next);
        const result = await updateSplitNotificationPrefs(next);
        if (result.success) {
            toast.success(`${label} ${enabled ? 'on' : 'off'}`);
        } else {
            setSplitNotifyPrefs(previous);
            toast.error('Error', result.error || 'Failed to save preference');
        }
    };

    const pushNotificationsCard = (
        <Card>
            <h2 className={heading}>Push notifications</h2>
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Split activity delivered to your phone via Home Assistant. Applies to all your
                split groups — and you are never notified about your own changes.
            </p>
            {!splitNotifyConfigured && (
                <AlertBanner severity="info" icon="ℹ️" className="mb-4">
                    Notifications aren&apos;t configured on this server (<code>HA_WEBHOOK_URL</code>).
                    Your preferences still save and will apply once it is.
                </AlertBanner>
            )}
            <div className="divide-y divide-gray-200/40 dark:divide-gray-700/40">
                {SPLIT_NOTIFY_TOGGLES.map(({ key, label }) => (
                    <div key={key} className="flex items-center justify-between gap-4 min-h-11 py-2">
                        <span className={`min-w-0 flex-1 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>{label}</span>
                        <InputSwitch
                            className="shrink-0"
                            aria-label={label}
                            checked={splitNotifyPrefs[key] !== false}
                            onChange={(e) => handleSplitNotifyToggle(key, label, e.value ?? false)}
                        />
                    </div>
                ))}
            </div>
        </Card>
    );

    const shortcutsCard = (
        <Card>
            <h2 className={heading}>Keyboard Shortcuts</h2>
            <div className="space-y-3">
                {[
                    { label: 'Open Command Palette', key: '⌘K' },
                    { label: 'Quick Add Income', key: '⌘I' },
                    { label: 'Quick Add Expense', key: '⌘E' },
                    { label: 'Start Reconciliation', key: '⌘R' },
                ].map(s => (
                    <div key={s.key} className="flex items-center justify-between">
                        <span className={isDark ? 'text-gray-200' : 'text-gray-700'}>{s.label}</span>
                        <kbd className={`px-2 py-1 rounded text-sm ${isDark ? 'bg-gray-800 text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                            {s.key}
                        </kbd>
                    </div>
                ))}
            </div>
        </Card>
    );

    const categoriesCard = (
        <Card>
            <h2 className={heading}>Categories</h2>
            <p className={`mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Manage categories for income and expenses. Click ✕ to remove a category.
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
                {activeCategories.map(cat => (
                    <Chip
                        key={cat}
                        label={cat}
                        removable
                        onRemove={() => {
                            if (ITEM_CATEGORIES.includes(cat)) {
                                setRemovedDefaults(prev => [...prev, cat]);
                            } else {
                                setCustomCategories(prev => prev.filter(c => c !== cat));
                            }
                            return true;
                        }}
                    />
                ))}
            </div>
            {removedDefaults.length > 0 && (
                <div className="mb-4">
                    <p className={`text-xs mb-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Removed defaults (click to restore):</p>
                    <div className="flex flex-wrap gap-1">
                        {removedDefaults.map(cat => (
                            <Chip
                                key={cat}
                                label={cat}
                                className="opacity-50 cursor-pointer"
                                onClick={() => setRemovedDefaults(prev => prev.filter(c => c !== cat))}
                            />
                        ))}
                    </div>
                </div>
            )}
            <div className="flex gap-2 mb-4">
                <InputText
                    value={newCategoryName}
                    onChange={e => setNewCategoryName(e.target.value)}
                    placeholder="New category name"
                    className="flex-1"
                    onKeyDown={e => {
                        if (e.key === 'Enter' && newCategoryName.trim()) {
                            const name = newCategoryName.trim();
                            if (!activeCategories.includes(name)) {
                                setCustomCategories(prev => [...prev, name]);
                            }
                            setNewCategoryName('');
                        }
                    }}
                />
                <Button
                    icon={<MdAdd />}
                    outlined
                    disabled={!newCategoryName.trim() || activeCategories.includes(newCategoryName.trim())}
                    onClick={() => {
                        const name = newCategoryName.trim();
                        if (name && !activeCategories.includes(name)) {
                            setCustomCategories(prev => [...prev, name]);
                        }
                        setNewCategoryName('');
                    }}
                />
            </div>
            <Button
                label="Save Categories"
                icon={<MdCheck />}
                size="small"
                onClick={async () => {
                    setIsSavingCategories(true);
                    try {
                        const result = await updateCategories(customCategories, removedDefaults);
                        if (result.success) toast.success('Categories saved');
                        else toast.error('Error', result.error || 'Failed to save categories');
                    } catch {
                        toast.error('Error', 'An error occurred');
                    } finally {
                        setIsSavingCategories(false);
                    }
                }}
                loading={isSavingCategories}
            />
        </Card>
    );

    const taxCard = (
        <Card>
            <h2 className={heading}>My tax &amp; contribution defaults</h2>
            <p className={`mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                These apply only to your account. They pre-fill the form when you create a new salary
                configuration — changing them never affects existing salaries or other users.
            </p>
            <div className="space-y-4 max-w-md">
                <div>
                    <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        Default Tax Rate (%)
                    </label>
                    <InputNumber
                        value={taxDefaults.taxRate}
                        onValueChange={e => setTaxDefaults(prev => ({ ...prev, taxRate: e.value ?? 0 }))}
                        suffix="%"
                        locale="fi-FI"
                        min={0}
                        max={100}
                        minFractionDigits={0}
                        maxFractionDigits={2}
                        className="w-full"
                    />
                </div>
                <div>
                    <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        Default Contributions Rate (%)
                    </label>
                    <InputNumber
                        value={taxDefaults.contributionsRate}
                        onValueChange={e => setTaxDefaults(prev => ({ ...prev, contributionsRate: e.value ?? 0 }))}
                        suffix="%"
                        locale="fi-FI"
                        min={0}
                        max={100}
                        minFractionDigits={0}
                        maxFractionDigits={2}
                        className="w-full"
                    />
                </div>
                <div>
                    <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                        Default Other Deductions (fixed amount)
                    </label>
                    <InputNumber
                        value={taxDefaults.otherDeductions}
                        onValueChange={e => setTaxDefaults(prev => ({ ...prev, otherDeductions: e.value ?? 0 }))}
                        mode="currency"
                        currency={appContext?.accounts?.find(a => !a.isArchived)?.currency || 'EUR'}
                        locale="fi-FI"
                        min={0}
                        className="w-full"
                    />
                </div>
            </div>
            <div className="mt-4">
                <Button
                    label="Save Tax Defaults"
                    icon={<MdCheck />}
                    size="small"
                    onClick={async () => {
                        setIsSavingTax(true);
                        try {
                            const result = await updateTaxDefaults(taxDefaults);
                            if (result.success) toast.success('Tax defaults saved');
                            else toast.error('Error', result.error || 'Failed to save tax defaults');
                        } catch {
                            toast.error('Error', 'An error occurred');
                        } finally {
                            setIsSavingTax(false);
                        }
                    }}
                    loading={isSavingTax}
                />
            </div>
        </Card>
    );

    const accountsCard = (
        <Card>
            <h2 className={heading}>Accounts</h2>
            <p className={`mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Manage, archive, or remove your cash accounts
            </p>
            <Button
                label="Manage Accounts"
                icon={<MdAccountBalanceWallet />}
                outlined
                onClick={() => appContext?.openDrawer({ mode: 'view', entityType: 'account' })}
            />
        </Card>
    );

    const dataExportCard = (
        <Card>
            <h2 className={heading}>Data &amp; Export</h2>
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Export Data</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Download all your financial data as JSON (bank connections and shared
                            mortgages/split groups are not included)
                        </p>
                    </div>
                    <Button label="Export" icon={<MdDownload />} outlined size="small" className="shrink-0" onClick={handleExport} loading={isExporting} />
                </div>
                <Divider />
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Import Data</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Import financial data from a Sampolio JSON backup
                        </p>
                    </div>
                    <Button label="Import" icon={<MdUpload />} outlined size="small" className="shrink-0" onClick={() => importInputRef.current?.click()} loading={isImporting} />
                    <input
                        ref={importInputRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) handleImportFile(file);
                        }}
                    />
                </div>
            </div>
        </Card>
    );

    const dataStorageCard = (
        <Card>
            <h2 className={`text-lg font-semibold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                Data &amp; storage
            </h2>
            <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                Old reconciliation history — balance snapshots and check-in logs from before your latest check-in —
                isn&apos;t used by your forecasts. Clearing it keeps your data tidy. Your latest balances (the anchors
                your forecasts build on) and every projection stay exactly the same.
            </p>
            {compactPreview && (
                <Message
                    severity={compactPreview.snapshots + compactPreview.sessions + compactPreview.adjustments > 0 ? 'info' : 'success'}
                    className="mb-3 block"
                    text={
                        compactPreview.snapshots + compactPreview.sessions + compactPreview.adjustments > 0
                            ? `Can remove ${compactPreview.snapshots} old snapshot(s), ${compactPreview.sessions} check-in log(s) and ${compactPreview.adjustments} adjustment(s). ${compactPreview.keptAnchors} current balance anchor(s) will be kept.`
                            : `Nothing to clean up — your history is already compact (${compactPreview.keptAnchors} anchor(s) kept).`
                    }
                />
            )}
            {compactMessage && (
                <Message severity={compactMessage.type} className="mb-3 block" text={compactMessage.text} />
            )}
            <div className="flex gap-2">
                <Button
                    label="Preview cleanup"
                    icon={<MdStorage />}
                    outlined
                    size="small"
                    onClick={handlePreviewCompaction}
                    loading={isPreviewing}
                />
                <Button
                    label="Compact now"
                    icon={<MdDeleteSweep />}
                    severity="warning"
                    size="small"
                    onClick={handleCompact}
                    loading={isCompacting}
                    disabled={!compactPreview || compactPreview.snapshots + compactPreview.sessions + compactPreview.adjustments === 0}
                />
            </div>
        </Card>
    );

    const adminCard = (
        <Card>
            <h2 className={heading}>Admin Settings</h2>
            <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Allow Self-Signup</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Enable new users to register without admin approval
                        </p>
                    </div>
                    <InputSwitch className="shrink-0" checked={selfSignupEnabled} onChange={(e) => setSelfSignupEnabled(e.value)} />
                </div>
                <Divider />
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Manage Users</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            View and manage user accounts
                        </p>
                    </div>
                    <Button
                        label="Users"
                        icon={<MdGroup />}
                        outlined
                        size="small"
                        className="shrink-0"
                        onClick={() => appContext?.openDrawer({ mode: 'view', entityType: 'users' })}
                    />
                </div>
                <Divider />
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                        <p className={isDark ? 'text-gray-200' : 'text-gray-700'}>Force Revalidate Caches</p>
                        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            Clear all in-memory data caches and force fresh reads from disk
                        </p>
                    </div>
                    <Button
                        label="Revalidate"
                        icon={<MdCached />}
                        outlined
                        severity="warning"
                        size="small"
                        className="shrink-0"
                        onClick={handleRevalidateAllCaches}
                        loading={isRevalidating}
                    />
                </div>
                <div className="flex justify-end">
                    <Button
                        label="Save Admin Settings"
                        icon={<MdCheck />}
                        onClick={handleSaveAdminSettings}
                        loading={isSaving}
                    />
                </div>
            </div>
        </Card>
    );

    const aboutCard = (
        <Card>
            <h2 className={heading}>About</h2>
            <div className="space-y-2">
                <p className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                    <strong>Sampolio</strong> - Personal Finance Planning Tool
                </p>
                {appVersion && (
                    <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        Version {appVersion}
                    </p>
                )}
                <div className="pt-2">
                    <a
                        href="https://github.com/machadolucas/sampolio"
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`inline-flex items-center gap-2 text-sm hover:underline ${isDark ? 'text-accent-400 hover:text-accent-300' : 'text-accent-600 hover:text-accent-700'}`}
                    >
                        <FaGithub />
                        View on GitHub
                    </a>
                </div>
            </div>
        </Card>
    );

    const importDialog = (
        <Dialog
            header="Import backup"
            visible={importCandidate !== null}
            onHide={() => setImportCandidate(null)}
            style={{ width: '28rem' }}
            modal
            draggable={false}
            footer={
                <div className="flex justify-end gap-2">
                    <Button label="Cancel" severity="secondary" text onClick={() => setImportCandidate(null)} disabled={isImporting} />
                    <Button
                        label={importReplaceMode ? 'Replace all…' : 'Import (merge)'}
                        icon={<MdUpload />}
                        severity={importReplaceMode ? 'danger' : undefined}
                        onClick={handleConfirmImport}
                        loading={isImporting}
                    />
                </div>
            }
        >
            {importCandidate && (
                <div className="space-y-4">
                    <p className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                        <strong>{importCandidate.fileName}</strong> contains {importCandidate.accountCount} account(s).
                        By default it is <strong>merged</strong> into your current data: entries with the same ids are
                        overwritten, everything else is kept. Bank connections are never touched.
                    </p>
                    <div className="flex items-start gap-2">
                        <Checkbox
                            inputId="import-replace"
                            checked={importReplaceMode}
                            onChange={(e) => setImportReplaceMode(e.checked ?? false)}
                        />
                        <label htmlFor="import-replace" className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                            Replace all my current data instead of merging <span className="text-red-500">(deletes everything first)</span>
                        </label>
                    </div>
                </div>
            )}
        </Dialog>
    );

    return (
        <div className="space-y-4 lg:space-y-6 max-w-3xl py-4 mx-auto">
            {importDialog}
            {/* Header */}
            <div>
                <h1 className={`text-2xl font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                    Settings
                </h1>
                <p className={`text-sm mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    Configure your preferences and application settings
                </p>
            </div>

            <TabView scrollable activeIndex={activeIndex} onTabChange={(e) => setActiveIndex(e.index)}>
                <TabPanel header="General">
                    <div className="space-y-6">
                        {displayModeCard}
                        <MobileNavCard />
                        {appearanceCard}
                        {remindersCard}
                        {pushNotificationsCard}
                        {shortcutsCard}
                    </div>
                </TabPanel>

                <TabPanel header="Finance">
                    <div className="space-y-6">
                        {categoriesCard}
                        {taxCard}
                    </div>
                </TabPanel>

                <TabPanel header="Accounts & Banking">
                    <div className="space-y-6">
                        {accountsCard}
                        <BankConnectionsPanel />
                    </div>
                </TabPanel>

                {!isSimple && (
                    <TabPanel header="Data & Storage">
                        <div className="space-y-6">
                            {dataExportCard}
                            {dataStorageCard}
                        </div>
                    </TabPanel>
                )}

                {isAdmin && !isSimple && (
                    <TabPanel header="Admin">
                        <div className="space-y-6">
                            {adminCard}
                        </div>
                    </TabPanel>
                )}

                <TabPanel header="Account">
                    <AccountPanel isDark={isDark} />
                </TabPanel>

                <TabPanel header="About">
                    {aboutCard}
                </TabPanel>
            </TabView>
        </div>
    );
}

// useSearchParams() must sit under a Suspense boundary (Next.js CSR-bailout
// rule), or the whole route errors during prerendering.
export default function SettingsPage() {
    return (
        <Suspense>
            <SettingsPageInner />
        </Suspense>
    );
}
