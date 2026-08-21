'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { InputText } from 'primereact/inputtext';
import { MdHome, MdSpaceDashboard, MdSettings, MdSync, MdAddCircle, MdRemoveCircle, MdSearch, MdHouse, MdLuggage, MdAccountBalance, MdGroups, MdInsights, MdFlag, MdFlightTakeoff, MdVisibilityOff } from 'react-icons/md';
import { useTheme } from '@/components/providers/theme-provider';
import { useAppContext } from '@/components/layout/app-layout';
import type { Command, CommandType } from '@/types';

interface CommandPaletteProps {
    isOpen: boolean;
    onClose: () => void;
    onNavigate?: (path: string) => void;
    onAddItem?: (type: 'income' | 'expense', yearMonth?: string, amount?: number, name?: string) => void;
    onReconcile?: () => void;
    onAddSplitExpense?: () => void;
    onOpenEntity?: (entityType: string, entityId?: string) => void;
}

const NAVIGATION_COMMANDS: Command[] = [
    {
        id: 'nav-home',
        label: 'Go to Home',
        description: 'Quick add, split balances, and recent activity',
        type: 'navigate',
        icon: <MdHome />,
        keywords: ['home', 'start', 'dashboard'],
        action: () => { },
    },
    {
        id: 'nav-split',
        label: 'Go to Split',
        description: 'Shared expense groups with your partner',
        type: 'navigate',
        icon: <MdGroups />,
        keywords: ['split', 'splitwise', 'shared', 'group', 'expense', 'owe', 'settle'],
        action: () => { },
    },
    {
        id: 'nav-overview',
        label: 'Go to Overview',
        description: 'Wealth dashboard with net worth and projections',
        type: 'navigate',
        icon: <MdSpaceDashboard />,
        keywords: ['overview', 'dashboard', 'wealth', 'net worth'],
        action: () => { },
    },
    {
        id: 'nav-cashflow',
        label: 'Go to Cashflow',
        description: 'Cash accounts and monthly projections',
        type: 'navigate',
        icon: <MdInsights />,
        keywords: ['cash', 'flow', 'monthly', 'income', 'expense'],
        action: () => { },
    },
    {
        id: 'nav-mortgage',
        label: 'Go to Mortgage',
        description: 'Your shared home loan, ownership split, and payment schedule',
        type: 'navigate',
        icon: <MdHouse />,
        keywords: ['mortgage', 'loan', 'house', 'home', 'asp', 'euribor', 'ownership'],
        action: () => { },
    },
    {
        id: 'nav-budgets',
        label: 'Go to Trips & Budgets',
        description: 'Plan trips and projects, per-diems, and track grant money',
        type: 'navigate',
        icon: <MdLuggage />,
        keywords: ['budget', 'trip', 'trips', 'travel', 'grant', 'project', 'per diem', 'päiväraha', 'matka', 'allowance', 'reimbursement'],
        action: () => { },
    },
    {
        id: 'nav-goals',
        label: 'Go to Goals',
        description: 'Savings targets and progress toward them',
        type: 'navigate',
        icon: <MdFlag />,
        keywords: ['goal', 'goals', 'target', 'savings', 'milestone'],
        action: () => { },
    },
    {
        id: 'nav-trips',
        label: 'Go to Trips (per diem)',
        description: 'Per-diem travel reimbursement calculator',
        type: 'navigate',
        icon: <MdFlightTakeoff />,
        keywords: ['trip', 'trips', 'travel', 'per diem', 'daily allowance', 'päiväraha', 'reimbursement'],
        action: () => { },
    },
    {
        id: 'nav-bank',
        label: 'Go to Bank',
        description: 'Connected bank accounts and imported transactions',
        type: 'navigate',
        icon: <MdAccountBalance />,
        keywords: ['bank', 'accounts', 'transactions', 'sync', 'enable banking', 'psd2', 'card'],
        action: () => { },
    },
    {
        id: 'nav-playground',
        label: 'Go to What If?',
        description: 'Explore financial scenarios and hypotheticals',
        type: 'navigate',
        icon: <MdHome />,
        keywords: ['what if', 'scenario', 'playground', 'explore', 'hypothetical'],
        action: () => { },
    },
    {
        id: 'nav-settings',
        label: 'Go to Settings',
        description: 'Configure tax profiles, categories, and preferences',
        type: 'navigate',
        icon: <MdSettings />,
        keywords: ['settings', 'config', 'preferences', 'tax'],
        action: () => { },
    },
];

const ACTION_COMMANDS: Command[] = [
    {
        id: 'action-reconcile',
        label: 'Monthly Check-in',
        description: 'Verify your actual balances for this month',
        type: 'reconcile',
        icon: <MdSync />,
        shortcut: '⌘M',
        keywords: ['reconcile', 'check-in', 'update', 'actual', 'balance', 'monthly'],
        action: () => { },
    },
    {
        id: 'action-add-income',
        label: 'Add Income',
        description: 'Add a new income item',
        type: 'add',
        icon: <MdAddCircle />,
        keywords: ['add', 'new', 'income', 'money'],
        action: () => { },
    },
    {
        id: 'action-add-expense',
        label: 'Add Expense',
        description: 'Add a new expense item',
        type: 'add',
        icon: <MdRemoveCircle />,
        keywords: ['add', 'new', 'expense', 'spend'],
        action: () => { },
    },
    {
        id: 'action-add-split-expense',
        label: 'Add Shared Expense',
        description: 'Split a new expense with your partner',
        type: 'add',
        icon: <MdGroups />,
        keywords: ['add', 'split', 'shared', 'expense', 'splitwise', 'owe'],
        action: () => { },
    },
    {
        id: 'action-demo-mode',
        label: 'Toggle demo mode (hide amounts)',
        description: 'Mask all monetary values for showing the app to friends',
        type: 'action',
        icon: <MdVisibilityOff />,
        keywords: ['demo', 'hide', 'mask', 'amounts', 'privacy', 'present', 'screenshot', 'blur'],
        action: () => { },
    },
];

export function CommandPalette({
    isOpen,
    onClose,
    onNavigate,
    onAddItem,
    onReconcile,
    onAddSplitExpense,
}: CommandPaletteProps) {
    const router = useRouter();
    const { theme } = useTheme();
    // The palette renders inside AppLayout's provider, so app-context actions
    // (e.g. the demo-mode toggle) are available directly here — no extra prop.
    const appContext = useAppContext();
    const isDark = theme === 'dark';
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Parse natural language input like "Add 120 groceries Feb"
    const parseNaturalLanguageAdd = (input: string): { type: 'income' | 'expense'; amount?: number; name?: string; month?: string } | null => {
        const addMatch = input.match(/^add\s+(\d+(?:\.\d+)?)\s+(.+?)(?:\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))?$/i);
        if (addMatch) {
            const amount = parseFloat(addMatch[1]);
            const name = addMatch[2].trim();
            const month = addMatch[3]?.toLowerCase();
            // Determine if it's likely income or expense based on common keywords
            const incomeKeywords = ['salary', 'income', 'bonus', 'refund', 'payment received'];
            const isIncome = incomeKeywords.some(kw => name.toLowerCase().includes(kw));
            return { type: isIncome ? 'income' : 'expense', amount, name, month };
        }
        return null;
    };

    // Build all commands
    const allCommands = useMemo(() => {
        const commands: Command[] = [
            ...ACTION_COMMANDS,
            ...NAVIGATION_COMMANDS,
        ];
        return commands;
    }, []);

    // Filter commands based on query
    const filteredCommands = useMemo(() => {
        if (!query.trim()) return allCommands;

        const lowerQuery = query.toLowerCase();

        // Check for natural language add
        const parsed = parseNaturalLanguageAdd(query);
        if (parsed) {
            return [{
                id: 'dynamic-add',
                label: `Add ${parsed.type}: ${parsed.name}`,
                description: parsed.amount ? `€${parsed.amount}${parsed.month ? ` in ${parsed.month}` : ''}` : undefined,
                type: 'add' as CommandType,
                icon: parsed.type === 'income' ? <MdAddCircle /> : <MdRemoveCircle />,
                shortcut: undefined,
                keywords: [] as string[],
                action: () => onAddItem?.(parsed.type, parsed.month, parsed.amount, parsed.name),
            } satisfies Command];
        }

        return allCommands.filter(cmd => {
            const searchText = [cmd.label, cmd.description, ...(cmd.keywords || [])].join(' ').toLowerCase();
            return searchText.includes(lowerQuery);
        });
    }, [query, allCommands, onAddItem]);

    const executeCommand = useCallback((command: Command) => {
        switch (command.type) {
            case 'navigate': {
                const paths: Record<string, string> = {
                    'nav-home': '/',
                    'nav-split': '/split',
                    'nav-overview': '/overview',
                    'nav-cashflow': '/cashflow',
                    'nav-mortgage': '/mortgage',
                    'nav-budgets': '/budgets',
                    'nav-goals': '/goals',
                    'nav-trips': '/budgets',
                    'nav-bank': '/bank',
                    'nav-playground': '/playground',
                    'nav-settings': '/settings',
                };
                const path = paths[command.id];
                if (path) {
                    if (onNavigate) {
                        onNavigate(path);
                    } else {
                        router.push(path);
                    }
                }
                break;
            }
            case 'reconcile':
                onReconcile?.();
                break;
            case 'add':
                if (command.id === 'action-add-income') {
                    onAddItem?.('income');
                } else if (command.id === 'action-add-expense') {
                    onAddItem?.('expense');
                } else if (command.id === 'action-add-split-expense') {
                    onAddSplitExpense?.();
                } else {
                    command.action();
                }
                break;
            case 'action':
                if (command.id === 'action-demo-mode') {
                    appContext?.setDemoMode(!appContext.demoMode);
                } else {
                    command.action();
                }
                break;
            default:
                command.action();
        }
        onClose();
    }, [onNavigate, onReconcile, onAddItem, onAddSplitExpense, onClose, router, appContext]);

    // Handle keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!isOpen) return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1));
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedIndex(i => Math.max(i - 1, 0));
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (filteredCommands[selectedIndex]) {
                        executeCommand(filteredCommands[selectedIndex]);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    onClose();
                    break;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, filteredCommands, selectedIndex, onClose, executeCommand]);

    // Focus input when opened (reset transient palette state on open).
    useEffect(() => {
        if (isOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setQuery('');
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    // Reset selection when filtered results change
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedIndex(0);
    }, [query]);

    const getTypeColor = (type: CommandType) => {
        switch (type) {
            case 'navigate': return isDark ? 'text-accent-400' : 'text-accent-600';
            case 'add': return isDark ? 'text-green-400' : 'text-green-600';
            case 'reconcile': return isDark ? 'text-purple-400' : 'text-purple-600';
            default: return isDark ? 'text-gray-400' : 'text-gray-600';
        }
    };

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop */}
            <div
                className="animate-fade-in fixed inset-0 z-50 bg-black/50"
                onClick={onClose}
            />

            {/* Palette — the outer div only positions (its -translate-x-1/2 must not be
                clobbered by the entrance animation's transform); the inner div carries
                the visual shell and the scale-fade entrance. Close stays instant. */}
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
                className="fixed top-[8%] sm:top-[20%] left-1/2 -translate-x-1/2 z-50 w-[95vw] sm:w-full max-w-xl"
            >
            <div className="animate-scale-in rounded-2xl shadow-2xl overflow-hidden glass-chrome">
                {/* Search Input */}
                <div className={`flex items-center gap-3 px-4 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
                    <MdSearch className={isDark ? 'text-gray-400' : 'text-gray-500'} />
                    <InputText
                        ref={inputRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Type a command or search..."
                        role="combobox"
                        aria-expanded={filteredCommands.length > 0}
                        aria-controls="command-palette-listbox"
                        aria-activedescendant={filteredCommands[selectedIndex] ? `command-option-${filteredCommands[selectedIndex].id}` : undefined}
                        aria-autocomplete="list"
                        className="flex-1 border-none shadow-none p-0 focus:ring-0"
                        style={{ background: 'transparent' }}
                    />
                    <kbd className={`px-2 py-0.5 text-xs rounded ${isDark ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'
                        }`}>
                        ESC
                    </kbd>
                </div>

                {/* Results */}
                <div id="command-palette-listbox" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-2">
                    {filteredCommands.length === 0 ? (
                        <div role="status" aria-live="polite" className={`px-4 py-8 text-center ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                            <MdSearch size={24} className="mb-2" />
                            <p>No results found</p>
                        </div>
                    ) : (
                        filteredCommands.map((command, index) => (
                            <button
                                key={command.id}
                                id={`command-option-${command.id}`}
                                role="option"
                                aria-selected={index === selectedIndex}
                                onClick={() => executeCommand(command)}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-100 ${index === selectedIndex
                                    ? isDark ? 'bg-gray-800 active:bg-gray-700' : 'bg-gray-100 active:bg-gray-200'
                                    : isDark ? 'hover:bg-gray-800/50 active:bg-gray-800' : 'hover:bg-gray-50 active:bg-gray-100'
                                    }`}
                            >
                                <span className={getTypeColor(command.type)}>{command.icon}</span>
                                <div className="flex-1 min-w-0">
                                    <div className={isDark ? 'text-gray-100' : 'text-gray-900'}>
                                        {command.label}
                                    </div>
                                    {command.description && (
                                        <div className={`text-sm truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                                            {command.description}
                                        </div>
                                    )}
                                </div>
                                {command.shortcut && (
                                    <kbd className={`px-2 py-0.5 text-xs rounded ${isDark ? 'bg-gray-800 text-gray-400' : 'bg-gray-100 text-gray-500'
                                        }`}>
                                        {command.shortcut}
                                    </kbd>
                                )}
                            </button>
                        ))
                    )}
                </div>

                {/* Footer Hint */}
                <div className={`px-4 py-2 border-t text-xs ${isDark ? 'border-gray-700 text-gray-500' : 'border-gray-200 text-gray-400'
                    }`}>
                    <span>Try: </span>
                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>&quot;add 120 groceries feb&quot;</span>
                    <span> or </span>
                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>&quot;go to cashflow&quot;</span>
                </div>
            </div>
            </div>
        </>
    );
}

// Hook for keyboard shortcuts
export function useCommandPalette(shortcuts?: {
    onReconcile?: () => void;
    onAddIncome?: () => void;
    onAddExpense?: () => void;
}) {
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't handle shortcuts when typing in inputs
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                setIsOpen(prev => !prev);
                return;
            }

            // Only handle other shortcuts when not in an input
            if (isInput) return;

            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                shortcuts?.onReconcile?.();
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
                e.preventDefault();
                shortcuts?.onAddIncome?.();
                return;
            }

            if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
                e.preventDefault();
                shortcuts?.onAddExpense?.();
                return;
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [shortcuts]);

    return {
        isOpen,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
        toggle: () => setIsOpen(prev => !prev),
    };
}
