'use client';

import dynamic from 'next/dynamic';
import { DelayedSpinner } from '@/components/ui/delayed-loading';
import type { DrawerState, FinancialAccount } from '@/types';

// This router is mounted by AppLayout on EVERY page — lazy-load the heavy
// modals so they leave the shared first-load bundle (CashflowItemModal alone
// is ~1 000 lines; EntityListDrawer is bigger still). They fetch on first open.
const modalLoading = () => <DelayedSpinner className="fixed inset-0 z-50 flex items-center justify-center" />;
const CashflowItemModal = dynamic(
    () => import('@/components/modals/cashflow-item-modal').then((m) => m.CashflowItemModal),
    { ssr: false, loading: modalLoading },
);
const EntityListDrawer = dynamic(
    () => import('@/components/ui/entity-list-drawer').then((m) => m.EntityListDrawer),
    { ssr: false, loading: modalLoading },
);
const UsersModal = dynamic(
    () => import('@/components/modals/users-modal').then((m) => m.UsersModal),
    { ssr: false, loading: modalLoading },
);
const QuickAddSplitModal = dynamic(
    () => import('@/components/split/quick-add-split-modal').then((m) => m.QuickAddSplitModal),
    { ssr: false, loading: modalLoading },
);

interface EntityModalRouterProps {
    drawerState: DrawerState;
    onClose: () => void;
    onDataChange: () => void;
    accounts: FinancialAccount[];
    selectedAccountId: string;
    onAccountChange: (accountId: string) => void;
}

const entityToCategory: Record<string, 'cash' | 'investments' | 'receivables' | 'debts'> = {
    'account': 'cash',
    'cash-account': 'cash',
    'investment': 'investments',
    'receivable': 'receivables',
    'debt': 'debts',
};

export function EntityModalRouter({
    drawerState,
    onClose,
    onDataChange,
    accounts,
    selectedAccountId,
    onAccountChange,
}: EntityModalRouterProps) {
    const visible = drawerState.isOpen;
    const entityType = drawerState.entityType;
    const editItemId = drawerState.mode === 'edit' ? drawerState.entityId : undefined;

    const handleHide = () => {
        onClose();
        onDataChange();
    };

    // Map entity types to the unified cashflow item modal
    const cashflowTypes: Record<string, { type?: 'income' | 'expense'; recurrence?: 'recurring' | 'one-off' | 'salary' | 'taxed-income'; source?: string }> = {
        'income': { type: 'income', recurrence: 'recurring' },
        'expense': { type: 'expense', recurrence: 'recurring' },
        'planned': { recurrence: 'one-off' },
        'salary': { type: 'income', recurrence: 'salary' },
        'taxed-income': { type: 'income', recurrence: 'taxed-income' },
        'cashflow-item': {},
    };

    if (entityType && entityType in cashflowTypes) {
        const cfg = cashflowTypes[entityType];
        return (
            <CashflowItemModal
                visible={visible}
                onHide={handleHide}
                selectedAccountId={selectedAccountId}
                accounts={accounts.filter(a => !a.isArchived)}
                onAccountChange={onAccountChange}
                onDataChange={onDataChange}
                editItemId={editItemId}
                editItemSource={entityType}
                initialType={cfg.type}
                initialRecurrence={cfg.recurrence}
                autoOpenForm={drawerState.mode === 'create'}
            />
        );
    }

    // Entity types handled by EntityListDrawer
    if (entityType && entityType in entityToCategory) {
        const category = entityToCategory[entityType];
        return (
            <EntityListDrawer
                visible={visible}
                category={category}
                onClose={handleHide}
                onRefresh={onDataChange}
                editEntityId={editItemId}
            />
        );
    }

    switch (entityType) {
        case 'users':
            return (
                <UsersModal
                    visible={visible}
                    onHide={handleHide}
                />
            );

        case 'split-expense':
            return (
                <QuickAddSplitModal
                    visible={visible}
                    onHide={onClose}
                    onSaved={onDataChange}
                />
            );

        default:
            return null;
    }
}
