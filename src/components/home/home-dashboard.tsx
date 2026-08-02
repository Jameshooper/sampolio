'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Dialog } from 'primereact/dialog';
import { MdChevronRight } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { navItems } from '@/components/layout/nav-config';
import { HomeSkeleton } from '@/components/ui/skeletons';
import { PageEntrance } from '@/components/ui/page-entrance';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { SplitActivityFeed } from '@/components/split/split-activity-feed';
import { BankAttentionBanner } from '@/components/bank/bank-attention-banner';
import { getMySplitGroups, getSplitGroupView, getSplitActivity, catchUpGroupRecurrences } from '@/lib/actions/split-groups';
import { getAccounts } from '@/lib/actions/accounts';
import { getProjection } from '@/lib/actions/projection';
import { getBankConnectionsNeedingAttention, type ConnectionAttention } from '@/lib/actions/bank';
import { formatCents, formatCurrency, formatYearMonth } from '@/lib/constants';
import type { Currency, SplitActivityEvent, SplitGroup } from '@/types';

interface GroupLine {
  group: SplitGroup;
  myNetCents: number;
  otherName: string;
  otherUserId?: string;
}

export function HomeDashboard() {
  const appContext = useAppContext();
  const router = useRouter();
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  const firstName = (session?.user?.name ?? '').split(' ')[0];

  const [lines, setLines] = useState<GroupLine[]>([]);
  const [events, setEvents] = useState<SplitActivityEvent[]>([]);
  const [currency, setCurrency] = useState<Currency>('EUR');
  const [loaded, setLoaded] = useState(false);
  // Bank connections needing attention (expired/expiring consent, failing sync) —
  // fetched independently, same non-blocking pattern as fetchGlance below.
  const [bankAttention, setBankAttention] = useState<ConnectionAttention[]>([]);
  // "This month" glance: the primary account's projected end-of-month position.
  const [glance, setGlance] = useState<{ yearMonth: string; startingBalance: number; totalIncome: number; totalExpenses: number; endingBalance: number; netChange: number; currency: Currency; isActualized?: boolean } | null>(null);
  // Settles to true once fetchGlance has resolved (whether it found data or
  // not) — glance loads independently of the split data, so the region's
  // skeleton needs both flags to know when it's safe to swap in.
  const [glanceLoaded, setGlanceLoaded] = useState(false);
  // Plain-words "how we get this number" breakdown, opened by tapping the glance tile.
  const [explainOpen, setExplainOpen] = useState(false);

  const fetchGlance = useCallback(async () => {
    try {
      const accRes = await getAccounts();
      const primary = accRes.success && accRes.data ? accRes.data.find((a) => !a.isArchived) : undefined;
      if (!primary) return setGlance(null);
      const proj = await getProjection(primary.id);
      if (!proj.success || !proj.data) return setGlance(null);
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const row = proj.data.monthly.find((m) => m.yearMonth === ym) ?? proj.data.monthly[0];
      if (!row) return setGlance(null);
      setGlance({
        yearMonth: row.yearMonth,
        startingBalance: row.startingBalance,
        totalIncome: row.totalIncome,
        totalExpenses: row.totalExpenses,
        endingBalance: row.endingBalance,
        netChange: row.netChange,
        currency: primary.currency,
        isActualized: row.isActualized,
      });
    } finally {
      setGlanceLoaded(true);
    }
  }, []);

  const fetchBankAttention = useCallback(async () => {
    const res = await getBankConnectionsNeedingAttention();
    if (res.success && res.data) setBankAttention(res.data);
  }, []);

  const fetchData = useCallback(async () => {
    if (!myId) return;
    void fetchGlance(); // independent — don't block the split data on it
    void fetchBankAttention(); // independent — same non-blocking pattern
    const res = await getMySplitGroups();
    const groups = res.success && res.data ? res.data : [];
    // Materialize any due recurrences across groups (cheap; no-ops when nothing due).
    await Promise.all(groups.map((g) => catchUpGroupRecurrences(g.id)));
    const built = await Promise.all(
      groups.map(async (g) => {
        const view = await getSplitGroupView(g.id);
        const myNetCents = view.success ? view.data!.balances.find((b) => b.userId === myId)?.netCents ?? 0 : 0;
        const other = g.members.find((m) => m.userId !== myId);
        return { group: g, myNetCents, otherName: other?.name ?? 'Members', otherUserId: other?.userId };
      }),
    );
    setLines(built);
    if (groups[0]) setCurrency(groups[0].currency);
    const act = await getSplitActivity(5);
    if (act.success && act.data) setEvents(act.data);
    setLoaded(true);
  }, [myId, fetchGlance, fetchBankAttention]);

  // Split into two effects (see goals/page.tsx): combining them re-ran the
  // fetch (and re-showed the loading skeleton) on every AppLayout re-render,
  // since `appContext` used to be a fresh object each time.
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { appContext?.setRefreshCallback(fetchData); }, [appContext, fetchData]);

  const otherMemberIds = useMemo(
    () => lines.map((l) => l.otherUserId).filter((id): id is string => !!id),
    [lines],
  );
  const profiles = useUserProfiles(otherMemberIds);

  const overallNet = lines.reduce((s, l) => s + l.myNetCents, 0);
  const featureItems = navItems.filter((n) => n.id !== 'home');
  // The glance/balances/activity region is considered "ready" only once both
  // the glance fetch and the split data fetch have settled — either can
  // legitimately resolve to empty data, so this must be a load-state flag,
  // never derived from the data itself (that would stay stuck for no-data users).
  const regionLoaded = loaded && glanceLoaded;

  return (
    // PageEntrance: `/` sits outside the (dashboard) group, so the group's
    // template.tsx route-entrance doesn't cover it — apply the same entrance here.
    <PageEntrance>
    <div className="max-w-3xl mx-auto py-4 lg:py-6">
      <h1 className="text-2xl font-bold mb-4">{firstName ? `Hi, ${firstName}` : 'Sampolio'}</h1>

      {/* Bank consent/sync attention — same banner as Overview (see
          BankAttentionBanner). Fetched independently of the glance/split data so
          it never delays them, and rendered outside the regionLoaded/animate-fade-in
          wrapper below so a refetch never remounts that wrapper. */}
      {bankAttention.length > 0 && (
        <div className="mb-4">
          <BankAttentionBanner attention={bankAttention} onAction={() => router.push('/bank')} />
        </div>
      )}

      {!regionLoaded && <HomeSkeleton />}

      {regionLoaded && (
        <div className="animate-fade-in">
          {/* "This month" glance — the one number Overview's hero answers, without a tap */}
          {glance && (
            <button
              type="button"
              onClick={() => setExplainOpen(true)}
              aria-label="What does this number mean?"
              className={`pressable w-full text-left cursor-pointer rounded-xl border p-4 mb-5 flex items-center justify-between gap-3 ${glance.endingBalance < 0
                ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'}`}
            >
              <div className="min-w-0">
                <div className="text-sm text-gray-500 dark:text-gray-400">Projected end of {formatYearMonth(glance.yearMonth)}</div>
                <div className={`text-xl font-bold ${glance.endingBalance < 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-900 dark:text-gray-100'}`}>
                  {formatCurrency(glance.endingBalance, glance.currency)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {glance.endingBalance < 0
                    ? 'Heads up — this month ends in the red.'
                    : glance.netChange >= 0
                      ? "You're on track this month."
                      : `Spending ${formatCurrency(-glance.netChange, glance.currency)} more than you earn this month.`}
                </div>
              </div>
              <MdChevronRight className="text-gray-400 shrink-0" size={22} />
            </button>
          )}

          {/* Plain-words breakdown of the glance number */}
          {glance && (
            <Dialog
              header="What does this number mean?"
              visible={explainOpen}
              onHide={() => setExplainOpen(false)}
              dismissableMask
              className="w-full max-w-lg"
            >
              <div className="space-y-3 text-gray-600 dark:text-gray-300">
                <p>
                  {glance.isActualized ? (
                    <>You have about{' '}
                      <b className="text-gray-900 dark:text-gray-100">{formatCurrency(glance.startingBalance, glance.currency)}</b>{' '}
                      in your account right now.</>
                  ) : (
                    <>You start {formatYearMonth(glance.yearMonth)} with about{' '}
                      <b className="text-gray-900 dark:text-gray-100">{formatCurrency(glance.startingBalance, glance.currency)}</b>.</>
                  )}
                </p>
                <p>
                  {glance.isActualized ? (
                    <>What&apos;s still left to come in this month adds about{' '}
                      <b className="text-green-600 dark:text-green-400">+{formatCurrency(glance.totalIncome, glance.currency)}</b>, and
                      what&apos;s still left to go out takes about{' '}
                      <b className="text-red-600 dark:text-red-400">−{formatCurrency(glance.totalExpenses, glance.currency)}</b>.</>
                  ) : (
                    <>Your income adds about{' '}
                      <b className="text-green-600 dark:text-green-400">+{formatCurrency(glance.totalIncome, glance.currency)}</b>, and
                      your bills and spending take about{' '}
                      <b className="text-red-600 dark:text-red-400">−{formatCurrency(glance.totalExpenses, glance.currency)}</b>.</>
                  )}
                </p>
                <p>
                  So we expect about{' '}
                  <b className="text-gray-900 dark:text-gray-100">{formatCurrency(glance.endingBalance, glance.currency)}</b>{' '}
                  in your account at the end of the month.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {glance.isActualized
                    ? 'This accounts for what\'s already happened this month — it updates as things change.'
                    : 'This is a forecast based on your regular income, bills and plans — it updates as things change.'}
                </p>
                <Link href="/overview" className="inline-block text-sm text-accent-600 dark:text-accent-400 no-underline" onClick={() => setExplainOpen(false)}>
                  See the full picture on Overview →
                </Link>
              </div>
            </Dialog>
          )}

          {/* Split balances */}
          {lines.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-500">
                  Overall, you are {overallNet >= 0 ? 'owed' : 'owe'}{' '}
                  <span className={overallNet >= 0 ? 'text-green-600 dark:text-green-400 font-semibold' : 'text-orange-600 dark:text-orange-400 font-semibold'}>
                    {formatCents(Math.abs(overallNet), currency)}
                  </span>
                </span>
                <Link href="/split" className="text-sm text-accent-600 dark:text-accent-400 no-underline">
                  All groups
                </Link>
              </div>
              <div className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
                {lines.map((l) => (
                  <Link
                    key={l.group.id}
                    href={`/split/${l.group.id}`}
                    className="no-underline flex items-center gap-3 py-2 rounded-lg transition-colors active:bg-gray-50 dark:active:bg-gray-700/40"
                  >
                    <span className="text-xl">{l.group.emoji ?? '🧾'}</span>
                    <span className="flex-1 truncate text-gray-900 dark:text-gray-100">{l.group.name}</span>
                    {l.otherUserId && (
                      <UserAvatar userId={l.otherUserId} name={l.otherName} avatarUrl={profiles[l.otherUserId]?.avatarUrl} size={20} />
                    )}
                    <span className={`text-sm ${l.myNetCents > 0 ? 'text-green-600 dark:text-green-400' : l.myNetCents < 0 ? 'text-orange-600 dark:text-orange-400' : 'text-gray-400'}`}>
                      {l.myNetCents > 0
                        ? `${l.otherName} owes you ${formatCents(l.myNetCents, l.group.currency)}`
                        : l.myNetCents < 0
                          ? `you owe ${formatCents(-l.myNetCents, l.group.currency)}`
                          : 'settled'}
                    </span>
                    <MdChevronRight className="text-gray-400" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Recent activity */}
          {events.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-5">
              <div className="text-sm font-medium text-gray-500 mb-1">Recent activity</div>
              <SplitActivityFeed events={events} currency={currency} myId={myId} onEventClick={(e) => router.push('/split/' + e.groupId)} />
            </div>
          )}
        </div>
      )}

      {/* Everything else */}
      <div className="text-sm font-medium text-gray-500 mb-2">Explore</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {featureItems.map((n) => (
          <Link
            key={n.id}
            href={n.href}
            className="pressable no-underline flex items-center gap-2 p-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:shadow-md text-gray-800 dark:text-gray-200"
          >
            <span className="text-gray-500">{n.icon}</span>
            <span className="font-medium truncate">{n.label}</span>
          </Link>
        ))}
      </div>
    </div>
    </PageEntrance>
  );
}
