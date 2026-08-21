'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { Dialog } from 'primereact/dialog';
import { MdAccountBalance, MdChevronRight, MdCreditCard, MdSavings } from 'react-icons/md';
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
import {
  getBankConnectionsNeedingAttention,
  getHomeBankGlance,
  type ConnectionAttention,
  type HomeBankAccountGlance,
} from '@/lib/actions/bank';
import { aggregatePairwiseNets } from '@/lib/split-insights';
import { formatCents, formatCurrency, formatYearMonth } from '@/lib/constants';
import type { BankAccountRole, Currency, SplitActivityEvent, SplitGroup, SplitMemberBalance } from '@/types';

interface GroupLine {
  group: SplitGroup;
  myNetCents: number;
  otherName: string;
  otherUserId?: string;
  /** The group's full per-member balances — feeds aggregatePairwiseNets. */
  balances: SplitMemberBalance[];
}

/** Role → icon at text-row scale. Deliberately NOT the exported `roleIcon` from
 * account-picker.tsx: that one renders at the surrounding font size, which is
 * too large for these text-xs labels. */
function roleIconSmall(role: BankAccountRole) {
  if (role === 'credit-card') return <MdCreditCard size={14} className="opacity-70" />;
  if (role === 'savings') return <MdSavings size={14} className="opacity-70" />;
  return <MdAccountBalance size={14} className="opacity-70" />;
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
  // Live balances of the accounts/cards used in the last 30 days — the strip at
  // the top of the page. Fetched independently, like the glance below.
  const [bankRows, setBankRows] = useState<HomeBankAccountGlance[]>([]);
  // Settles to true once the bank-glance fetch resolves (found rows or not) —
  // the top row's geometry depends on whether there are any, so the skeleton
  // must wait for it or the layout jumps right after paint.
  const [bankLoaded, setBankLoaded] = useState(false);
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

  const fetchBankGlance = useCallback(async () => {
    try {
      const res = await getHomeBankGlance();
      if (res.success && res.data) setBankRows(res.data);
    } finally {
      // `finally` so a failed fetch still releases the region's skeleton.
      setBankLoaded(true);
    }
  }, []);

  const fetchBankAttention = useCallback(async () => {
    const res = await getBankConnectionsNeedingAttention();
    if (res.success && res.data) setBankAttention(res.data);
  }, []);

  const fetchData = useCallback(async () => {
    if (!myId) return;
    void fetchGlance(); // independent — don't block the split data on it
    void fetchBankGlance(); // independent — same non-blocking pattern
    void fetchBankAttention(); // independent — same non-blocking pattern
    const res = await getMySplitGroups();
    const groups = res.success && res.data ? res.data : [];
    // Materialize any due recurrences across groups (cheap; no-ops when nothing due).
    await Promise.all(groups.map((g) => catchUpGroupRecurrences(g.id)));
    const built = await Promise.all(
      groups.map(async (g) => {
        const view = await getSplitGroupView(g.id);
        const balances = view.success ? view.data!.balances : [];
        const myNetCents = balances.find((b) => b.userId === myId)?.netCents ?? 0;
        const other = g.members.find((m) => m.userId !== myId);
        return { group: g, myNetCents, otherName: other?.name ?? 'Members', otherUserId: other?.userId, balances };
      }),
    );
    setLines(built);
    if (groups[0]) setCurrency(groups[0].currency);
    const act = await getSplitActivity(5);
    if (act.success && act.data) setEvents(act.data);
    setLoaded(true);
  }, [myId, fetchGlance, fetchBankGlance, fetchBankAttention]);

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

  // The viewer's aggregate position, computed exactly like /split's summary card
  // (per-group `suggestSettleUp`, kept per currency) — never a naive sum of
  // per-group nets, which mixes currencies silently.
  const pairwise = useMemo(
    () => aggregatePairwiseNets(myId, lines.map((l) => ({ group: l.group, balances: l.balances }))),
    [myId, lines],
  );
  const featureItems = navItems.filter((n) => n.id !== 'home');
  // The glance/balances/activity region is considered "ready" only once the
  // glance, bank-glance and split-data fetches have ALL settled — any of them
  // can legitimately resolve to empty data, so this must be a load-state flag,
  // never derived from the data itself (that would stay stuck for no-data users).
  // The bank flag matters for layout, not just content: the top row's geometry
  // (strip + narrow tile vs. one full-width tile) depends on whether there are
  // bank rows, so swapping in before it settles would shift the page.
  const regionLoaded = loaded && glanceLoaded && bankLoaded;

  // The overall split position, mirroring /split's summaryTotalLine: entries
  // under a cent are noise; more than one currency can't be summed (app-wide).
  const overallLine = () => {
    const currencies = Object.keys(pairwise.totalByCurrency).filter(
      (c) => Math.abs(pairwise.totalByCurrency[c]) >= 1,
    );
    if (currencies.length === 0) return <span className="text-gray-400">All settled up</span>;
    if (currencies.length > 1) {
      return <span className="text-gray-500 dark:text-gray-400">Balances across multiple currencies</span>;
    }
    const cur = currencies[0] as Currency;
    const total = pairwise.totalByCurrency[cur];
    return total > 0 ? (
      <span className="text-gray-500 dark:text-gray-400">
        Overall, you&apos;re owed{' '}
        <span className="text-green-600 dark:text-green-400 font-semibold">{formatCents(total, cur)}</span>
      </span>
    ) : (
      <span className="text-gray-500 dark:text-gray-400">
        Overall, you owe{' '}
        <span className="text-orange-600 dark:text-orange-400 font-semibold">{formatCents(-total, cur)}</span>
      </span>
    );
  };

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
          {/* Top glance row: bank balances (primary) + projected end-of-month (secondary) */}
          {(bankRows.length > 0 || glance) && (
            <div className="flex flex-col sm:flex-row gap-3 mb-5">
              {bankRows.length > 0 && (
                <div className="flex-1 min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Accounts &amp; cards</span>
                    <Link href="/bank" className="text-xs text-accent-600 dark:text-accent-400 no-underline">Bank</Link>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {bankRows.map((a) => (
                      <Link
                        key={a.linkId}
                        href="/bank"
                        className="pressable no-underline rounded-lg border border-gray-100 dark:border-gray-700 dark:bg-white/[0.04] px-2.5 py-2 min-w-0"
                      >
                        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 min-w-0">
                          <span className="shrink-0">{roleIconSmall(a.role)}</span>
                          <span className="truncate">{a.label}</span>
                        </div>
                        {a.role === 'credit-card' ? (
                          <>
                            <div className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100 truncate">
                              {a.used != null ? formatCurrency(a.used, a.currency) : '—'}
                              {a.creditLimit != null && (
                                <span className="text-xs font-normal text-gray-400 dark:text-gray-500"> / {formatCurrency(a.creditLimit, a.currency)}</span>
                              )}
                            </div>
                            {a.creditLimit != null && a.used != null && a.creditLimit > 0 && (
                              <div className="mt-1 h-1 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${a.used / a.creditLimit >= 0.8 ? 'bg-amber-500' : 'bg-accent-500'}`}
                                  style={{ width: `${Math.min(100, (a.used / a.creditLimit) * 100)}%` }}
                                />
                              </div>
                            )}
                          </>
                        ) : (
                          <div className={`mt-0.5 text-sm font-semibold tabular-nums truncate ${(a.balance ?? 0) < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>
                            {formatCurrency(a.balance ?? 0, a.currency)}
                          </div>
                        )}
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* "This month" glance — the one number Overview's hero answers, without a tap */}
              {glance && (
                <button
                  type="button"
                  onClick={() => setExplainOpen(true)}
                  aria-label="What does this number mean?"
                  className={`pressable text-left cursor-pointer rounded-xl border p-3 ${bankRows.length > 0 ? 'sm:w-64 sm:shrink-0' : 'w-full'} ${glance.endingBalance < 0
                    ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                    : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'}`}
                >
                  <div className="flex items-start justify-between gap-2 min-w-0">
                    <div className="min-w-0">
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">Projected end of {formatYearMonth(glance.yearMonth)}</div>
                      <div className={`text-lg font-bold ${glance.endingBalance < 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-900 dark:text-gray-100'}`}>
                        {formatCurrency(glance.endingBalance, glance.currency)}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                        {glance.endingBalance < 0
                          ? 'Heads up — this month ends in the red.'
                          : glance.netChange >= 0
                            ? "You're on track this month."
                            : `Spending ${formatCurrency(-glance.netChange, glance.currency)} more than you earn this month.`}
                      </div>
                    </div>
                    {bankRows.length === 0 && <MdChevronRight className="text-gray-400 shrink-0 self-center" size={22} />}
                  </div>
                </button>
              )}
            </div>
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

          {/* Split: per-group balances + recent activity in one card */}
          {(lines.length > 0 || events.length > 0) && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-5">
              {lines.length > 0 && (
                <>
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <span className="text-sm min-w-0">{overallLine()}</span>
                    <Link href="/split" className="text-sm text-accent-600 dark:text-accent-400 no-underline shrink-0">
                      All groups
                    </Link>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {lines.map((l) => (
                      <Link
                        key={l.group.id}
                        href={`/split/${l.group.id}`}
                        className="pressable no-underline rounded-lg border border-gray-100 dark:border-gray-700 dark:bg-white/[0.04] p-2.5 min-w-0"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-lg shrink-0 leading-none">{l.group.emoji ?? '🧾'}</span>
                          <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{l.group.name}</span>
                        </div>
                        <div className="mt-1 flex items-start gap-1.5 min-w-0">
                          {l.otherUserId && (
                            <UserAvatar userId={l.otherUserId} name={l.otherName} avatarUrl={profiles[l.otherUserId]?.avatarUrl} size={18} />
                          )}
                          {/* Wraps rather than truncates — the amount is the payload and must
                              stay whole on a 375px 2-col grid (fi-FI groups digits with
                              no-break spaces, so a wrap never splits the number itself). */}
                          <span className={`min-w-0 break-words text-xs leading-snug ${l.myNetCents > 0 ? 'text-green-600 dark:text-green-400' : l.myNetCents < 0 ? 'text-orange-600 dark:text-orange-400' : 'text-gray-400'}`}>
                            {/* No name in the phrase — the avatar carries identity, and for 3+
                                member groups the net is against the whole group anyway. */}
                            {l.myNetCents > 0
                              ? `you're owed ${formatCents(l.myNetCents, l.group.currency)}`
                              : l.myNetCents < 0
                                ? `you owe ${formatCents(-l.myNetCents, l.group.currency)}`
                                : 'settled'}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </>
              )}

              <div className={`text-sm font-medium text-gray-500 dark:text-gray-400 mb-1 ${lines.length > 0 ? 'mt-4 pt-3 border-t border-gray-100 dark:border-gray-800' : ''}`}>
                Recent activity
              </div>
              <SplitActivityFeed
                events={events}
                currency={currency}
                myId={myId}
                emptyText="No recent activity"
                onEventClick={(e) => router.push('/split/' + e.groupId)}
              />
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
