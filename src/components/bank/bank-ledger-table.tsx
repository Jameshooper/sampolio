'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type DataTableExpandedRows, type DataTableValueArray } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Tag } from 'primereact/tag';
import { InputText } from 'primereact/inputtext';
import { IconField } from 'primereact/iconfield';
import { InputIcon } from 'primereact/inputicon';
import { Button } from 'primereact/button';
import { MdCallSplit, MdExpandMore } from 'react-icons/md';
import { formatCurrency, formatYearMonth } from '@/lib/constants';
import { useAppContext } from '@/components/layout/app-layout';
import { maskIban, txDisplayDate } from '@/lib/bank-utils';
import { guessCategory } from '@/lib/split-utils';
import { QuickAddSplitModal, type QuickAddSplitInitial } from '@/components/split/quick-add-split-modal';
import type { BankSplitMatch } from '@/lib/bank-split-match';
import type { BankTransaction, Currency, BankTransactionStatus } from '@/types';

const STATUS_TIP: Record<BankTransactionStatus, string> = {
  booked: 'Booked — settled and final; it appears on your statement and won’t change.',
  pending: 'Pending — authorized but not yet settled. The amount or date can still change, and it may merge into a booked entry later.',
  other: 'Other — the bank didn’t mark this entry as booked or pending.',
};

function statusSeverity(s: BankTransactionStatus): 'success' | 'warning' | 'info' {
  return s === 'booked' ? 'success' : s === 'pending' ? 'warning' : 'info';
}

/** Compact status dot color for the mobile row (green/amber/gray, no label). */
function statusDotClass(s: BankTransactionStatus): string {
  return s === 'booked' ? 'bg-green-500' : s === 'pending' ? 'bg-amber-500' : 'bg-gray-400';
}

/** Format a date string that may or may not carry a time component. */
function fmtDateTime(value: string): { date: string; time: string | null } {
  const hasTime = value.length > 10 || value.includes('T');
  const d = new Date(hasTime ? value : `${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { date: value, time: null };
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = hasTime ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  return { date, time };
}

/** Fixed-width 'dd.MM' for the compact mobile row (vs. the fuller `fmtDateTime`
 * used in the expanded detail / desktop columns). */
function fmtDateShort(value: string): string {
  const hasTime = value.length > 10 || value.includes('T');
  const d = new Date(hasTime ? value : `${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value.slice(5, 10).replace('-', '.');
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** How many month sections the mobile list shows initially / adds per load. */
const INITIAL_MONTHS = 3;
const MONTHS_STEP = 6;
const INITIAL_ROWS = 50;
const ROWS_STEP = 50;

/** Case-insensitive match on counterparty, remittance info, or amount digits. */
function matchesQuery(t: BankTransaction, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (t.counterpartyName?.toLowerCase().includes(needle)) return true;
  if (t.remittanceInfo?.toLowerCase().includes(needle)) return true;
  // Amount search: compare against both '.'- and ','-decimal renderings.
  const abs = Math.abs(t.amount);
  if (abs.toFixed(2).includes(needle.replace(',', '.'))) return true;
  return false;
}

/** "Already split" flag — a small pill, filled when the expense was created
 * from this exact transaction ("Split this"), dashed/outlined when it's only a
 * same-amount/nearby-date heuristic guess. Tapping deep-links into the split
 * group, landing on the matched expense's month. */
function SplitFlag({ match, txDate }: { match: BankSplitMatch; txDate: string }) {
  const router = useRouter();
  const isLinked = match.kind === 'linked';
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const month = txDate.slice(0, 7);
        router.push(`/split/${match.groupId}?expense=${match.expenseId}&month=${month}`);
      }}
      title={isLinked ? `Split in ${match.groupName}` : `Possibly already split in ${match.groupName}`}
      className={`inline-flex items-center gap-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${
        isLinked
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'border border-dashed border-gray-400 dark:border-gray-500 text-gray-500 dark:text-gray-400'
      }`}
    >
      <MdCallSplit className="text-[11px]" />
      {isLinked ? 'split' : 'split?'}
    </button>
  );
}

/** Read-only transaction ledger for one linked bank account. Desktop: a
 * scrollable, paginated PrimeReact DataTable with expandable detail rows.
 * Mobile: month-grouped sections with sticky headers + "Load older months"
 * (the split ledger pattern) so one account can't inflate the page to
 * thousands of pixels. Both views share a counterparty/amount search box and
 * an "already split" flag from `splitMatches` (see src/lib/bank-split-match.ts). */
export function BankLedgerTable({
  transactions,
  currency,
  linkedAccountId,
  bankName,
  splitMatches,
  onSplitSaved,
  highlightTxId,
}: {
  transactions: BankTransaction[];
  currency: Currency;
  linkedAccountId: string;
  bankName: string;
  splitMatches?: Map<string, BankSplitMatch>;
  onSplitSaved?: () => void;
  highlightTxId?: string;
}) {
  const router = useRouter();
  const demoMasked = useAppContext()?.demoMasked ?? false;
  const [expanded, setExpanded] = useState<DataTableExpandedRows | DataTableValueArray>([]);
  const [expandedMobile, setExpandedMobile] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [visibleMonths, setVisibleMonths] = useState(INITIAL_MONTHS);
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS);
  // "Split this" — quick-add split dialog prefilled from a spend transaction.
  const [splitInitial, setSplitInitial] = useState<QuickAddSplitInitial | null>(null);

  const openSplitFor = (t: BankTransaction) => {
    const title = t.counterpartyName ?? t.remittanceInfo?.split('\n')[0] ?? '';
    setSplitInitial({
      title,
      amount: Math.abs(t.amount),
      date: txDisplayDate(t), // prefill with the purchase date, not the booking date
      category: guessCategory(title),
      bankLink: {
        txId: t.id,
        linkedAccountId,
        bookingDate: t.bookingDate.slice(0, 10),
        amount: t.amount,
        currency: t.currency,
        counterpartyName: t.counterpartyName,
        bankName,
      },
    });
  };

  // Filtered, then re-sorted descending by the displayed (purchase) date: the
  // incoming array is bookingDate-sorted, but a purchase can date up to a few
  // days before its booking, so rendering it in bookingDate order would show
  // rows out of order. `dedupKey` breaks ties so same-day rows keep a stable,
  // deterministic order across renders.
  const filtered = useMemo(
    () =>
      transactions
        .filter((t) => matchesQuery(t, query.trim()))
        .slice()
        .sort(
          (a, b) => txDisplayDate(b).localeCompare(txDisplayDate(a)) || b.dedupKey.localeCompare(a.dedupKey)
        ),
    [transactions, query]
  );

  // Desktop rows carry their split match ON the row object: PrimeReact memoizes
  // BodyRow/BodyCell, so a `splitMatches` map that arrives after first render
  // (candidates load async) never reaches already-rendered cells through the
  // column-body closure alone — fresh row identities force the re-render.
  type LedgerRow = BankTransaction & { _splitMatch?: BankSplitMatch };
  const desktopRows = useMemo<LedgerRow[]>(
    () => filtered.map((t) => ({ ...t, _splitMatch: splitMatches?.get(t.id) })),
    [filtered, splitMatches]
  );

  // Month-grouped (desc) for the mobile list.
  const byMonth = useMemo(() => {
    const map = new Map<string, BankTransaction[]>();
    for (const t of filtered) {
      const ym = txDisplayDate(t).slice(0, 7);
      const arr = map.get(ym) ?? [];
      arr.push(t);
      map.set(ym, arr);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);
  const visibleByMonth = byMonth.slice(0, visibleMonths);

  // Desktop infinite scroll: reveal more rows when the DataTable's inner
  // scroll area (`.p-datatable-wrapper`, the `scrollHeight` container) nears
  // its end. Listener re-binds per selected account (the wrapper node is
  // recreated) via the transactions dep.
  const desktopWrapRef = useRef<HTMLDivElement | null>(null);
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;
  useEffect(() => {
    const scroller = desktopWrapRef.current?.querySelector('.p-datatable-wrapper');
    if (!scroller) return;
    const onScroll = () => {
      if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 300) return;
      if (visibleRowsRef.current >= filtered.length) return;
      setVisibleRows((v) => Math.min(v + ROWS_STEP, filtered.length));
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [transactions, filtered.length]);

  // Mobile infinite scroll: auto-load older months when the sentinel below the
  // list enters the viewport (the mobile list scrolls with the page, not an
  // inner container). The "Load older months" button stays as a fallback.
  const mobileSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = mobileSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisibleMonths((v) => (v < byMonth.length ? v + MONTHS_STEP : v));
      }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
    // visibleMonths dep: re-observe after each reveal so a sentinel that is
    // STILL in view (tall viewport) fires again — IntersectionObserver only
    // reports intersection *changes*.
  }, [byMonth.length, visibleMonths]);

  // Deep-link highlight (?tx=): scroll + flash the matching row on both the
  // mobile list and the desktop table, expanding whichever is visible and
  // paging/loading-more months as needed. Runs once per highlightTxId value —
  // completion (not entry) marks `highlightedOnceRef`, so React 18 dev-mode's
  // mount→cleanup→mount double-invoke (which cancels the first run's pending
  // timeout) doesn't leave the second, kept invocation bailing out early
  // before the scroll/flash/URL-strip ever actually runs.
  const highlightedOnceRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!highlightTxId) {
      // Param consumed/cleared — allow a later navigation to the same tx to
      // trigger a fresh highlight.
      highlightedOnceRef.current = undefined;
      return;
    }
    if (highlightedOnceRef.current === highlightTxId) return;
    const tx = transactions.find((t) => t.id === highlightTxId);
    if (!tx) return;

    const ym = txDisplayDate(tx).slice(0, 7);
    const monthIdx = byMonth.findIndex(([m]) => m === ym);
    if (monthIdx >= 0 && monthIdx >= visibleMonths) setVisibleMonths(monthIdx + 1);
    setExpandedMobile((m) => ({ ...m, [tx.id]: true }));

    const idx = filtered.findIndex((t) => t.id === highlightTxId);
    if (idx >= 0) setVisibleRows((v) => Math.max(v, idx + 1 + ROWS_STEP / 2));
    setExpanded((prev) => {
      const base = prev && typeof prev === 'object' && !Array.isArray(prev) ? (prev as DataTableExpandedRows) : {};
      return { ...base, [tx.id]: true };
    });

    // Give the state updates above (month/page reveal) a tick to render before
    // locating the row in the DOM. Both the mobile <li> and the desktop <tr>
    // carry the same `bank-tx-row-{id}` class — only one is ever laid out
    // (the other is `display:none` via the lg breakpoint), so `offsetParent`
    // picks the visible one. Polls briefly (rather than a single fixed delay)
    // since the DataTable's own re-render after expanding/paging can lag a
    // tick behind our state update. The URL strip (router.replace) happens
    // only once this settles — calling it immediately, while Next's App
    // Router is still reconciling the just-completed hard navigation, can
    // get silently dropped/overwritten.
    let cancelled = false;
    let attempts = 0;
    const finish = () => {
      if (cancelled) return;
      highlightedOnceRef.current = highlightTxId;
      router.replace(`/bank?account=${linkedAccountId}`, { scroll: false });
    };
    const tryScroll = () => {
      if (cancelled) return;
      const nodes = document.querySelectorAll(`.bank-tx-row-${tx.id}`);
      let el: HTMLElement | null = null;
      nodes.forEach((n) => {
        if (!el && (n as HTMLElement).offsetParent !== null) el = n as HTMLElement;
      });
      if (el) {
        (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
        (el as HTMLElement).classList.add('flash-highlight');
        setTimeout(() => (el as HTMLElement).classList.remove('flash-highlight'), 2000);
        finish();
        return;
      }
      attempts += 1;
      if (attempts < 30) setTimeout(tryScroll, 100);
      else finish(); // give up finding the row, but still clean up the URL
    };
    const t0 = setTimeout(tryScroll, 100);

    return () => {
      cancelled = true;
      clearTimeout(t0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightTxId, transactions]);

  if (transactions.length === 0) {
    return <p className="text-sm opacity-60">No transactions cached yet — try Refresh now in Settings.</p>;
  }

  const dateBody = (t: BankTransaction) => {
    const { date, time } = fmtDateTime(txDisplayDate(t));
    return (
      <div className="whitespace-nowrap">
        <div>{date}</div>
        {time && <div className="text-xs opacity-60">{time}</div>}
      </div>
    );
  };

  const counterpartyBody = (t: BankTransaction) => (
    <div className="min-w-[12rem]">
      <div className="font-medium text-sm">{t.counterpartyName ?? '—'}</div>
      {t.remittanceInfo && (
        <div className="text-xs opacity-70 whitespace-pre-line">{t.remittanceInfo}</div>
      )}
      {t.bankTransactionCode && (
        <div className="text-xs opacity-50 italic mt-0.5">{t.bankTransactionCode}</div>
      )}
    </div>
  );

  const amountBody = (t: BankTransaction) => (
    <span className={t.amount < 0 ? 'text-red-500 font-medium' : 'text-green-600 font-medium'}>
      {formatCurrency(t.amount, currency)}
    </span>
  );

  // Native `title` for the hover hint: the app-wide PrimeReact tooltip
  // (sidebar-nav, target="[data-pr-tooltip]") doesn't reliably bind to these
  // dynamically-rendered DataTable cells, and a co-located one double-renders.
  // The full meaning is also repeated in the expandable row for touch devices,
  // where no hover tooltip can ever show.
  const statusBody = (t: BankTransaction) => (
    <span className="cursor-help" title={STATUS_TIP[t.status]}>
      <Tag value={t.status} severity={statusSeverity(t.status)} />
    </span>
  );

  const splitFlagBody = (t: BankTransaction & { _splitMatch?: BankSplitMatch }) => {
    const match = t._splitMatch ?? splitMatches?.get(t.id);
    return match ? <SplitFlag match={match} txDate={txDisplayDate(t)} /> : null;
  };

  const detailRow = (label: string, value: string | null | undefined) =>
    value ? (
      <div className="flex gap-2">
        <span className="opacity-60 w-40 shrink-0">{label}</span>
        <span className="break-all">{value}</span>
      </div>
    ) : null;

  const rowExpansion = (t: BankTransaction) => (
    <div className="px-4 py-3 text-xs space-y-1 bg-black/5 dark:bg-white/5">
      {/* Repeat the status with its full meaning here: hover tooltips don't
          exist on touch devices, but the row expands on tap. */}
      <div className="flex gap-2">
        <span className="opacity-60 w-40 shrink-0">Status</span>
        <span>{STATUS_TIP[t.status]}</span>
      </div>
      {/* Always shown: the row can now display the purchase date instead of
          the booking date (see txDisplayDate), so the true booking date must
          stay inspectable here. */}
      {detailRow('Booking date', t.bookingDate)}
      {detailRow('Value date', t.valueDate)}
      {detailRow('Transaction date', t.transactionDate)}
      {detailRow('Counterparty account', maskIban(t.counterpartyAccount) || undefined)}
      {detailRow('Bank transaction type', t.bankTransactionCode)}
      {detailRow('Merchant category', t.merchantCategoryCode)}
      {detailRow(
        'Balance after',
        typeof t.balanceAfter === 'number' ? formatCurrency(t.balanceAfter, currency) : undefined
      )}
      {detailRow('Note', t.note)}
      {detailRow('Bank reference', t.entryReference)}
      <div className="flex gap-2">
        <span className="opacity-60 w-40 shrink-0">First seen</span>
        <span>{new Date(t.firstSeenAt).toLocaleString('en-GB')}</span>
      </div>
      {t.amount < 0 && (
        <div className="pt-2">
          <Button
            label="Split this"
            icon={<MdCallSplit />}
            size="small"
            outlined
            onClick={() => openSplitFor(t)}
          />
        </div>
      )}
    </div>
  );

  // Desktop row action: spend rows (amount < 0) can be sent to the split
  // quick-add dialog prefilled. Native `title` for the hint (see statusBody).
  const splitActionBody = (t: BankTransaction) =>
    t.amount < 0 ? (
      <Button
        icon={<MdCallSplit />}
        text
        size="small"
        className="!p-1"
        title="Split this in a split group"
        aria-label="Split this"
        onClick={() => openSplitFor(t)}
      />
    ) : null;

  return (
    <>
      {/* Search — counterparty, description, or amount */}
      <div className="mb-2">
        <IconField iconPosition="left" className="w-full">
          <InputIcon className="pi pi-search" />
          <InputText
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleMonths(INITIAL_MONTHS);
              setVisibleRows(INITIAL_ROWS);
            }}
            placeholder="Search counterparty or amount…"
            // `!pl-10` (matches the theme's own .p-icon-field-left > .p-inputtext
            // rule): globals.css's unlayered "Input field improvements" padding
            // override always beats PrimeReact's @layer-wrapped theme CSS
            // regardless of specificity, so without this the icon overlaps the
            // placeholder text. Same !important idiom the color-override block
            // in globals.css documents for this exact unlayered-vs-layered gap.
            className="w-full !pl-10 p-inputtext-sm"
          />
        </IconField>
        {query.trim() && (
          <p className="text-xs opacity-60 mt-1">
            {filtered.length} of {transactions.length} transactions match
          </p>
        )}
      </div>

      {/* Desktop: full DataTable — infinite scroll (rows revealed as the inner
          scroll area approaches its end) instead of a paginator. All data is
          already client-side; PrimeReact's virtualScroller is incompatible
          with rowExpansion (fixed itemSize), so windowed reveal it is. */}
      <div className="hidden lg:block" ref={desktopWrapRef}>
        <DataTable
          // Remount when demo mode flips: DataTable's memoized internals keep
          // stale formatCurrency output across re-renders otherwise.
          key={demoMasked ? 'masked' : 'plain'}
          value={desktopRows.slice(0, visibleRows)}
          scrollable
          scrollHeight="60vh"
          size="small"
          stripedRows
          dataKey="id"
          expandedRows={expanded}
          onRowToggle={(e) => setExpanded(e.data)}
          rowExpansionTemplate={rowExpansion}
          rowClassName={(rowData) => `bank-tx-row-${rowData.id}`}
        >
          <Column expander style={{ width: '2.5rem' }} />
          <Column header="Date" body={dateBody} style={{ width: '8rem' }} />
          <Column header="Counterparty / details" body={counterpartyBody} />
          <Column header="Amount" body={amountBody} style={{ width: '9rem' }} align="right" />
          <Column header="Split" body={splitFlagBody} style={{ width: '6rem' }} />
          <Column header="Status" body={statusBody} style={{ width: '7rem' }} />
          <Column body={splitActionBody} style={{ width: '3rem' }} />
        </DataTable>
        <p className="text-xs opacity-50 text-right mt-1">
          {visibleRows < filtered.length
            ? `Showing ${Math.min(visibleRows, filtered.length)} of ${filtered.length} — scroll for more`
            : `${filtered.length} transactions`}
        </p>
      </div>

      {/* Mobile: month-grouped compact list with sticky headers + incremental load */}
      <div className="lg:hidden space-y-3">
        {visibleByMonth.map(([ym, rows]) => (
          <div key={ym}>
            <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 bg-gray-50 dark:bg-gray-900 py-1 text-sm font-semibold text-gray-500">
              {formatYearMonth(ym)}
            </div>
            <ul className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map((t) => {
                const open = !!expandedMobile[t.id];
                const match = splitMatches?.get(t.id);
                const displayTitle = t.counterpartyName ?? t.remittanceInfo?.split('\n')[0] ?? '—';
                const remittanceLine = t.remittanceInfo?.split('\n')[0];
                const hasLine2 = !!remittanceLine && remittanceLine !== displayTitle;
                return (
                  <li key={t.id} className={`flex flex-wrap items-stretch bank-tx-row-${t.id}`}>
                    <button
                      type="button"
                      onClick={() => setExpandedMobile((m) => ({ ...m, [t.id]: !m[t.id] }))}
                      className="flex-1 min-h-[44px] min-w-0 px-2 py-1.5 text-left"
                      aria-expanded={open}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-10 shrink-0 tabular-nums text-xs opacity-60">{fmtDateShort(txDisplayDate(t))}</span>
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${statusDotClass(t.status)}`}
                          title={STATUS_TIP[t.status]}
                        >
                          <span className="sr-only">{t.status}</span>
                        </span>
                        <span className="truncate flex-1 text-sm font-medium">{displayTitle}</span>
                        <span
                          className={`shrink-0 tabular-nums text-sm font-medium ${t.amount < 0 ? 'text-red-500' : 'text-green-600'}`}
                        >
                          {formatCurrency(t.amount, currency)}
                        </span>
                        <MdExpandMore
                          className={`shrink-0 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`}
                        />
                      </div>
                      {hasLine2 && (
                        <div className="flex items-center gap-2 mt-0.5 pl-12">
                          <span className="truncate text-xs opacity-60 flex-1">{remittanceLine}</span>
                        </div>
                      )}
                    </button>
                    {/* The flag is a real <button>, so it must be a SIBLING of the
                        expand button (nested buttons are invalid HTML and break
                        hydration), not inline with the row text. */}
                    {match && (
                      <span className="self-center shrink-0">
                        <SplitFlag match={match} txDate={txDisplayDate(t)} />
                      </span>
                    )}
                    {t.amount < 0 && (
                      <Button
                        icon={<MdCallSplit />}
                        text
                        size="small"
                        className="!min-w-11 !w-11 shrink-0"
                        aria-label="Split this"
                        onClick={(e) => {
                          e.stopPropagation();
                          openSplitFor(t);
                        }}
                      />
                    )}
                    {open && <div className="basis-full">{rowExpansion(t)}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div ref={mobileSentinelRef} aria-hidden className="h-px" />
        {byMonth.length > visibleMonths && (
          <div className="text-center">
            <Button label="Load older months" text size="small" onClick={() => setVisibleMonths((v) => v + MONTHS_STEP)} />
          </div>
        )}
        {filtered.length === 0 && (
          <p className="text-sm opacity-60 text-center py-4">No transactions match your search.</p>
        )}
      </div>

      {/* "Split this" — self-contained quick-add dialog, prefilled from the row */}
      <QuickAddSplitModal
        visible={!!splitInitial}
        onHide={() => setSplitInitial(null)}
        onSaved={onSplitSaved}
        initial={splitInitial ?? undefined}
      />
    </>
  );
}
