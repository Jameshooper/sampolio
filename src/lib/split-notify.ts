/**
 * Split activity → Home Assistant webhook notifications.
 *
 * Every split-group mutation (expense added/edited/deleted, settle-up recorded,
 * recurring expense materialized) POSTs one structured JSON payload to a Home
 * Assistant webhook, which fans it out to the recipients' phones. HA owns the
 * delivery policy (which person gets which notification); this module owns the
 * payload — including a prebuilt human-readable `message` so the automation
 * needs no formatting logic of its own.
 *
 * SERVER-ONLY PLAIN MODULE — deliberately NOT 'use server'. Two reasons: the
 * pure helpers below are synchronous exports (illegal in a 'use server' file),
 * and the transport must never become a client-invokable endpoint — the same
 * rationale as `projection-inputs.ts` and `bank/teardown.ts`.
 *
 * HARD-DISABLE: without both `HA_WEBHOOK_URL` (the webhook, secret id included)
 * and `AUTH_URL` (the deep-link base) `getSplitNotifyConfig()` returns null and
 * NO network call is ever made — mirroring `getBankConfig()`. A missing secret
 * is never defaulted.
 *
 * FIRE-AND-FORGET: `notifySplitActivity` never throws and never delays the
 * mutation. It only *schedules* work via Next's `after()`, so the POST runs
 * after the response has been sent; a down/slow Home Assistant can neither fail
 * nor slow a user's save. Delivery is best-effort — there is no retry or queue.
 *
 * REDACTION: never log the webhook URL (it embeds the secret webhook id) and
 * never log payload contents (member names, emails, amounts, titles). Failures
 * log the event type plus an HTTP status or an error *name* only.
 */

import { after } from 'next/server';
import { formatCents } from '@/lib/constants';
import { getUserPreferences } from '@/lib/db/user-preferences';
import type {
  Currency,
  SplitExpenseItem,
  SplitExpenseSource,
  SplitGroup,
  SplitNotifyEvent,
  SplitPayment,
  UserPreferences,
} from '@/types';

/** The JSON contract POSTed to Home Assistant. See docs/features.md §1. */
export interface SplitWebhookPayload {
  event: SplitNotifyEvent;
  ts: string; // ISO event timestamp
  message: string; // prebuilt human-readable summary (full detail)
  url: string; // deep link `${base}/split/${groupId}`
  group: { id: string; name: string; emoji?: string; currency: Currency };
  author: { id: string; name: string };
  /** Members except the author, except those who opted out of this event. */
  recipients: { id: string; name: string; email: string }[];
  expense?: {
    id: string;
    title: string;
    category: string;
    amountCents: number;
    currency: Currency;
    date: string;
    source: SplitExpenseSource;
  };
  payment?: { fromUserId: string; toUserId: string; amountCents: number; currency: Currency };
}

export type SplitNotifyInput =
  | {
      event: 'expense.created' | 'expense.updated' | 'expense.deleted' | 'expense.generated';
      group: SplitGroup;
      authorUserId: string;
      expense: SplitExpenseItem;
    }
  | { event: 'payment.recorded'; group: SplitGroup; authorUserId: string; payment: SplitPayment };

/** How long we wait for Home Assistant before giving up on one POST. */
const SPLIT_NOTIFY_TIMEOUT_MS = 5_000;

export interface SplitNotifyConfig {
  webhookUrl: string;
  deepLinkBase: string;
}

/**
 * Resolve the notification configuration from the environment. Returns null
 * (feature off) when either the webhook URL or the deep-link base is missing —
 * callers must treat null as "feature off", never substitute a default.
 */
export function getSplitNotifyConfig(): SplitNotifyConfig | null {
  const webhookUrl = process.env.HA_WEBHOOK_URL?.trim();
  const deepLinkBase = process.env.AUTH_URL?.trim().replace(/\/$/, '');
  if (!webhookUrl || !deepLinkBase) return null;
  return { webhookUrl, deepLinkBase };
}

/**
 * Opt-out gate: a member is notified unless they explicitly turned this event
 * off. Absent prefs / absent object / absent key all mean enabled.
 */
export function isSplitNotifyEnabled(
  prefs: UserPreferences | null | undefined,
  event: SplitNotifyEvent,
): boolean {
  return prefs?.splitNotificationPrefs?.[event] !== false;
}

function memberName(group: SplitGroup, userId: string): string {
  return group.members.find((m) => m.userId === userId)?.name ?? 'Someone';
}

/**
 * Build the webhook payload. PURE — no I/O, no clock (`ts` is passed in) — so
 * the whole message/recipient contract is unit-testable.
 *
 * Returns null when there is nobody left to notify (a solo group, or every
 * other member opted out of this event) — the caller then skips the POST.
 */
export function buildSplitWebhookPayload(
  input: SplitNotifyInput,
  deepLinkBase: string,
  ts: string,
  optedOutUserIds: ReadonlySet<string>,
): SplitWebhookPayload | null {
  const { group, authorUserId } = input;

  const recipients = group.members
    .filter((m) => m.userId !== authorUserId && !optedOutUserIds.has(m.userId))
    .map((m) => ({ id: m.userId, name: m.name, email: m.email }));
  if (recipients.length === 0) return null;

  const authorName = memberName(group, authorUserId);
  const base = {
    event: input.event,
    ts,
    url: `${deepLinkBase}/split/${group.id}`,
    group: { id: group.id, name: group.name, emoji: group.emoji, currency: group.currency },
    author: { id: authorUserId, name: authorName },
    recipients,
  };

  if (input.event === 'payment.recorded') {
    const { payment } = input;
    const amount = formatCents(payment.amountCents, payment.currency);
    const fromName = memberName(group, payment.fromUserId);
    const toName = memberName(group, payment.toUserId);
    // A third member can record someone else's payment — name the recorder only
    // then, so the common case reads naturally.
    const recordedBy = authorUserId !== payment.fromUserId ? ` (recorded by ${authorName})` : '';
    return {
      ...base,
      event: 'payment.recorded',
      message: `${fromName} paid ${toName} ${amount} in ${group.name}${recordedBy}`,
      payment: {
        fromUserId: payment.fromUserId,
        toUserId: payment.toUserId,
        amountCents: payment.amountCents,
        currency: payment.currency,
      },
    };
  }

  const { expense } = input;
  const amount = formatCents(expense.amountCents, expense.currency);
  let message: string;
  switch (input.event) {
    case 'expense.created':
      message = `${authorName} added '${expense.title}' — ${amount} in ${group.name}`;
      break;
    case 'expense.updated':
      message = `${authorName} updated '${expense.title}' — ${amount} in ${group.name}`;
      break;
    case 'expense.deleted':
      message = `${authorName} deleted '${expense.title}' — ${amount} in ${group.name}`;
      break;
    case 'expense.generated':
      // Nobody "did" this — the rule fired. The author is the rule's payer.
      message = `Recurring expense '${expense.title}' — ${amount} added in ${group.name} (paid by ${authorName})`;
      break;
  }

  return {
    ...base,
    event: input.event,
    message,
    expense: {
      id: expense.id,
      title: expense.title,
      category: expense.category,
      amountCents: expense.amountCents,
      currency: expense.currency,
      date: expense.date,
      source: expense.source,
    },
  };
}

/**
 * Deliver one payload. NEVER rejects: a timeout, a network error, or a non-2xx
 * response is logged (event type + status/error name only) and swallowed.
 */
export async function postSplitWebhook(
  webhookUrl: string,
  payload: SplitWebhookPayload,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPLIT_NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`Split webhook delivery failed (${payload.event}): HTTP ${res.status}`);
    }
  } catch (error) {
    // Never log the URL or the payload — only the event and the error class.
    const name = error instanceof Error ? error.name : 'Unknown';
    console.error(`Split webhook delivery failed (${payload.event}): ${name}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entry point used by the split server actions. Schedules the notification for
 * after the response (Next's `after()`), so the mutation is never delayed and a
 * failure here can never fail the mutation. Safe to call inside a group lock —
 * only the *scheduling* happens inline.
 */
export function notifySplitActivity(input: SplitNotifyInput): void {
  try {
    const config = getSplitNotifyConfig();
    if (!config) return; // feature off — zero network calls

    after(async () => {
      try {
        // Deliberately the PLAIN db read, not the 'use cache' wrapper: after()
        // runs outside a reliable cache scope.
        const others = input.group.members.filter((m) => m.userId !== input.authorUserId);
        const optedOutUserIds = new Set<string>();
        for (const m of others) {
          const prefs = await getUserPreferences(m.userId);
          if (!isSplitNotifyEnabled(prefs, input.event)) optedOutUserIds.add(m.userId);
        }

        const payload = buildSplitWebhookPayload(
          input,
          config.deepLinkBase,
          new Date().toISOString(),
          optedOutUserIds,
        );
        if (!payload) return; // nobody to notify

        await postSplitWebhook(config.webhookUrl, payload);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Unknown';
        console.error(`Split notification failed (${input.event}): ${name}`);
      }
    });
  } catch {
    // after() outside a request scope, or anything else — notifications are
    // never allowed to break a mutation.
  }
}
