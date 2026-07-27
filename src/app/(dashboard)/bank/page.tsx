'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { Skeleton } from 'primereact/skeleton';
import { ListPageSkeleton } from '@/components/ui/skeletons';
import { DelayedSkeleton } from '@/components/ui/delayed-loading';
import { MdAccountBalance, MdSettings, MdRefresh, MdAutorenew } from 'react-icons/md';
import {
  getBankConnections,
  getBankTransactionsForLink,
  refreshBankConnection,
  reconnectBankConnection,
} from '@/lib/actions/bank';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { useToast } from '@/components/providers/toast-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { getMySplitLinkCandidates } from '@/lib/actions/split-groups';
import { matchTransactionsToSplits } from '@/lib/bank-split-match';
import { maskIban, getConsentExpiryInfo, sortConnectionsByAccountOrder, effectiveCardNumbers } from '@/lib/bank-utils';
import { formatCurrency } from '@/lib/constants';
import { BankLedgerTable } from '@/components/bank/bank-ledger-table';
import { AccountPicker, roleIcon } from '@/components/bank/account-picker';
import { JiggleModeBar } from '@/components/ui/jiggle-reorder';
import { updateBankAccountOrder } from '@/lib/actions/user-preferences';
import { RecurringSuggestions } from '@/components/bank/recurring-suggestions';
import type {
  BankConnection,
  BankAccountLink,
  BankTransaction,
  BankConnectionStatus,
  Currency,
  SplitLinkCandidate,
} from '@/types';

function statusSeverity(status: BankConnectionStatus): 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'active':
      return 'success';
    case 'pending':
      return 'info';
    case 'expired':
    case 'revoked':
      return 'warning';
    case 'error':
      return 'danger';
  }
}

/** Skeleton shape for the ledger region only — the header/picker above render
 * immediately once connections are loaded. */
function LedgerSkeleton() {
  return (
    <DelayedSkeleton>
      <div className="space-y-2">
        <Skeleton height="2.5rem" borderRadius="0.5rem" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} height="3.25rem" borderRadius="0.5rem" />
        ))}
      </div>
    </DelayedSkeleton>
  );
}

/** useSearchParams requires a Suspense boundary during prerendering, so the
 * page shell just wraps the real component. */
export default function BankPage() {
  return (
    <Suspense fallback={null}>
      <BankPageInner />
    </Suspense>
  );
}

function BankPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  // Subscribe to the app context so this money-rendering subtree re-renders when
  // the global demo mask toggles (formatCurrency output depends on it).
  useAppContext();
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [accountOrder, setAccountOrder] = useState<string[] | undefined>(undefined);
  // iOS-style jiggle reorder: long-press a picker chip to enter, drag to
  // rearrange, "Done" (or Escape) to exit. Order persists on every move.
  const [jiggling, setJiggling] = useState(false);
  const movedWhileReorderingRef = useRef(false);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [ledgers, setLedgers] = useState<Record<string, BankTransaction[]>>({});
  const [ledgerLoadingId, setLedgerLoadingId] = useState<string | null>(null);
  const [candidatesByLink, setCandidatesByLink] = useState<Record<string, SplitLinkCandidate[]>>({});
  const [highlightTxId, setHighlightTxId] = useState<string | undefined>(undefined);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  // Bumped after a manual refresh so the ledger effect refetches even for
  // accounts already marked as loaded in loadedLedgersRef.
  const [ledgerVersion, setLedgerVersion] = useState(0);
  const hasLoadedOnce = useRef(false);
  // Which accounts' ledgers have been fetched (lazily, on selection).
  const loadedLedgersRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!hasLoadedOnce.current) setLoading(true);
    try {
      const [res, prefsRes] = await Promise.all([getBankConnections(), getUserPreferences()]);
      if (res.success && res.data) setConnections(res.data);
      if (prefsRes.success && prefsRes.data) setAccountOrder(prefsRes.data.bankAccountOrder);
    } finally {
      hasLoadedOnce.current = true;
      setLoading(false);
    }
  }, []);

  // Manual "Refresh" — syncs every connected bank sequentially (fine at this
  // scale), then refetches so balances/ledger reflect the new sync. The
  // MIN_MANUAL_REFRESH_INTERVAL_MS "too soon" error is common (e.g. right
  // after a scheduled sync) and not actionable, so it surfaces as an info
  // toast rather than a scary error.
  const handleRefreshAll = useCallback(async () => {
    if (connections.length === 0) return;
    setRefreshingAll(true);
    const failures: string[] = [];
    let tooSoon = false;
    try {
      for (const conn of connections) {
        const res = await refreshBankConnection(conn.id);
        if (!res.success) {
          if (res.error?.toLowerCase().includes('wait')) tooSoon = true;
          else failures.push(conn.aspspName);
        }
      }
      await load();
      // Drop the "already fetched" marks so the ledger effect refetches the
      // selected account's transactions (new rows from the sync would otherwise
      // stay hidden until a full page reload). Existing rows stay on screen
      // while the refetch runs — no skeleton flash.
      loadedLedgersRef.current.clear();
      setLedgerVersion((v) => v + 1);
    } finally {
      setRefreshingAll(false);
    }
    if (failures.length > 0) {
      toast.error('Refresh failed', `Could not refresh: ${failures.join(', ')}`);
    } else if (tooSoon) {
      toast.info('Just synced', 'One or more banks were refreshed too recently — please wait a few minutes.');
    } else {
      toast.success('Refreshed', 'Balances refreshed');
    }
  }, [connections, load, toast]);

  // Consent renewal — identical flow to the Settings banking panel
  // (bank-connections-panel.tsx handleReconnect): re-run SCA on the same
  // connection, then redirect the browser to the bank's auth URL.
  const handleRenewConsent = useCallback(
    async (connectionId: string) => {
      setReconnectingId(connectionId);
      const res = await reconnectBankConnection(connectionId);
      setReconnectingId(null);
      if (res.success && res.data?.authUrl) {
        window.location.href = res.data.authUrl; // re-run SCA; mappings are preserved
      } else {
        toast.error('Error', res.error ?? 'Could not start reconnection');
      }
    },
    [toast]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Deep link: ?account= preselects an account, ?tx= asks the ledger to
  // scroll/flash a specific row (consumed once by BankLedgerTable, which
  // strips it from the URL after triggering the highlight). Reactive
  // useSearchParams (not a read-once window.location): on a client-side
  // navigation from another page, mount effects can run before the router
  // has synced window.location to the new URL, silently dropping the params.
  useEffect(() => {
    const account = searchParams.get('account');
    const tx = searchParams.get('tx');
    if (account) setSelectedLinkId(account);
    setHighlightTxId(tx ?? undefined);
  }, [searchParams]);

  // Connections + their linked accounts in the user's curated display order
  // (identity when no order is set). Drives the picker, the default selection,
  // and the flattened link list so everything reflects the same order.
  const sortedConnections = useMemo(
    () => sortConnectionsByAccountOrder(connections, accountOrder),
    [connections, accountOrder]
  );

  // Persist a rearranged connection list as the flat curated id order. Local
  // state updates first so the chips re-sort instantly; the server write
  // re-sanitizes against real link ids and only surfaces a toast on failure.
  const persistOrderFrom = useCallback(
    (conns: BankConnection[]) => {
      const flat = conns.flatMap((c) => c.linkedAccounts.map((a) => a.id));
      setAccountOrder(flat);
      movedWhileReorderingRef.current = true;
      void updateBankAccountOrder(flat).then((res) => {
        if (!res.success) toast.error('Could not save order', res.error);
      });
    },
    [toast]
  );

  // Reorder the whole bank blocks (jiggle drag on the bank tabs row).
  const handleReorderBanks = useCallback(
    (nextConnectionIds: string[]) => {
      const byId = new Map(sortedConnections.map((c) => [c.id, c]));
      const reordered = nextConnectionIds.map((id) => byId.get(id)).filter((c): c is BankConnection => !!c);
      for (const c of sortedConnections) if (!nextConnectionIds.includes(c.id)) reordered.push(c);
      persistOrderFrom(reordered);
    },
    [sortedConnections, persistOrderFrom]
  );

  // Reorder the account chips within one bank (jiggle drag on the accounts row).
  const handleReorderAccounts = useCallback(
    (connectionId: string, nextLinkIds: string[]) => {
      const conns = sortedConnections.map((c) => {
        if (c.id !== connectionId) return c;
        const byId = new Map(c.linkedAccounts.map((a) => [a.id, a]));
        const reordered = nextLinkIds.map((id) => byId.get(id)).filter((a): a is BankAccountLink => !!a);
        for (const a of c.linkedAccounts) if (!nextLinkIds.includes(a.id)) reordered.push(a);
        return { ...c, linkedAccounts: reordered };
      });
      persistOrderFrom(conns);
    },
    [sortedConnections, persistOrderFrom]
  );

  const handleJiggleChange = useCallback(
    (next: boolean) => {
      setJiggling(next);
      if (next) movedWhileReorderingRef.current = false;
      else if (movedWhileReorderingRef.current) {
        toast.success('Account order saved');
        movedWhileReorderingRef.current = false;
      }
    },
    [toast]
  );

  // Default selection: the first account of the first (sorted) connection, once
  // connections have loaded — never overrides a ?account= deep link or a
  // click that already set a selection.
  useEffect(() => {
    if (selectedLinkId || sortedConnections.length === 0) return;
    const first = sortedConnections.find((c) => c.linkedAccounts.length > 0)?.linkedAccounts[0];
    if (first) setSelectedLinkId(first.id);
  }, [sortedConnections, selectedLinkId]);

  // Lazily fetch + cache the ledger for whichever account is selected.
  useEffect(() => {
    if (!selectedLinkId || loadedLedgersRef.current.has(selectedLinkId)) return;
    loadedLedgersRef.current.add(selectedLinkId);
    let active = true;
    setLedgerLoadingId(selectedLinkId);
    getBankTransactionsForLink(selectedLinkId).then((res) => {
      if (!active) return;
      if (res.success && res.data) setLedgers((prev) => ({ ...prev, [selectedLinkId]: res.data! }));
      setLedgerLoadingId((cur) => (cur === selectedLinkId ? null : cur));
    });
    return () => {
      active = false;
    };
  }, [selectedLinkId, ledgerVersion]);

  // Split-candidate wiring: once a ledger is loaded, fetch cross-group split
  // candidates for the months it covers so rows can be flagged "already
  // split" (see src/lib/bank-split-match.ts).
  const loadCandidatesFor = useCallback(async (linkId: string, txs: BankTransaction[]) => {
    const months = [...new Set(txs.map((t) => t.bookingDate.slice(0, 7)))];
    const res = months.length > 0 ? await getMySplitLinkCandidates(months) : null;
    setCandidatesByLink((prev) => ({ ...prev, [linkId]: res?.success && res.data ? res.data : [] }));
  }, []);

  useEffect(() => {
    if (!selectedLinkId) return;
    const txs = ledgers[selectedLinkId];
    if (!txs || candidatesByLink[selectedLinkId]) return;
    loadCandidatesFor(selectedLinkId, txs);
    // Only (re)run when the ledger first appears for this link — candidatesByLink
    // and loadCandidatesFor are intentionally excluded so a later invalidation
    // (handleSplitSaved) doesn't get immediately overwritten by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLinkId, ledgers]);

  const handleSplitSaved = useCallback(() => {
    if (!selectedLinkId) return;
    const txs = ledgers[selectedLinkId];
    if (txs) loadCandidatesFor(selectedLinkId, txs);
  }, [selectedLinkId, ledgers, loadCandidatesFor]);

  const splitMatches = useMemo(() => {
    if (!selectedLinkId) return undefined;
    const txs = ledgers[selectedLinkId] ?? [];
    const candidates = candidatesByLink[selectedLinkId] ?? [];
    return matchTransactionsToSplits(txs, candidates);
  }, [selectedLinkId, ledgers, candidatesByLink]);

  const selectAccount = useCallback(
    (linkId: string) => {
      setSelectedLinkId(linkId);
      router.replace(`/bank?account=${linkId}`, { scroll: false });
    },
    [router]
  );

  const allLinks = useMemo(
    () => sortedConnections.flatMap((conn) => conn.linkedAccounts.map((link) => ({ link, conn }))),
    [sortedConnections]
  );
  const selected = allLinks.find((x) => x.link.id === selectedLinkId);

  if (loading) {
    return <ListPageSkeleton />;
  }

  return (
    <div className="space-y-4 lg:space-y-6 max-w-4xl mx-auto py-4 lg:py-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Bank</h1>
          <p className="text-sm opacity-60">
            Connected accounts and imported transactions (read-only, via Enable Banking).
          </p>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0 self-start sm:self-auto">
          <Button
            label="Refresh"
            icon={<MdRefresh />}
            outlined
            size="small"
            loading={refreshingAll}
            disabled={connections.length === 0}
            onClick={handleRefreshAll}
          />
          <Button
            label="Manage connections"
            icon={<MdSettings />}
            outlined
            size="small"
            onClick={() => router.push('/settings?tab=banking')}
          />
        </div>
      </div>

      <RecurringSuggestions />

      {connections.length === 0 ? (
        <Card>
          <div className="flex flex-col items-center text-center gap-3 py-8 opacity-70">
            <MdAccountBalance size={36} className="opacity-50" />
            <p>No banks connected yet.</p>
            <Button label="Connect a bank" onClick={() => router.push('/settings?tab=banking')} />
          </div>
        </Card>
      ) : (
        <>
          <AccountPicker
            connections={sortedConnections}
            selectedId={selectedLinkId}
            onSelect={selectAccount}
            jiggling={jiggling}
            onJiggleChange={handleJiggleChange}
            onReorderBanks={handleReorderBanks}
            onReorderAccounts={handleReorderAccounts}
          />

          {selected && (
            <>
              {/* Selected-account summary: icon, name, masked IBAN, currency,
                  role, balance, plus the owning connection's status + consent
                  Tags (moved here from the removed per-connection Card). */}
              <div className="rounded-xl border surface-border p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    {roleIcon(selected.link.accountRole)}
                    <div className="min-w-0">
                      <div className="font-semibold truncate">
                        {selected.link.customName ||
                          selected.link.name ||
                          (selected.link.accountRole === 'credit-card' ? 'Credit card' : 'Account')}
                      </div>
                      <div className="text-xs opacity-60">
                        {maskIban(selected.link.iban)} · {selected.link.currency} · {selected.link.accountRole}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1 shrink-0">
                    <Tag value={selected.conn.status} severity={statusSeverity(selected.conn.status)} />
                    {(() => {
                      const expiry = getConsentExpiryInfo(selected.conn);
                      if (!expiry.expired && !expiry.expiringSoon) return null;
                      return (
                        <>
                          <Tag
                            value={expiry.expired ? 'consent expired' : `expires in ${expiry.daysUntilExpiry}d`}
                            severity="warning"
                          />
                          <Button
                            label="Renew consent"
                            icon={<MdAutorenew />}
                            size="small"
                            severity={expiry.expired ? 'danger' : 'warning'}
                            loading={reconnectingId === selected.conn.id}
                            onClick={() => handleRenewConsent(selected.conn.id)}
                          />
                        </>
                      );
                    })()}
                  </div>
                </div>
                {selected.link.accountRole === 'credit-card'
                  ? (() => {
                      const cur = selected.link.currency as Currency;
                      const eff = effectiveCardNumbers(selected.link);
                      const parts: string[] = [];
                      if (typeof eff.outstanding === 'number') parts.push(`owed ${formatCurrency(eff.outstanding, cur)}`);
                      if (typeof eff.availableCredit === 'number')
                        parts.push(`${formatCurrency(eff.availableCredit, cur)} available`);
                      if (typeof eff.creditLimit === 'number' && eff.creditLimit > 0)
                        parts.push(`of ${formatCurrency(eff.creditLimit, cur)} limit`);
                      // No card figures known → show the raw last balance, like a deposit account.
                      if (parts.length === 0) {
                        return typeof selected.link.lastBalance === 'number' ? (
                          <div className="text-sm opacity-80 mt-2">{formatCurrency(selected.link.lastBalance, cur)}</div>
                        ) : null;
                      }
                      return <div className="text-sm opacity-80 mt-2">{parts.join(' · ')}</div>;
                    })()
                  : typeof selected.link.lastBalance === 'number' && (
                      <div className="text-sm opacity-80 mt-2">
                        {formatCurrency(selected.link.lastBalance, selected.link.currency as Currency)}
                      </div>
                    )}
              </div>

              {ledgerLoadingId === selected.link.id && !ledgers[selected.link.id] ? (
                <LedgerSkeleton />
              ) : (
                <BankLedgerTable
                  key={selected.link.id}
                  transactions={ledgers[selected.link.id] ?? []}
                  currency={selected.link.currency as Currency}
                  linkedAccountId={selected.link.id}
                  bankName={selected.conn.aspspName}
                  splitMatches={splitMatches}
                  onSplitSaved={handleSplitSaved}
                  highlightTxId={highlightTxId}
                />
              )}
            </>
          )}
        </>
      )}

      <JiggleModeBar jiggling={jiggling} onDone={() => handleJiggleChange(false)} hint="Drag to reorder accounts" />
    </div>
  );
}
