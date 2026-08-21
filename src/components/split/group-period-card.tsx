'use client';

/**
 * "Last 30 days" summary card for one split group (rendered on /split/[id]
 * between the balance banner and the recurring-rules card).
 *
 * Always-visible: the window's total spend (plus a note when nobody fronted
 * money). The details expander — OPEN by default — carries two CSS mini
 * treemaps side by side, "By category" and "Who paid", laid out by the pure
 * slice-and-dice `computeTreemapLayout` (src/lib/treemap-layout.ts) and tinted
 * with each category's own color / each member's own avatar color, so both read
 * the same as everywhere else in the app. Under them sit the biggest single
 * expenses and the plain-words sentences.
 *
 * All arithmetic lives in the pure `computeGroupPeriodInsights`
 * (src/lib/split-insights.ts) — integer cents throughout. The treemaps are plain
 * divs, so the card still never pulls ECharts into the detail page's bundle.
 */

import { useMemo, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { MdExpandMore } from 'react-icons/md';
import { useAppContext } from '@/components/layout/app-layout';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { getAvatarColor } from '@/lib/avatar-utils';
import { formatCents, getCategoryColor } from '@/lib/constants';
import { computeGroupPeriodInsights } from '@/lib/split-insights';
import { computeTreemapLayout } from '@/lib/treemap-layout';
import { describeGroupPeriod } from '@/lib/chart-descriptions';
import type { SplitExpense, SplitGroup } from '@/types';

/** Days covered by the window, inclusive of today. */
const WINDOW_DAYS = 30;

/** Categories drawn individually; everything past this folds into "Other". */
const MAX_CATEGORY_TILES = 5;

/** Smallest tile (in % of the treemap box) that still fits a readable label. */
const LABEL_MIN_W = 22;
const LABEL_MIN_H = 26;

/** First name only ('You' for the viewer) — matches the detail rows' wording. */
function shortName(name: string, isMe: boolean): string {
  return isMe ? 'You' : name.split(' ')[0];
}

/** "Groceries 40%, Dining out 25%" — the treemap's screen-reader equivalent
 * (percentages only: the visual carries no money either). */
function tilesLabel(tiles: { label: string; share: number }[]): string {
  return tiles.map((t) => `${t.label} ${Math.round(t.share * 100)}%`).join(', ');
}

interface GroupPeriodCardProps {
  group: SplitGroup;
  /** The group's already-loaded rows (any window; the card filters). */
  expenses: SplitExpense[];
  myUserId: string;
}

export function GroupPeriodCard({ group, expenses, myUserId }: GroupPeriodCardProps) {
  const [open, setOpen] = useState(true);
  // The sentences bake money into strings inside a memo, so the demo-mask flag
  // has to stay in the deps or a toggle would strand stale text.
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

  // Category tiles: the leading few plus an "Other" bucket for the long tail.
  const categoryTiles = useMemo(() => {
    const cats = insights.topCategories;
    if (cats.length === 0) return [];
    const buckets = cats.slice(0, MAX_CATEGORY_TILES).map((c) => ({
      key: c.category,
      label: c.category,
      cents: c.cents,
      color: getCategoryColor(c.category),
    }));
    const restCents = cats.slice(MAX_CATEGORY_TILES).reduce((s, c) => s + c.cents, 0);
    if (restCents > 0) {
      const existingOther = buckets.find((b) => b.key === 'Other');
      if (existingOther) existingOther.cents += restCents;
      else buckets.push({ key: 'Other', label: 'Other', cents: restCents, color: getCategoryColor('Other') });
    }
    const total = buckets.reduce((s, b) => s + b.cents, 0);
    const rects = computeTreemapLayout(buckets.map((b) => b.cents));
    return buckets.map((b, i) => ({ ...b, rect: rects[i], share: total > 0 ? b.cents / total : 0 }));
  }, [insights]);

  // Member tiles: who fronted the money, already desc with a `pct` fraction.
  const memberTiles = useMemo(() => {
    const payers = insights.paidByMember;
    const rects = computeTreemapLayout(payers.map((p) => p.cents));
    return payers.map((p, i) => ({ ...p, rect: rects[i] }));
  }, [insights]);

  const categoryTreemapLabel = useMemo(() => tilesLabel(categoryTiles), [categoryTiles]);

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
            {(categoryTiles.length > 0 || payers.length > 0) && (
              <div className="grid gap-4 sm:grid-cols-2">
                {categoryTiles.length > 0 && (
                  <div className="min-w-0">
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      By category
                    </div>
                    <div role="img" aria-label={categoryTreemapLabel} className="relative h-24 rounded-lg overflow-hidden">
                      {categoryTiles.map((t) => (
                        <div
                          key={t.key}
                          title={`${t.label} — ${formatCents(t.cents, group.currency)}`}
                          className="absolute rounded-[3px] border-2 border-white dark:border-gray-800 flex items-center justify-center overflow-hidden"
                          style={{
                            left: `${t.rect.x}%`,
                            top: `${t.rect.y}%`,
                            width: `${t.rect.w}%`,
                            height: `${t.rect.h}%`,
                            background: t.color,
                          }}
                        >
                          {t.rect.w >= LABEL_MIN_W && t.rect.h >= LABEL_MIN_H && (
                            <span className="px-1 text-center text-[10px] font-medium leading-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)] truncate">
                              {t.label} {Math.round(t.share * 100)}%
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
                      {categoryTiles.slice(0, 3).map((t) => (
                        <span key={t.key} className="inline-flex items-center gap-1.5 min-w-0">
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: t.color }}
                          />
                          <span className="truncate">{t.label}</span>
                          <span className="tabular-nums text-gray-500 dark:text-gray-400">
                            {formatCents(t.cents, group.currency)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {payers.length > 0 && (
                  <div className="min-w-0">
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                      Who paid
                    </div>
                    <div role="img" aria-label={barLabel} className="relative h-24 rounded-lg overflow-hidden">
                      {memberTiles.map((p) => (
                        <div
                          key={p.userId}
                          title={`${shortName(p.name, p.userId === myUserId)} — ${formatCents(p.cents, group.currency)}`}
                          className="absolute rounded-[3px] border-2 border-white dark:border-gray-800 flex items-center justify-center overflow-hidden"
                          style={{
                            left: `${p.rect.x}%`,
                            top: `${p.rect.y}%`,
                            width: `${p.rect.w}%`,
                            height: `${p.rect.h}%`,
                            background: getAvatarColor(p.userId),
                          }}
                        >
                          {p.rect.w >= LABEL_MIN_W && p.rect.h >= LABEL_MIN_H && (
                            <span className="px-1 text-center text-[10px] font-medium leading-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.35)] truncate">
                              {shortName(p.name, p.userId === myUserId)} {Math.round(p.pct * 100)}%
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-gray-600 dark:text-gray-300">
                      {payers.map((p) => (
                        <span key={p.userId} className="inline-flex items-center gap-1.5 min-w-0">
                          <UserAvatar
                            userId={p.userId}
                            name={p.name}
                            avatarUrl={profiles[p.userId]?.avatarUrl}
                            size={20}
                          />
                          <span className="truncate">{shortName(p.name, p.userId === myUserId)}</span>
                          <span className="tabular-nums text-gray-500 dark:text-gray-400">
                            {Math.round(p.pct * 100)}% · {formatCents(p.cents, group.currency)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
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
