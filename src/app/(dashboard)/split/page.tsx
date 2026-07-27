'use client';
/* eslint-disable react-hooks/set-state-in-effect -- loads groups on mount and stores them in state */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Button } from 'primereact/button';
import { SelectButton } from 'primereact/selectbutton';
import { ListPageSkeleton } from '@/components/ui/skeletons';
import { DelayedSkeleton } from '@/components/ui/delayed-loading';
import { EmptyState } from '@/components/ui/empty-state';
import { JiggleModeBar, useJiggleReorder } from '@/components/ui/jiggle-reorder';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { MdAdd, MdGroups, MdChevronRight, MdInsights } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { useToast } from '@/components/providers/toast-provider';
import { GroupFormDialog } from '@/components/split/group-form-dialog';
import { getMySplitGroups, getSplitGroupView, getSplitInsights } from '@/lib/actions/split-groups';
import { getUserPreferences, updateSplitGroupOrder } from '@/lib/actions/user-preferences';
import { sortByPreferredOrder } from '@/lib/reorder-utils';
import { aggregatePairwiseNets, type PersonNet } from '@/lib/split-insights';
import { ChartExplain, type ReadCue } from '@/components/ui/chart-explain';
import { describeSplitSpend, describeSplitNet } from '@/lib/chart-descriptions';
import { formatCents } from '@/lib/constants';
import type { SplitGroup, SplitMemberBalance, Currency } from '@/types';
import type { SplitInsights } from '@/lib/split-insights';

// The ECharts insights charts are code-split into their own chunk (ssr:false —
// client-only), matching the cashflow page. A short-delayed placeholder holds
// their layout height so nothing jumps in when they arrive.
const ChartLoading = () => <div className="h-72 lg:h-96 rounded-lg bg-gray-100 dark:bg-gray-800/50 animate-pulse" />;
const SplitSpendChart = dynamic(
  () => import('@/components/charts/split-spend-chart').then((m) => m.SplitSpendChart),
  { ssr: false, loading: ChartLoading },
);
const SplitNetChart = dynamic(
  () => import('@/components/charts/split-net-chart').then((m) => m.SplitNetChart),
  { ssr: false, loading: ChartLoading },
);

interface GroupCard {
  group: SplitGroup;
  balances: SplitMemberBalance[];
  myNetCents: number;
  otherName: string;
  hasNew: boolean;
}

const spendModeOptions = [
  { label: 'By group', value: 'group' as const },
  { label: 'By member', value: 'member' as const },
];

const spendHowToRead: ReadCue[] = [
  { shape: 'square', color: '#3b82f6', text: 'Each bar is one month; taller bars mean more shared spending.' },
  { shape: 'updown', color: '#22c55e', color2: '#f59e0b', text: 'Colours stack up the bar — one colour per group, or per person.' },
];
const netHowToRead: ReadCue[] = [
  { shape: 'line', color: '#3b82f6', text: 'The line is your running balance across all groups.' },
  { shape: 'updown', color: '#22c55e', color2: '#f59e0b', text: 'Above the dashed line people owe you; below it, you owe them.' },
  { shape: 'line', color: '#9ca3af', dashed: true, text: 'The dashed line is zero — being all settled up.' },
];

/**
 * The two insights charts plus their spend-mode toggle and plain-words panels.
 * Kept in its own component (owning `spendMode` + the describe memos) so the
 * describe useMemos — with `demoMasked` in their deps for demo-mask correctness —
 * don't alter the page component's own hook profile.
 */
function SplitInsightsCharts({
  insights,
  currency,
  mixed,
}: {
  insights: SplitInsights;
  currency: Currency;
  mixed: boolean;
}) {
  const { demoMasked } = useAppContext() ?? {};
  const [spendMode, setSpendMode] = useState<'group' | 'member'>('group');

  const spendDescription = useMemo(
    () => describeSplitSpend(insights, spendMode, (n) => formatCents(n, currency)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCents output depends on demo mode
    [insights, spendMode, currency, demoMasked],
  );
  const netDescription = useMemo(
    () => describeSplitNet(insights, (n) => formatCents(n, currency)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCents output depends on demo mode
    [insights, currency, demoMasked],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300">Monthly spending</h3>
          <div className="flex items-center gap-2">
            {mixed && <span className="text-xs text-gray-400">(mixed currencies)</span>}
            <SelectButton
              value={spendMode}
              onChange={(e) => e.value && setSpendMode(e.value)}
              options={spendModeOptions}
              allowEmpty={false}
            />
          </div>
        </div>
        <ChartExplain
          chartLabel="Monthly shared spending"
          howToRead={spendHowToRead}
          description={spendDescription}
          plainWordsLabel="In plain words"
        >
          <div className="h-72 lg:h-96 w-full">
            <SplitSpendChart insights={insights} mode={spendMode} currency={currency} />
          </div>
        </ChartExplain>
      </div>
      <div>
        <h3 className="text-sm font-medium text-gray-600 dark:text-gray-300 mb-2">Your running balance</h3>
        <ChartExplain
          chartLabel="Your running balance"
          howToRead={netHowToRead}
          description={netDescription}
          plainWordsLabel="In plain words"
        >
          <div className="h-72 lg:h-96 w-full">
            <SplitNetChart insights={insights} currency={currency} />
          </div>
        </ChartExplain>
      </div>
    </div>
  );
}

export default function SplitPage() {
  const appContext = useAppContext();
  const toast = useToast();
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const [cards, setCards] = useState<GroupCard[]>([]);
  const [order, setOrder] = useState<string[] | undefined>(undefined);
  const [insights, setInsights] = useState<SplitInsights | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [jiggling, setJiggling] = useState(false);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const movedRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!myId) return;
    const [res, prefsRes, insRes] = await Promise.all([
      getMySplitGroups(),
      getUserPreferences(),
      getSplitInsights(12),
    ]);
    const groups = res.success && res.data ? res.data : [];
    const lastSeen = prefsRes.success ? prefsRes.data?.splitLastSeenAt ?? {} : {};
    if (prefsRes.success) setOrder(prefsRes.data?.splitGroupOrder);
    setInsights(insRes.success && insRes.data ? insRes.data : null);
    const built = await Promise.all(
      groups.map(async (g) => {
        const view = await getSplitGroupView(g.id);
        const balances = view.success ? view.data!.balances : [];
        const myNetCents = balances.find((b) => b.userId === myId)?.netCents ?? 0;
        const otherName = g.members.find((m) => m.userId !== myId)?.name ?? 'Members';
        // Show a dot only against a baseline (a first-ever visit stamps one),
        // consistent with the detail page's first-visit rule.
        const seen = lastSeen[g.id];
        const lastActivityAt = view.success ? view.data!.summary.lastActivityAt : undefined;
        const hasNew = !!(seen && lastActivityAt && lastActivityAt > seen);
        return { group: g, balances, myNetCents, otherName, hasNew };
      }),
    );
    setCards(built);
    setLoaded(true);
  }, [myId]);

  // Split into two effects (see goals/page.tsx): the fetch effect only depends
  // on fetchData's own identity; registering the refresh callback depends on
  // appContext too — combining them re-ran the fetch (and re-showed the
  // skeleton) on every AppLayout re-render.
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { appContext?.setRefreshCallback(fetchData); }, [appContext, fetchData]);

  // Curated display order (identity when no order is set).
  const displayCards = useMemo(() => sortByPreferredOrder(cards, (c) => c.group.id, order), [cards, order]);
  const ids = useMemo(() => displayCards.map((c) => c.group.id), [displayCards]);

  const handleJiggleChange = useCallback(
    (next: boolean) => {
      setJiggling(next);
      if (next) movedRef.current = false;
      else if (movedRef.current) {
        toast.success('Order saved');
        movedRef.current = false;
      }
    },
    [toast],
  );

  const handleReorder = useCallback(
    (nextIds: string[]) => {
      movedRef.current = true;
      setOrder(nextIds); // optimistic — display re-sorts immediately
      void updateSplitGroupOrder(nextIds).then((res) => {
        if (!res.success) toast.error('Could not save order', res.error);
      });
    },
    [toast],
  );

  const { containerProps, getItemProps } = useJiggleReorder({
    ids,
    axis: 'y',
    jiggling,
    onJiggleChange: handleJiggleChange,
    onReorder: handleReorder,
    disabled: displayCards.length < 2,
  });
  const { ref: listRef, ...containerRest } = containerProps;

  // "Across all groups" summary — the viewer's pairwise position, aggregated
  // from each group's settle-up (so it matches every group's own screen).
  const pairwise = useMemo(
    () => aggregatePairwiseNets(myId, cards.map((c) => ({ group: c.group, balances: c.balances }))),
    [myId, cards],
  );
  // Avatars for the summary's person rows + every group card's member stack —
  // one shared resolve so overlapping ids (someone in two groups) aren't refetched.
  const avatarIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of pairwise.people) ids.add(p.userId);
    for (const c of cards) for (const m of c.group.members) ids.add(m.userId);
    return [...ids];
  }, [pairwise, cards]);
  const profiles = useUserProfiles(avatarIds);
  const currencyKeys = Object.keys(pairwise.totalByCurrency);
  const summaryMixed = currencyKeys.length > 1;

  // Insights readiness: charts are only meaningful with ≥2 months of spending.
  const activeMonthCount = insights
    ? insights.months.filter((m) => Object.values(insights.spendByGroup[m] ?? {}).some((v) => v > 0)).length
    : 0;
  const insightsCurrency: Currency = insights?.currencies[0] ?? cards[0]?.group.currency ?? 'EUR';
  const insightsMixed = (insights?.currencies.length ?? 0) > 1;

  const balanceLine = (c: GroupCard) => {
    if (c.myNetCents > 0)
      return <span className="text-green-600 dark:text-green-400">{c.otherName} owes you {formatCents(c.myNetCents, c.group.currency)}</span>;
    if (c.myNetCents < 0)
      return <span className="text-orange-600 dark:text-orange-400">You owe {c.otherName} {formatCents(-c.myNetCents, c.group.currency)}</span>;
    return <span className="text-gray-400">Settled up</span>;
  };

  const personLine = (p: PersonNet) => (
    <div key={`${p.userId}|${p.currency}`} className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <UserAvatar userId={p.userId} name={p.name} avatarUrl={profiles[p.userId]?.avatarUrl} size={24} />
        <span className="truncate">{p.name}</span>
      </div>
      {p.netCents > 0 ? (
        <span className="text-green-600 dark:text-green-400 shrink-0">owes you {formatCents(p.netCents, p.currency)}</span>
      ) : (
        <span className="text-orange-600 dark:text-orange-400 shrink-0">you owe {formatCents(-p.netCents, p.currency)}</span>
      )}
    </div>
  );

  const summaryTotalLine = () => {
    if (summaryMixed) {
      return <span className="text-gray-500 dark:text-gray-400">Balances across multiple currencies</span>;
    }
    const cur = (currencyKeys[0] as Currency) ?? 'EUR';
    const total = pairwise.totalByCurrency[cur] ?? 0;
    if (total > 0) return <span className="text-green-600 dark:text-green-400 font-semibold">Overall, you&apos;re owed {formatCents(total, cur)}</span>;
    if (total < 0) return <span className="text-orange-600 dark:text-orange-400 font-semibold">Overall, you owe {formatCents(-total, cur)}</span>;
    return <span className="text-gray-400 font-semibold">All settled up</span>;
  };

  return (
    <div className="max-w-3xl mx-auto py-4 lg:py-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="text-2xl font-bold">Split</h1>
        <div className="flex gap-2">
          <Button
            label="Add expense"
            icon={<MdAdd />}
            severity="success"
            className="flex-1 sm:flex-none"
            onClick={() => appContext?.openDrawer({ mode: 'create', entityType: 'split-expense' })}
          />
          <Button label="New group" outlined className="flex-1 sm:flex-none" onClick={() => setShowCreate(true)} />
        </div>
      </div>

      {!loaded ? (
        <ListPageSkeleton rows={3} showTitle={false} />
      ) : cards.length === 0 ? (
        <div className="text-center py-16 text-gray-500 animate-fade-in">
          <MdGroups size={48} className="mx-auto mb-3 opacity-40" />
          <p className="mb-4">No split groups yet. Create one to start tracking shared expenses.</p>
          <Button label="Create your first group" icon={<MdAdd />} severity="success" onClick={() => setShowCreate(true)} />
        </div>
      ) : (
        <div className="flex flex-col gap-6 animate-fade-in">
          {/* Across-all-groups summary (only worth showing with ≥2 groups) */}
          {cards.length >= 2 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Across all groups</h2>
                {summaryMixed && <span className="text-xs text-gray-400">(mixed currencies)</span>}
              </div>
              <div className="mb-1">{summaryTotalLine()}</div>
              {pairwise.people.length > 0 && (
                <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-700/60">
                  {pairwise.people.slice(0, 4).map(personLine)}
                  {showAllPeople && (
                    <div className="animate-fade-in divide-y divide-gray-100 dark:divide-gray-700/60">
                      {pairwise.people.slice(4).map(personLine)}
                    </div>
                  )}
                </div>
              )}
              {pairwise.people.length > 4 && !showAllPeople && (
                <button
                  type="button"
                  onClick={() => setShowAllPeople(true)}
                  className="mt-2 text-sm text-[var(--primary-color)] hover:underline"
                >
                  Show all ({pairwise.people.length})
                </button>
              )}
            </div>
          )}

          {/* Group list — long-press a card to reorder */}
          <div>
            {displayCards.length >= 2 && (
              <button
                type="button"
                onClick={() => handleJiggleChange(true)}
                className="sr-only focus:not-sr-only focus:mb-2 focus:inline-flex focus:items-center focus:min-h-[44px] focus:px-3 focus:rounded-lg focus:border focus:surface-border"
              >
                Reorder groups
              </button>
            )}
            <div ref={listRef as React.Ref<HTMLDivElement>} {...containerRest} className="flex flex-col gap-3">
              {displayCards.map((c) => {
                const { ref: itemRef, ...itemRest } = getItemProps(c.group.id);
                return (
                  <Link
                    key={c.group.id}
                    ref={itemRef as React.Ref<HTMLAnchorElement>}
                    href={`/split/${c.group.id}`}
                    {...itemRest}
                    className="no-underline block"
                  >
                    <div
                      data-jiggle-inner=""
                      className="flex items-center gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 pressable"
                    >
                      <span className="text-3xl shrink-0">{c.group.emoji ?? '🧾'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">{c.group.name}</span>
                          {c.hasNew && (
                            <span className="w-2 h-2 rounded-full shrink-0 bg-[var(--primary-color)]" aria-label="New activity" />
                          )}
                        </div>
                        <div className="flex -space-x-1.5 mt-1">
                          {c.group.members.filter((m) => m.userId !== myId).slice(0, 4).map((m) => (
                            <UserAvatar
                              key={m.userId}
                              userId={m.userId}
                              name={m.name}
                              avatarUrl={profiles[m.userId]?.avatarUrl}
                              size={20}
                              className="ring-1 ring-white dark:ring-gray-800"
                            />
                          ))}
                        </div>
                        <div className="text-sm">{balanceLine(c)}</div>
                      </div>
                      <MdChevronRight className="text-gray-400 shrink-0" size={22} />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Insights (spend + running net) */}
          <div>
            <h2 className="text-lg font-semibold mb-3">Insights</h2>
            {!insights ? (
              <DelayedSkeleton>
                <div className="h-72 lg:h-96 rounded-lg bg-gray-100 dark:bg-gray-800/50 animate-pulse" />
              </DelayedSkeleton>
            ) : activeMonthCount < 2 ? (
              <EmptyState
                icon={<MdInsights />}
                title="Not enough history yet"
                body="Once you've logged shared expenses across a couple of months, spending trends and your running balance show up here."
              />
            ) : (
              <SplitInsightsCharts insights={insights} currency={insightsCurrency} mixed={insightsMixed} />
            )}
          </div>
        </div>
      )}

      <GroupFormDialog visible={showCreate} onHide={() => setShowCreate(false)} onSaved={() => fetchData()} />
      <JiggleModeBar jiggling={jiggling} onDone={() => handleJiggleChange(false)} hint="Drag to reorder your groups" />
    </div>
  );
}
