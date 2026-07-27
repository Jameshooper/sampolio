'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MdAccountBalance, MdCreditCard, MdSavings } from 'react-icons/md';
import { getConsentExpiryInfo, maskIban } from '@/lib/bank-utils';
import { formatCurrency } from '@/lib/constants';
import { useJiggleReorder } from '@/components/ui/jiggle-reorder';
import type { BankConnection, BankAccountLink, Currency } from '@/types';

/** Role → icon. Shared between the account chips here and the bank page's
 * selected-account summary header. */
export function roleIcon(role: BankAccountLink['accountRole']) {
  if (role === 'credit-card') return <MdCreditCard className="opacity-70" />;
  if (role === 'savings') return <MdSavings className="opacity-70" />;
  return <MdAccountBalance className="opacity-70" />;
}

/** Status dot color + hover/long-press hint for a bank tab, reusing the same
 * consent-expiry detection the connection Tags use. */
function connectionDot(conn: BankConnection): { dotClass: string; title: string } {
  const info = getConsentExpiryInfo(conn);
  if (info.expired || conn.status === 'revoked') {
    return { dotClass: 'bg-red-500', title: 'Consent expired — reconnect in Settings' };
  }
  if (conn.status === 'error') {
    return { dotClass: 'bg-red-500', title: 'Sync error — check Settings' };
  }
  if (info.expiringSoon) {
    return { dotClass: 'bg-amber-500', title: `Consent expires in ${info.daysUntilExpiry}d — reconnect soon` };
  }
  if (conn.status === 'pending') {
    return { dotClass: 'bg-gray-400', title: 'Pending — awaiting first sync' };
  }
  return { dotClass: 'bg-green-500', title: 'Connected' };
}

function accountLabel(link: BankAccountLink): string {
  return (
    link.customName ||
    link.name ||
    maskIban(link.iban) ||
    (link.accountRole === 'credit-card' ? 'Credit card' : 'Account')
  );
}

function balanceLabel(link: BankAccountLink): string {
  if (link.accountRole === 'credit-card') {
    return typeof link.outstanding === 'number'
      ? `owed ${formatCurrency(link.outstanding, link.currency as Currency)}`
      : '';
  }
  return typeof link.lastBalance === 'number' ? formatCurrency(link.lastBalance, link.currency as Currency) : '';
}

interface AccountPickerProps {
  connections: BankConnection[];
  selectedId: string | null;
  onSelect: (linkId: string) => void;
  /** Shared jiggle-mode state — long-pressing either row enables reorder for
   * both. Controlled by the page (which also owns the persisted order). */
  jiggling: boolean;
  onJiggleChange: (next: boolean) => void;
  onReorderBanks: (nextConnectionIds: string[]) => void;
  onReorderAccounts: (connectionId: string, nextLinkIds: string[]) => void;
}

/**
 * Sticky bank + account switcher for the bank page. Row 1 (hidden with a single
 * bank) picks the active bank; row 2 shows that bank's accounts as chips. Both
 * rows scroll horizontally instead of wrapping, so a household with several
 * banks/accounts never overflows a 390px viewport. Long-press a chip to enter
 * iOS-style jiggle mode and drag chips into a new order.
 */
export function AccountPicker({
  connections,
  selectedId,
  onSelect,
  jiggling,
  onJiggleChange,
  onReorderBanks,
  onReorderAccounts,
}: AccountPickerProps) {
  const router = useRouter();
  // Only needed as a fallback for a bank with zero accounts (there's no account
  // selection to derive "active bank" from in that case); whenever the selected
  // account belongs to a connection, that connection wins.
  const [manualActiveConnId, setManualActiveConnId] = useState<string | null>(null);

  const ownerConn = connections.find((c) => c.linkedAccounts.some((a) => a.id === selectedId));
  const activeConn = ownerConn ?? connections.find((c) => c.id === manualActiveConnId) ?? connections[0] ?? null;

  // Two jiggle instances sharing one controlled mode: the bank tabs (x axis)
  // and the active bank's account chips (x axis). Hooks must run every render,
  // so they precede the early `return null`.
  const banksReorder = useJiggleReorder({
    ids: connections.map((c) => c.id),
    axis: 'x',
    jiggling,
    onJiggleChange,
    onReorder: (nextIds) => onReorderBanks(nextIds),
    disabled: connections.length < 2,
  });
  const accountsReorder = useJiggleReorder({
    ids: activeConn?.linkedAccounts.map((a) => a.id) ?? [],
    axis: 'x',
    jiggling,
    onJiggleChange,
    onReorder: (nextIds) => {
      if (activeConn) onReorderAccounts(activeConn.id, nextIds);
    },
    disabled: (activeConn?.linkedAccounts.length ?? 0) < 2,
  });

  if (!activeConn) return null;

  const { ref: banksRef, ...banksRest } = banksReorder.containerProps;
  const { ref: accountsRef, ...accountsRest } = accountsReorder.containerProps;
  const canReorder = connections.length > 1 || activeConn.linkedAccounts.length > 1;

  const selectBank = (conn: BankConnection) => {
    setManualActiveConnId(conn.id);
    if (conn.linkedAccounts[0]) onSelect(conn.linkedAccounts[0].id);
  };

  return (
    <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] lg:top-0 z-30 bg-gray-50 dark:bg-gray-900 -mx-2 px-2 sm:-mx-4 sm:px-4 lg:-mx-6 lg:px-6 pt-2 pb-1">
      {canReorder && (
        <button
          type="button"
          onClick={() => onJiggleChange(true)}
          className="sr-only focus:not-sr-only focus:mb-2 focus:inline-flex focus:items-center focus:min-h-[44px] focus:px-3 focus:rounded-lg focus:border focus:surface-border"
        >
          Reorder accounts
        </button>
      )}

      {connections.length > 1 && (
        <div ref={banksRef as React.Ref<HTMLDivElement>} {...banksRest} className="flex gap-2 overflow-x-auto pb-1.5">
          {connections.map((conn) => {
            const dot = connectionDot(conn);
            const active = conn.id === activeConn.id;
            const { ref: itemRef, ...itemRest } = banksReorder.getItemProps(conn.id);
            return (
              <button
                key={conn.id}
                ref={itemRef as React.Ref<HTMLButtonElement>}
                type="button"
                onClick={() => selectBank(conn)}
                {...itemRest}
                className={`shrink-0 inline-flex items-center whitespace-nowrap rounded-full px-3 min-h-[36px] text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[var(--primary-color)] text-[var(--primary-color-text)]'
                    : 'border surface-border opacity-70 hover:opacity-100'
                }`}
              >
                <span data-jiggle-inner="" className="flex items-center gap-1.5">
                  {conn.aspspName}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dot.dotClass}`} title={dot.title} />
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div ref={accountsRef as React.Ref<HTMLDivElement>} {...accountsRest} className="flex gap-2 overflow-x-auto py-1">
        {activeConn.linkedAccounts.length === 0 ? (
          <button
            type="button"
            onClick={() => router.push('/settings?tab=banking')}
            className="shrink-0 whitespace-nowrap flex items-center gap-2 rounded-lg border surface-border px-3 min-h-[44px] text-sm opacity-60 hover:opacity-100"
          >
            No accounts — connect in Settings
          </button>
        ) : (
          activeConn.linkedAccounts.map((link) => {
            const selected = link.id === selectedId;
            const balance = balanceLabel(link);
            const { ref: itemRef, ...itemRest } = accountsReorder.getItemProps(link.id);
            return (
              <button
                key={link.id}
                ref={itemRef as React.Ref<HTMLButtonElement>}
                type="button"
                onClick={() => onSelect(link.id)}
                {...itemRest}
                className={`shrink-0 inline-flex items-center rounded-lg px-3 min-h-[44px] text-left transition-colors ${
                  selected ? 'bg-[var(--primary-color)] text-[var(--primary-color-text)]' : 'border surface-border'
                }`}
              >
                <span data-jiggle-inner="" className="flex items-center gap-2">
                  {roleIcon(link.accountRole)}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate max-w-[10rem]">{accountLabel(link)}</div>
                    {balance && <div className="text-xs opacity-70 truncate max-w-[10rem]">{balance}</div>}
                  </div>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
