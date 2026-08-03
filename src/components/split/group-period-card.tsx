'use client';

/**
 * "Last 30 days" summary card for one split group (rendered on /split/[id]
 * between the balance banner and the recurring-rules card).
 *
 * Always-visible: the window's total spend plus a segmented who-paid bar tinted
 * with each member's own avatar color, so the bar reads as the same people shown
 * everywhere else. A default-closed expander adds the leading categories, the
 * biggest single expenses and the plain-words sentences.
 *
 * All arithmetic lives in the pure `computeGroupPeriodInsights`
 * (src/lib/split-insights.ts) — integer cents throughout. No charts here, so
 * the card never pulls ECharts into the detail page's bundle.
 */

import { useMemo, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { MdExpandMore } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { CategoryIcon } from '@/components/split/category-icon';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { getAvatarColor } from '@/lib/avatar-utils';
import { formatCents } from '@/lib/constants';
import { computeGroupPeriodInsights } from '@/lib/split-insights';
import { describeGroupPeriod } from '@/lib/chart-descriptions';
import type { SplitExpense, SplitGroup } from '@/types';

/** Days covered by the window, inclusive of today. */
const WINDOW_DAYS = 30;

/** First name only ('You' for the viewer) — matches the detail rows' wording. */
function shortName(name: string, isMe: boolean): string {
  return isMe ? 'You' : name.split(' ')[0];
}

interface GroupPeriodCardProps {
  group: SplitGroup;
  /** The group's already-loaded rows (any window; the card filters). */
  expenses: SplitExpense[];
  myUserId: string;
}

export function GroupPeriodCard({ group, expenses, myUserId }: GroupPeriodCardProps) {
  const [open, setOpen] = useState(false);
  // /split is demo-mask exempt today, but the sentences bake money into strings
  // inside a memo — keep the flag in the deps so a future policy change can't
  // strand stale text.
  const { demoMasked } = useAppContext() ?? {};

  const insights = useMemo(() => {
    const fromDate = format(subDays(new Date(), WINDOW_DAYS - 1), 'yyyy-MM-dd');
    const toDate = format(new Date(), 'yyyy-MM-dd');
    return computeGroupPeriodInsights(group.members, expenses, fromDate, toDate);
  }, [group.members, expenses]);

  const payerIds = useMemo(() => insights.paidByMember.map((p) => p.userId), [insights]);
  const profiles = useUserProfiles(payerIds);

  const sentences = useMemo(
    () => describeGroupPeriod(insights, group.members.length, (n) => formatCents(n, group.currency)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- formatCents output depends on demo mode
    [insights, group.members.length, group.currency, demoMasked],
  );

  if (insights.expenseCount === 0 && insights.settledCents === 0) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">No expenses in the last 30 days.</p>
      </div>
    );
  }

  const payers = insights.paidByMember;
  const barLabel = payers.length
    ? payers.map((p) => `${shortName(p.name, p.userId === myUserId)} paid ${Math.round(p.pct * 100)}%`).join(', ')
    : 'Nobody has fronted money in this period';

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 mb-4">
      {/* Headline */}
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Last 30 days
        </span>
        <span className="text-lg font-semibold">{formatCents(insights.totalSpendCents, group.currency)}</span>
      </div>

      {/* Who paid — segmented bar + legend */}
      {payers.length > 0 && (
        <>
          <div
            role="img"
            aria-label={barLabel}
            className="mt-2.5 h-2.5 rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-700"
          >
            {payers.map((p) => (
              <span
                key={p.userId}
                className="h-full"
                style={{ width: `${p.pct * 100}%`, background: getAvatarColor(p.userId) }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
            {payers.map((p) => (
              <span key={p.userId} className="inline-flex items-center gap-1.5 min-w-0">
                <UserAvatar userId={p.userId} name={p.name} avatarUrl={profiles[p.userId]?.avatarUrl} size={20} />
                <span className="truncate">{shortName(p.name, p.userId === myUserId)}</span>
                <span className="tabular-nums text-gray-500 dark:text-gray-400">
                  {Math.round(p.pct * 100)}% · {formatCents(p.cents, group.currency)}
                </span>
              </span>
            ))}
          </div>
        </>
      )}
      {payers.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {insights.expenseCount === 0
            ? `Only settle-up payments in this period (${formatCents(insights.settledCents, group.currency)}).`
            : 'Who fronted the money is not recorded for these expenses.'}
        </p>
      )}

      {/* Details expander */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-2 -mx-1 flex min-h-11 w-full items-center gap-1 rounded-md px-1 text-sm font-medium text-gray-600 dark:text-gray-300 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
      >
        <span>{open ? 'Hide details' : 'Show details'}</span>
        <MdExpandMore
          size={18}
          aria-hidden
          className={`ml-auto opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
          style={{ transitionDuration: 'var(--motion-base)' }}
        />
      </button>
      <div className={`collapse-grid ${open ? 'is-open' : ''}`} inert={open ? undefined : true}>
        <div>
          <div className="pt-1 flex flex-col gap-3">
            {insights.topCategories.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {insights.topCategories.slice(0, 3).map((c) => (
                  <span
                    key={c.category}
                    className="inline-flex items-center gap-2 rounded-full bg-gray-100 dark:bg-gray-700/60 pl-1 pr-3 py-1 text-xs"
                  >
                    <CategoryIcon category={c.category} size={22} />
                    <span className="truncate">{c.category}</span>
                    <span className="tabular-nums font-medium">{formatCents(c.cents, group.currency)}</span>
                  </span>
                ))}
              </div>
            )}

            {insights.topExpenses.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {insights.topExpenses.map((e) => (
                  <li key={e.id} className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      {format(parseISO(e.date), 'MMM d')}
                    </span>
                    <span className="shrink-0 tabular-nums font-medium">{formatCents(e.cents, group.currency)}</span>
                  </li>
                ))}
              </ul>
            )}

            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {sentences.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>

            {insights.hasImportedRows && (
              <p className="text-xs text-gray-400 dark:text-gray-500">
                (paid amounts are a lower bound for imported rows)
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
