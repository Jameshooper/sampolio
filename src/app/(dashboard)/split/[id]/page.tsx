'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { format, parseISO } from 'date-fns';
import { Button } from 'primereact/button';
import { Menu } from 'primereact/menu';
import { confirmDialog } from 'primereact/confirmdialog';
import { MdArrowBack, MdAdd, MdMoreVert, MdSettings, MdRepeat, MdUploadFile, MdAccountBalance } from 'react-icons/md';
import { CategoryIcon } from '@/components/split/category-icon';
import { SplitExpenseDialog } from '@/components/split/split-expense-dialog';
import { SettleUpDialog } from '@/components/split/settle-up-dialog';
import { GroupFormDialog } from '@/components/split/group-form-dialog';
import { RecurrenceRuleDialog } from '@/components/split/recurrence-rule-dialog';
import { SplitImportDialog } from '@/components/split/split-import-dialog';
import { BankLinkDetailsDialog } from '@/components/split/bank-link-details-dialog';
import { DelayedSpinner } from '@/components/ui/delayed-loading';
import { SplitDetailSkeleton } from '@/components/ui/skeletons';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import {
  getSplitGroupView,
  getSplitExpenses,
  getSplitActivity,
  deleteSplitExpense,
  catchUpGroupRecurrences,
  deleteSplitRecurrenceRule,
  updateSplitRecurrenceRule,
  markSplitGroupSeen,
} from '@/lib/actions/split-groups';
import { getUserPreferences } from '@/lib/actions/user-preferences';
import { computeSeenWatermark } from '@/lib/split-utils';
import { SplitActivityFeed } from '@/components/split/split-activity-feed';
import { SelectButton } from 'primereact/selectbutton';
import { formatCents, formatYearMonth } from '@/lib/constants';
import { useToast } from '@/components/providers/toast-provider';
import { useCelebration } from '@/components/providers/celebration-provider';
import { useAppContext } from '@/components/layout/app-layout';
import { useDwellSeen } from '@/lib/hooks/use-dwell-seen';
import type {
  SplitGroup,
  SplitGroupSummary,
  SplitMemberBalance,
  SplitExpense,
  SplitExpenseItem,
  SplitPayment,
  SplitRecurrenceRule,
  SplitActivityEvent,
  SplitExpenseBankLink,
} from '@/types';

export default function SplitGroupDetailPage() {
  const params = useParams();
  const router = useRouter();
  const groupId = String(params.id);
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  const toast = useToast();
  const { celebrate } = useCelebration();
  const appContext = useAppContext();

  const [group, setGroup] = useState<SplitGroup | null>(null);
  const [summary, setSummary] = useState<SplitGroupSummary | null>(null);
  const [balances, setBalances] = useState<SplitMemberBalance[]>([]);
  const [expenses, setExpenses] = useState<SplitExpense[]>([]);
  const [visibleCount, setVisibleCount] = useState(3);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // "New since last visit": a watermark fetched once on mount and then FROZEN
  // for the visit (never advanced live, or rows would stop being "new" as you
  // scroll). undefined = still loading, null = no baseline yet (first visit).
  const [lastSeenSnapshot, setLastSeenSnapshot] = useState<string | null | undefined>(undefined);

  const [showExpense, setShowExpense] = useState(false);
  const [editExpense, setEditExpense] = useState<SplitExpenseItem | undefined>();
  const [showSettle, setShowSettle] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showRecurring, setShowRecurring] = useState(false);
  const [editRule, setEditRule] = useState<SplitRecurrenceRule | undefined>();

  const rowMenu = useRef<Menu>(null);
  const [menuTarget, setMenuTarget] = useState<SplitExpense | null>(null);

  // Reverse "linked bank transaction" flag on an expense row created via
  // "Split this" (bank/page.tsx): the owner deep-links back into their own
  // ledger; anyone else sees a display-only summary (they have no access to
  // the owner's bank data).
  const [bankLinkDialog, setBankLinkDialog] = useState<{ bankLink: SplitExpenseBankLink; memberName: string } | null>(null);

  // Deep link from the bank page's SplitFlag: ?expense=&month= locates and
  // flashes a specific row. Read via window.location (not useSearchParams) to
  // avoid a Suspense boundary, matching the settings page's ?tab= pattern.
  const [deepLinkExpenseId, setDeepLinkExpenseId] = useState<string | undefined>(undefined);
  const [deepLinkMonth, setDeepLinkMonth] = useState<string | undefined>(undefined);
  const didReadDeepLinkRef = useRef(false);
  const deepLinkDoneRef = useRef(false);
  useEffect(() => {
    if (didReadDeepLinkRef.current) return;
    didReadDeepLinkRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const expense = params.get('expense');
    const month = params.get('month');
    if (expense) setDeepLinkExpenseId(expense);
    if (month) setDeepLinkMonth(month);
  }, []);

  // Ledger vs recent-activity framing ("added by X yesterday", the Splitwise
  // mental model). Activity loads lazily on first switch.
  const [view, setView] = useState<'expenses' | 'activity'>('expenses');
  const [activity, setActivity] = useState<SplitActivityEvent[] | null>(null);
  useEffect(() => {
    if (view !== 'activity' || activity !== null) return;
    getSplitActivity(30, groupId).then((res) => {
      setActivity(res.success && res.data ? res.data : []);
    });
  }, [view, activity, groupId]);

  const monthsDesc = useMemo(() => [...(summary?.monthsWithData ?? [])].reverse(), [summary]);

  const loadExpenses = useCallback(
    async (months: string[]) => {
      if (months.length === 0) return setExpenses([]);
      const res = await getSplitExpenses(groupId, months);
      if (res.success && res.data) setExpenses(res.data);
    },
    [groupId],
  );

  const load = useCallback(async () => {
    const res = await getSplitGroupView(groupId);
    if (!res.success || !res.data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setGroup(res.data.group);
    setSummary(res.data.summary);
    setBalances(res.data.balances);
    setActivity(null); // stale after any mutation — refetch on next Activity view
    const desc = [...res.data.summary.monthsWithData].reverse();
    await loadExpenses(desc.slice(0, visibleCount));
    setLoading(false);
  }, [groupId, loadExpenses, visibleCount]);

  // Global mutations (e.g. the floating quick-add modal saving an expense into
  // this group) refresh the page through the AppContext callback — registered
  // separately from the fetch effect, per the app-wide pattern.
  useEffect(() => {
    if (appContext) appContext.setRefreshCallback(load);
  }, [appContext, load]);

  // First load: materialize any due recurrences, then fetch.
  useEffect(() => {
    let active = true;
    (async () => {
      await catchUpGroupRecurrences(groupId);
      if (active) await load();
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  // Infinite scroll: a sentinel below the list auto-loads the next window of
  // months when it nears the viewport (mirrors the mobile pattern in
  // bank-ledger-table.tsx). The "Load older months" button stays as an a11y
  // fallback + loading indicator. `loadingMoreRef` guards against a burst of
  // intersection callbacks firing overlapping loads.
  const loadingMoreRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    if (visibleCount >= monthsDesc.length) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const next = visibleCount + 6;
    setVisibleCount(next);
    await loadExpenses(monthsDesc.slice(0, next));
    setLoadingMore(false);
    loadingMoreRef.current = false;
  }, [visibleCount, monthsDesc, loadExpenses]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // Re-observe after each reveal (IO only reports intersection CHANGES) and
    // when the sentinel remounts — it's absent in the Activity view.
  }, [loadMore, visibleCount, monthsDesc.length, view]);

  // Deep link, step 1: once months are known, jump straight to the window
  // that should contain the target month (instead of "Load older months"
  // one page at a time).
  useEffect(() => {
    if (!deepLinkMonth || monthsDesc.length === 0) return;
    const idx = monthsDesc.indexOf(deepLinkMonth);
    if (idx >= 0 && idx >= visibleCount) {
      const next = idx + 1;
      setVisibleCount(next);
      loadExpenses(monthsDesc.slice(0, next));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkMonth, monthsDesc]);

  // Deep link, step 2: once the target expense is among the loaded rows,
  // scroll + flash it and strip the query params. If it isn't there yet
  // (e.g. the hint month was off, or the row moved), keep loading older
  // months until it's found or the group is exhausted — bounded by
  // monthsDesc.length so this can't loop forever. Completion (not entry) marks
  // `deepLinkDoneRef` — same reasoning as the bank ledger's highlight effect:
  // React 18 dev-mode's mount→cleanup→mount double-invoke cancels the first
  // run's pending timeout, so marking done eagerly would leave the second,
  // kept invocation bailing out before the scroll/flash/URL-strip ever ran.
  useEffect(() => {
    if (!deepLinkExpenseId || deepLinkDoneRef.current || loading) return;
    const found = expenses.some((x) => x.id === deepLinkExpenseId);
    if (found) {
      let cancelled = false;
      let attempts = 0;
      const tryScroll = () => {
        if (cancelled) return;
        const el = document.querySelector(`[data-expense-id="${deepLinkExpenseId}"]`) as HTMLElement | null;
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('flash-highlight');
          setTimeout(() => el.classList.remove('flash-highlight'), 2000);
          deepLinkDoneRef.current = true;
          router.replace(`/split/${groupId}`, { scroll: false });
          return;
        }
        attempts += 1;
        if (attempts < 30) setTimeout(tryScroll, 100);
        else {
          deepLinkDoneRef.current = true; // give up finding the row, but still clean up the URL
          router.replace(`/split/${groupId}`, { scroll: false });
        }
      };
      const t0 = setTimeout(tryScroll, 100);
      return () => {
        cancelled = true;
        clearTimeout(t0);
      };
    }
    if (visibleCount < monthsDesc.length) {
      loadMore();
    } else {
      deepLinkDoneRef.current = true; // exhausted every month — give up quietly
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkExpenseId, expenses, visibleCount, monthsDesc, loading]);

  // Fallback for the reduced-motion path (celebrate() returned false): scroll to
  // the freshly-created row and briefly flash it — same retry approach as the
  // deep-link effect above.
  const flashRow = useCallback((id: string) => {
    let attempts = 0;
    const tryFlash = () => {
      const el = document.querySelector(`[data-expense-id="${id}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('flash-highlight');
        setTimeout(() => el.classList.remove('flash-highlight'), 2000);
        return;
      }
      attempts += 1;
      if (attempts < 10) setTimeout(tryFlash, 100);
    };
    setTimeout(tryFlash, 100);
  }, []);

  // "New since last visit" — fetch the frozen watermark once. On a first-ever
  // visit (no baseline) stamp one now so nothing shows as new this time and a
  // future visit has something to compare against (ref-guarded, fire-and-forget).
  const seededBaselineRef = useRef(false);
  useEffect(() => {
    let active = true;
    getUserPreferences().then((res) => {
      if (!active) return;
      const snap = res.success ? res.data?.splitLastSeenAt?.[groupId] ?? null : null;
      setLastSeenSnapshot(snap);
      if (snap === null && !seededBaselineRef.current) {
        seededBaselineRef.current = true;
        void markSplitGroupSeen(groupId, new Date().toISOString());
      }
    });
    return () => {
      active = false;
    };
  }, [groupId]);

  // Rows created after the frozen watermark, by someone other than me.
  const newIds = useMemo(() => {
    const set = new Set<string>();
    if (!lastSeenSnapshot) return set; // null/undefined ⇒ no baseline, nothing new
    for (const e of expenses) {
      if (e.createdAt > lastSeenSnapshot && e.createdByUserId !== myId) set.add(e.id);
    }
    return set;
  }, [expenses, lastSeenSnapshot, myId]);

  // Persist the seen watermark forward (debounced). Refs keep the callbacks
  // stable while always reading the latest rows/snapshot; monotonic via
  // lastSentRef so a late flush can never move it backward.
  const expensesRef = useRef(expenses);
  expensesRef.current = expenses;
  const snapshotRef = useRef(lastSeenSnapshot);
  snapshotRef.current = lastSeenSnapshot;
  const viewedRef = useRef<Set<string>>(new Set());
  const lastSentRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSeen = useCallback(() => {
    const snap = snapshotRef.current ?? null;
    const watermark = computeSeenWatermark(expensesRef.current, snap, myIdRef.current, viewedRef.current);
    if (!watermark) return;
    const floor = lastSentRef.current && lastSentRef.current > (snap ?? '') ? lastSentRef.current : snap ?? '';
    if (watermark <= floor) return;
    lastSentRef.current = watermark;
    void markSplitGroupSeen(groupId, watermark);
  }, [groupId]);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      flushSeen();
    }, 2000);
  }, [flushSeen]);

  // A "new" row counts as seen once it's lingered on screen (dwell), then we
  // schedule a persist. Own creations don't need dwell — they auto-pass in
  // computeSeenWatermark and advance via the expenses-change effect below.
  useDwellSeen({
    ids: [...newIds].filter((id) => !viewedRef.current.has(id)),
    getElement: (id) => document.querySelector(`[data-expense-id="${id}"]`),
    onDwelled: (id) => {
      viewedRef.current.add(id);
      schedulePersist();
    },
  });

  useEffect(() => {
    if (lastSeenSnapshot === undefined) return; // wait for the snapshot to resolve
    schedulePersist();
  }, [expenses, lastSeenSnapshot, schedulePersist]);

  // Unmount: cancel any pending debounce and flush once (flushSeen is stable).
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      flushSeen();
    };
  }, [flushSeen]);

  const openBankLink = (item: SplitExpenseItem) => {
    const link = item.bankLink;
    if (!link) return;
    if (link.ownerUserId === myId) {
      router.push(`/bank?account=${link.linkedAccountId}&tx=${link.txId}`);
      return;
    }
    const memberName = group?.members.find((m) => m.userId === link.ownerUserId)?.name ?? 'Someone';
    setBankLinkDialog({ bankLink: link, memberName });
  };

  const myNet = balances.find((b) => b.userId === myId)?.netCents ?? 0;
  const otherName = group?.members.find((m) => m.userId !== myId)?.name ?? 'Members';
  const otherMembers = group?.members.filter((m) => m.userId !== myId) ?? [];
  const profiles = useUserProfiles(group?.members.map((m) => m.userId) ?? []);
  const nameOf = (id: string) => (id === myId ? 'You' : group?.members.find((m) => m.userId === id)?.name ?? 'Someone');
  const firstName = (full: string) => full.trim().split(/\s+/)[0] || full;
  const shortNameOf = (id: string) => (id === myId ? 'You' : firstName(group?.members.find((m) => m.userId === id)?.name ?? 'Someone'));

  // Group visible expenses by month for sticky-header rendering.
  const byMonth = useMemo(() => {
    const map = new Map<string, SplitExpense[]>();
    for (const e of expenses) {
      const ym = e.date.slice(0, 7);
      const arr = map.get(ym) ?? [];
      arr.push(e);
      map.set(ym, arr);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [expenses]);

  const onRowMenu = (e: React.SyntheticEvent, row: SplitExpense) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuTarget(row);
    rowMenu.current?.toggle(e);
  };

  const doDelete = (row: SplitExpense) => {
    confirmDialog({
      message: 'Delete this entry?',
      header: 'Confirm',
      icon: 'pi pi-exclamation-triangle',
      accept: async () => {
        // Optimistic: drop the row and back out its balance contribution
        // immediately, then reconcile with the server in the background.
        const prevExpenses = expenses;
        const prevBalances = balances;
        setExpenses((cur) => cur.filter((x) => x.id !== row.id));
        setBalances((cur) => cur.map((b) => ({ ...b, netCents: b.netCents - (row.netByUserId[b.userId] ?? 0) })));
        const res = await deleteSplitExpense(groupId, row.id);
        if (!res.success) {
          setExpenses(prevExpenses);
          setBalances(prevBalances);
          toast.error('Failed to delete', res.error);
          return;
        }
        toast.success('Deleted');
        load(); // background reconcile (summary counts, month index)
      },
    });
  };

  // Activity tab → edit dialog: the row is usually already in the loaded
  // `expenses` window (activity only covers the last 3 months); fall back to
  // a one-off fetch of that month for older rows instead of merging it into
  // state. Payment rows are excluded via `isEventClickable` on the feed.
  const openExpenseFromActivity = useCallback(
    async (ev: SplitActivityEvent) => {
      if (ev.kind !== 'expense') return;
      const found = expenses.find((x) => x.id === ev.id);
      if (found && found.kind === 'expense') {
        setEditExpense(found);
        setShowExpense(true);
        return;
      }
      const month = ev.date.slice(0, 7);
      const res = await getSplitExpenses(groupId, [month]);
      const row = res.success && res.data ? res.data.find((x) => x.id === ev.id) : undefined;
      if (row && row.kind === 'expense') {
        setEditExpense(row);
        setShowExpense(true);
      } else {
        toast.error('Could not load that expense');
      }
    },
    [expenses, groupId, toast],
  );

  if (loading) {
    return <SplitDetailSkeleton />;
  }
  if (notFound || !group) {
    return (
      <div className="text-center py-16 text-gray-500">
        <p>Group not found.</p>
        <Button label="Back to Split" link onClick={() => router.push('/split')} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-4 lg:py-6 animate-fade-in">
      <Menu
        ref={rowMenu}
        popup
        model={[
          {
            label: 'Edit',
            visible: menuTarget?.kind === 'expense',
            command: () => {
              if (menuTarget?.kind === 'expense') {
                setEditExpense(menuTarget as SplitExpenseItem);
                setShowExpense(true);
              }
            },
          },
          { label: 'Delete', command: () => menuTarget && doDelete(menuTarget) },
        ]}
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Button icon={<MdArrowBack />} text rounded onClick={() => router.push('/split')} aria-label="Back" />
        <span className="text-2xl">{group.emoji ?? '🧾'}</span>
        <h1 className="text-xl font-bold flex-1 truncate">{group.name}</h1>
        <Button icon={<MdSettings />} text rounded onClick={() => setShowSettings(true)} aria-label="Group settings" />
      </div>

      {/* Balance banner */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4">
        <div className="flex items-center gap-3">
          {otherMembers.length === 1 && (
            <UserAvatar
              userId={otherMembers[0].userId}
              name={otherMembers[0].name}
              avatarUrl={profiles[otherMembers[0].userId]?.avatarUrl}
              size={40}
            />
          )}
          {otherMembers.length > 1 && (
            <div className="flex -space-x-2 shrink-0">
              {otherMembers.slice(0, 3).map((m) => (
                <UserAvatar
                  key={m.userId}
                  userId={m.userId}
                  name={m.name}
                  avatarUrl={profiles[m.userId]?.avatarUrl}
                  size={40}
                  className="ring-2 ring-white dark:ring-gray-800"
                />
              ))}
            </div>
          )}
          <div className="text-lg font-semibold">
            {myNet > 0 ? (
              <span className="text-green-600 dark:text-green-400">{otherName} owes you {formatCents(myNet, group.currency)}</span>
            ) : myNet < 0 ? (
              <span className="text-orange-600 dark:text-orange-400">You owe {otherName} {formatCents(-myNet, group.currency)}</span>
            ) : (
              <span className="text-gray-500">You are all settled up</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <Button
            label="Add expense"
            icon={<MdAdd />}
            severity="success"
            size="small"
            onClick={() => {
              setEditExpense(undefined);
              setShowExpense(true);
            }}
          />
          <Button label="Settle up" outlined size="small" onClick={() => setShowSettle(true)} />
          <Button label="Recurring" icon={<MdRepeat />} outlined size="small" onClick={() => { setEditRule(undefined); setShowRecurring(true); }} />
          <Button label="Import" icon={<MdUploadFile />} outlined size="small" onClick={() => setShowImport(true)} />
        </div>
      </div>

      {/* Recurring rules */}
      {group.recurrenceRules.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4">
          <div className="text-sm font-medium text-gray-500 mb-2">Recurring</div>
          <div className="flex flex-col gap-2">
            {group.recurrenceRules.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <span className={`flex-1 truncate ${r.isActive ? '' : 'line-through text-gray-400'}`}>
                  {r.title} · {formatCents(r.amountCents, group.currency)} · {r.interval}
                  {r.endDate && ` · until ${format(parseISO(r.endDate), 'MMM d, yyyy')}`}
                </span>
                <Button
                  label={r.isActive ? 'Pause' : 'Resume'}
                  text
                  size="small"
                  onClick={async () => {
                    const next = !r.isActive;
                    setGroup((g) => g && { ...g, recurrenceRules: g.recurrenceRules.map((x) => (x.id === r.id ? { ...x, isActive: next } : x)) });
                    const res = await updateSplitRecurrenceRule(groupId, r.id, { isActive: next });
                    if (!res.success) {
                      await load();
                      toast.error('Failed to update rule', res.error);
                      return;
                    }
                    toast.success(next ? 'Recurring resumed' : 'Recurring paused');
                  }}
                />
                <Button
                  label="Edit"
                  text
                  size="small"
                  onClick={() => {
                    setEditRule(r);
                    setShowRecurring(true);
                  }}
                />
                <Button
                  label="Delete"
                  text
                  size="small"
                  severity="danger"
                  onClick={async () => {
                    setGroup((g) => g && { ...g, recurrenceRules: g.recurrenceRules.filter((x) => x.id !== r.id) });
                    const res = await deleteSplitRecurrenceRule(groupId, r.id);
                    if (!res.success) {
                      await load();
                      toast.error('Failed to delete rule', res.error);
                      return;
                    }
                    toast.success('Recurring rule deleted');
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ledger / Activity toggle */}
      <div className="flex justify-center">
        <SelectButton
          value={view}
          onChange={(e) => e.value && setView(e.value)}
          options={[
            { label: 'Expenses', value: 'expenses' },
            { label: 'Activity', value: 'activity' },
          ]}
          className="text-sm"
        />
      </div>

      {view === 'activity' ? (
        activity === null ? (
          <DelayedSpinner />
        ) : (
          <SplitActivityFeed
            events={activity}
            currency={group.currency}
            showGroup={false}
            emptyText="No activity in this group yet"
            onEventClick={openExpenseFromActivity}
            isEventClickable={(ev) => ev.kind === 'expense'}
            myId={myId}
          />
        )
      ) : expenses.length === 0 ? (
        monthsDesc.length > visibleCount ? (
          // The loaded window is empty but older months hold history.
          <div className="text-center py-10">
            <p className="text-gray-400 mb-2">Nothing this month.</p>
            <Button label="Load older months" text onClick={loadMore} />
          </div>
        ) : (
          <p className="text-center text-gray-400 py-10">No expenses yet. Add one above.</p>
        )
      ) : (
        <div className="flex flex-col gap-4">
          {byMonth.map(([ym, rows]) => (
            <div key={ym}>
              <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] lg:top-[env(safe-area-inset-top)] z-10 bg-gray-50 dark:bg-gray-900 py-1 text-sm font-semibold text-gray-500">
                {formatYearMonth(ym)}
              </div>
              <ul className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
                {rows.map((e) => {
                  const viewerNet = e.netByUserId[myId] ?? 0;
                  const isPayment = e.kind === 'payment';
                  const title = isPayment
                    ? `${nameOf((e as SplitPayment).fromUserId)} paid ${nameOf((e as SplitPayment).toUserId)}`
                    : (e as SplitExpenseItem).title;
                  const sub = isPayment
                    ? formatCents((e as SplitPayment).amountCents, group.currency)
                    : (() => {
                        const item = e as SplitExpenseItem;
                        const amt = formatCents(item.amountCents, item.currency ?? group.currency);
                        const adder = shortNameOf(item.createdByUserId);
                        const payers = item.paidBy;
                        if (!payers || payers.length === 0) return `${amt} · added by ${adder}`;
                        const payerLabel = payers.length === 1 ? shortNameOf(payers[0].userId) : `${payers.length} people`;
                        return `${payerLabel} paid ${amt} · added by ${adder}`;
                      })();
                  const bankLink = !isPayment ? (e as SplitExpenseItem).bankLink : undefined;
                  const activateRow = (ev: React.SyntheticEvent) => {
                    if (isPayment) onRowMenu(ev, e);
                    else {
                      setEditExpense(e as SplitExpenseItem);
                      setShowExpense(true);
                    }
                  };
                  return (
                    <li
                      key={e.id}
                      data-expense-id={e.id}
                      role="button"
                      tabIndex={0}
                      onClick={activateRow}
                      onKeyDown={(ev) => {
                        if (ev.key !== 'Enter' && ev.key !== ' ') return;
                        ev.preventDefault();
                        activateRow(ev);
                      }}
                      className="flex items-center gap-2 py-2.5 -mx-2 px-2 rounded-lg cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 active:bg-gray-100 dark:active:bg-gray-700/70"
                    >
                      <div className="w-9 shrink-0 text-center">
                        <div className="text-[11px] uppercase tracking-wide text-gray-400">{format(parseISO(e.date), 'MMM')}</div>
                        <div className="text-base font-medium text-gray-500 dark:text-gray-400 leading-tight">{format(parseISO(e.date), 'd')}</div>
                      </div>
                      <CategoryIcon category={isPayment ? 'Payment' : (e as SplitExpenseItem).category} size={40} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-gray-900 dark:text-gray-100">
                          {newIds.has(e.id) && (
                            <span
                              className="inline-block w-2 h-2 mr-1.5 rounded-full align-middle shrink-0 bg-[var(--primary-color)]"
                              title="New since your last visit"
                            >
                              <span className="sr-only">New — </span>
                            </span>
                          )}
                          {title}
                          {e.source === 'recurring' && <span title="recurring" className="text-gray-400"> ↻</span>}
                        </div>
                        <div className="truncate text-xs text-gray-400">{sub}</div>
                      </div>
                      <div className="text-right shrink-0">
                        {viewerNet > 0 ? (
                          <div className="text-sm text-green-600 dark:text-green-400">you lent {formatCents(viewerNet, group.currency)}</div>
                        ) : viewerNet < 0 ? (
                          <div className="text-sm text-orange-600 dark:text-orange-400">you borrowed {formatCents(-viewerNet, group.currency)}</div>
                        ) : (
                          <div className="text-sm text-gray-400">—</div>
                        )}
                      </div>
                      {bankLink && (
                        <Button
                          icon={<MdAccountBalance />}
                          text
                          rounded
                          size="small"
                          className="!w-10 !h-10 shrink-0 opacity-60"
                          aria-label="Linked bank transaction"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            openBankLink(e as SplitExpenseItem);
                          }}
                        />
                      )}
                      <Button icon={<MdMoreVert />} text rounded size="small" onClick={(ev) => onRowMenu(ev, e)} aria-label="Row actions" />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {visibleCount < monthsDesc.length && (
            <div ref={sentinelRef} className="self-center py-1">
              <Button label="Load older months" text loading={loadingMore} onClick={loadMore} />
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <SplitExpenseDialog
        visible={showExpense}
        onHide={() => setShowExpense(false)}
        groupId={groupId}
        members={group.members}
        currency={group.currency}
        myId={myId}
        expense={editExpense}
        onSaved={async (saved) => {
          const wasEdit = !!editExpense;
          await load();
          toast.success(wasEdit ? 'Expense updated' : 'Expense added');
          // Celebrate a new expense; under reduced motion celebrate() is false,
          // so fall back to a row flash. Edits get neither (just the toast).
          if (!wasEdit && !celebrate('checkmark') && saved) flashRow(saved.id);
        }}
      />
      <SettleUpDialog
        visible={showSettle}
        onHide={() => setShowSettle(false)}
        groupId={groupId}
        members={group.members}
        currency={group.currency}
        myId={myId}
        balances={balances}
        onSaved={async (saved) => {
          await load();
          toast.success('Settled up');
          if (!celebrate('confetti') && saved) flashRow(saved.id);
        }}
      />
      <RecurrenceRuleDialog
        visible={showRecurring}
        onHide={() => setShowRecurring(false)}
        groupId={groupId}
        members={group.members}
        currency={group.currency}
        myId={myId}
        rule={editRule}
        onSaved={() => { load(); toast.success(editRule ? 'Recurring rule updated' : 'Recurring rule added'); }}
      />
      <SplitImportDialog visible={showImport} onHide={() => setShowImport(false)} group={group} onImported={() => { load(); toast.success('Expenses imported'); }} />
      <GroupFormDialog visible={showSettings} onHide={() => setShowSettings(false)} group={group} onSaved={() => { load(); toast.success('Group updated'); }} />
      {bankLinkDialog && (
        <BankLinkDetailsDialog
          visible={!!bankLinkDialog}
          onHide={() => setBankLinkDialog(null)}
          bankLink={bankLinkDialog.bankLink}
          memberName={bankLinkDialog.memberName}
        />
      )}
    </div>
  );
}
