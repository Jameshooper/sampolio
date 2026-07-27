'use client';

import { useMemo } from 'react';
import { parseISO, format } from 'date-fns';
import { CategoryIcon } from './category-icon';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useUserProfiles } from '@/lib/hooks/use-user-profiles';
import { formatCents } from '@/lib/constants';
import type { Currency, SplitActivityEvent } from '@/types';

function netLabel(cents: number, currency: Currency): { text: string; cls: string } {
  if (cents > 0) return { text: `you lent ${formatCents(cents, currency)}`, cls: 'text-green-600 dark:text-green-400' };
  if (cents < 0) return { text: `you borrowed ${formatCents(-cents, currency)}`, cls: 'text-orange-600 dark:text-orange-400' };
  return { text: 'not involved', cls: 'text-gray-400' };
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full;
}

/**
 * Cross-group recent-activity list (Home) and per-group feeds. Each row shows
 * the category icon, what it was, the group (optional), and the viewer's net.
 *
 * Rows are non-interactive by default. Pass `onEventClick` to make them
 * clickable (e.g. Home deep-links into the group; a group's own Activity tab
 * opens the edit dialog for expense rows) — `isEventClickable` narrows which
 * rows actually respond (defaults to all of them).
 */
export function SplitActivityFeed({
  events,
  currency,
  showGroup = true,
  emptyText = 'No activity yet',
  onEventClick,
  isEventClickable = () => true,
  myId,
}: {
  events: SplitActivityEvent[];
  currency: Currency;
  showGroup?: boolean;
  emptyText?: string;
  onEventClick?: (e: SplitActivityEvent) => void;
  isEventClickable?: (e: SplitActivityEvent) => boolean;
  /** Viewer's user id — their own rows read "added by You". */
  myId?: string;
}) {
  // Actor avatars — resolved once for the distinct actors in this page of events.
  const actorIds = useMemo(() => [...new Set(events.map((e) => e.actorUserId))], [events]);
  const profiles = useUserProfiles(actorIds);

  if (events.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">{emptyText}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
      {events.map((e) => {
        const lbl = netLabel(e.viewerNetCents, currency);
        const clickable = !!onEventClick && isEventClickable(e);
        return (
          <li
            key={`${e.groupId}-${e.id}`}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onEventClick!(e) : undefined}
            onKeyDown={
              clickable
                ? (ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return;
                    ev.preventDefault();
                    onEventClick!(e);
                  }
                : undefined
            }
            className={`flex items-center gap-3 py-2.5 ${
              clickable
                ? '-mx-2 px-2 rounded-lg cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 active:bg-gray-100 dark:active:bg-gray-700/70'
                : ''
            }`}
          >
            <CategoryIcon category={e.category ?? 'General'} size={36} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-gray-900 dark:text-gray-100">{e.title}</div>
              <div className="truncate text-xs text-gray-400">
                {e.kind === 'expense' && (
                  <UserAvatar
                    userId={e.actorUserId}
                    name={e.actorName}
                    avatarUrl={profiles[e.actorUserId]?.avatarUrl}
                    size={16}
                    className="inline-flex align-middle mr-1"
                  />
                )}
                {e.kind === 'expense'
                  ? `added by ${e.actorUserId === myId ? 'You' : firstName(e.actorName)} · `
                  : ''}
                {format(parseISO(e.date), 'MMM d')}
                {showGroup ? ` · ${e.groupEmoji ? e.groupEmoji + ' ' : ''}${e.groupName}` : ''}
                {e.source === 'recurring' ? ' · ↻' : ''}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm text-gray-500 dark:text-gray-400">{formatCents(e.amountCents, currency)}</div>
              <div className={`text-xs ${lbl.cls}`}>{lbl.text}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
