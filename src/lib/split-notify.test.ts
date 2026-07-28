import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildSplitWebhookPayload,
  getSplitNotifyConfig,
  isSplitNotifyEnabled,
  postSplitWebhook,
  type SplitNotifyInput,
  type SplitWebhookPayload,
} from './split-notify';
import { setDemoMask } from '@/lib/demo-mode';
import type {
  SplitExpenseItem,
  SplitGroup,
  SplitGroupMember,
  SplitPayment,
  UserPreferences,
} from '@/types';

// ---------- synthetic fixtures (public repo: invented people only) ----------

const ALEX = 'a1';
const SAM = 's1';
const KIM = 'k1';

const BASE = 'https://money.example.com';
const TS = '2026-03-04T10:20:30.000Z';

const member = (userId: string, name: string): SplitGroupMember => ({
  userId,
  email: `${name.toLowerCase()}@example.com`,
  name,
  role: userId === ALEX ? 'owner' : 'member',
});

function group(overrides: Partial<SplitGroup> = {}): SplitGroup {
  return {
    id: 'g1',
    name: 'Flatmates',
    emoji: '🏠',
    currency: 'EUR',
    members: [member(ALEX, 'Alex'), member(SAM, 'Sam'), member(KIM, 'Kim')],
    recurrenceRules: [],
    isArchived: false,
    createdBy: ALEX,
    createdAt: TS,
    updatedAt: TS,
    updatedBy: ALEX,
    ...overrides,
  };
}

function expense(overrides: Partial<SplitExpenseItem> = {}): SplitExpenseItem {
  return {
    kind: 'expense',
    id: 'e1',
    groupId: 'g1',
    date: '2026-03-04',
    currency: 'EUR',
    netByUserId: { [ALEX]: 2834, [SAM]: -1417, [KIM]: -1417 },
    source: 'manual',
    createdByUserId: ALEX,
    createdAt: TS,
    updatedAt: TS,
    title: 'Groceries',
    category: 'Food',
    amountCents: 4250,
    ...overrides,
  };
}

function payment(overrides: Partial<SplitPayment> = {}): SplitPayment {
  return {
    kind: 'payment',
    id: 'p1',
    groupId: 'g1',
    date: '2026-03-05',
    currency: 'EUR',
    netByUserId: { [SAM]: 4250, [ALEX]: -4250 },
    source: 'manual',
    createdByUserId: SAM,
    createdAt: TS,
    updatedAt: TS,
    fromUserId: SAM,
    toUserId: ALEX,
    amountCents: 4250,
    ...overrides,
  };
}

const build = (
  input: SplitNotifyInput,
  optedOut: string[] = [],
  base = BASE,
): SplitWebhookPayload | null => buildSplitWebhookPayload(input, base, TS, new Set(optedOut));

/** The expense-shaped branch of the input union (so `{...created(), event}` stays typed). */
type ExpenseNotifyInput = Extract<SplitNotifyInput, { expense: SplitExpenseItem }>;

const created = (overrides?: Partial<SplitExpenseItem>, g = group()): ExpenseNotifyInput => ({
  event: 'expense.created',
  group: g,
  authorUserId: ALEX,
  expense: expense(overrides),
});

beforeEach(() => {
  // The money mask is a process-wide flag shared by every test file.
  setDemoMask(false);
});

// ---------- recipients ----------

describe('buildSplitWebhookPayload — recipients', () => {
  it('excludes the author and carries id/name/email for each recipient', () => {
    const payload = build(created());
    expect(payload).not.toBeNull();
    expect(payload!.recipients).toEqual([
      { id: SAM, name: 'Sam', email: 'sam@example.com' },
      { id: KIM, name: 'Kim', email: 'kim@example.com' },
    ]);
  });

  it('never leaks an email for the author', () => {
    const payload = build(created())!;
    expect(payload.author).toEqual({ id: ALEX, name: 'Alex' });
    expect(payload.author).not.toHaveProperty('email');
  });

  it('drops opted-out members', () => {
    const payload = build(created(), [SAM])!;
    expect(payload.recipients.map((r) => r.id)).toEqual([KIM]);
  });

  it('returns null when every other member opted out', () => {
    expect(build(created(), [SAM, KIM])).toBeNull();
  });

  it('returns null for a single-member group', () => {
    const solo = group({ members: [member(ALEX, 'Alex')] });
    expect(build(created(undefined, solo))).toBeNull();
  });
});

// ---------- opt-out gate ----------

describe('isSplitNotifyEnabled', () => {
  const prefs = (splitNotificationPrefs: UserPreferences['splitNotificationPrefs']): UserPreferences => ({
    hasCompletedOnboarding: true,
    splitNotificationPrefs,
    updatedAt: TS,
  });

  it('defaults to enabled when prefs are missing', () => {
    expect(isSplitNotifyEnabled(undefined, 'expense.created')).toBe(true);
    expect(isSplitNotifyEnabled(null, 'expense.created')).toBe(true);
    expect(isSplitNotifyEnabled(prefs(undefined), 'expense.created')).toBe(true);
  });

  it('defaults to enabled for an empty record', () => {
    expect(isSplitNotifyEnabled(prefs({}), 'expense.created')).toBe(true);
  });

  it('only disables the event set to false', () => {
    const p = prefs({ 'expense.created': false });
    expect(isSplitNotifyEnabled(p, 'expense.created')).toBe(false);
    expect(isSplitNotifyEnabled(p, 'expense.updated')).toBe(true);
    expect(isSplitNotifyEnabled(p, 'expense.deleted')).toBe(true);
    expect(isSplitNotifyEnabled(p, 'payment.recorded')).toBe(true);
    expect(isSplitNotifyEnabled(p, 'expense.generated')).toBe(true);
  });

  it('treats an explicit true as enabled', () => {
    expect(isSplitNotifyEnabled(prefs({ 'payment.recorded': true }), 'payment.recorded')).toBe(true);
  });
});

// ---------- config ----------

describe('getSplitNotifyConfig', () => {
  const saved = { hook: process.env.HA_WEBHOOK_URL, authUrl: process.env.AUTH_URL };

  beforeEach(() => {
    process.env.HA_WEBHOOK_URL = 'https://ha.example.com/api/webhook/abc123';
    process.env.AUTH_URL = 'https://money.example.com/';
  });

  afterEach(() => {
    if (saved.hook === undefined) delete process.env.HA_WEBHOOK_URL;
    else process.env.HA_WEBHOOK_URL = saved.hook;
    if (saved.authUrl === undefined) delete process.env.AUTH_URL;
    else process.env.AUTH_URL = saved.authUrl;
  });

  it('strips a trailing slash from the deep-link base', () => {
    expect(getSplitNotifyConfig()).toEqual({
      webhookUrl: 'https://ha.example.com/api/webhook/abc123',
      deepLinkBase: 'https://money.example.com',
    });
  });

  it('returns null without HA_WEBHOOK_URL', () => {
    delete process.env.HA_WEBHOOK_URL;
    expect(getSplitNotifyConfig()).toBeNull();
  });

  it('returns null without AUTH_URL', () => {
    delete process.env.AUTH_URL;
    expect(getSplitNotifyConfig()).toBeNull();
  });

  it('treats a blank value as missing', () => {
    process.env.HA_WEBHOOK_URL = '   ';
    expect(getSplitNotifyConfig()).toBeNull();
  });
});

// ---------- deep link, group, timestamp ----------

describe('buildSplitWebhookPayload — envelope', () => {
  it('deep-links to the group page', () => {
    expect(build(created())!.url).toBe(`${BASE}/split/g1`);
  });

  it('carries the group identity (emoji + currency) and the given timestamp', () => {
    const payload = build(created())!;
    expect(payload.group).toEqual({ id: 'g1', name: 'Flatmates', emoji: '🏠', currency: 'EUR' });
    expect(payload.ts).toBe(TS);
  });

  it('omits an absent emoji without inventing one', () => {
    const g = group({ emoji: undefined });
    expect(build(created(undefined, g))!.group.emoji).toBeUndefined();
  });

  it('falls back to "Someone" for an unknown author id', () => {
    const payload = build({ ...created(), authorUserId: 'ghost' })!;
    expect(payload.author).toEqual({ id: 'ghost', name: 'Someone' });
    expect(payload.message).toBe("Someone added 'Groceries' — €42,50 in Flatmates");
    // An unknown author is nobody's member row, so everybody is a recipient.
    expect(payload.recipients).toHaveLength(3);
  });
});

// ---------- money formatting ----------

describe('buildSplitWebhookPayload — money', () => {
  it('formats cents in fi-FI', () => {
    expect(build(created({ amountCents: 4250 }))!.message).toContain('€42,50');
    // fi-FI groups thousands with a non-breaking space (U+00A0).
    expect(build(created({ amountCents: 123456 }))!.message).toContain('€1 234,56');
  });

  it('uses the row currency, not the group default', () => {
    const g = group({ currency: 'SEK' });
    const input: SplitNotifyInput = {
      event: 'expense.created',
      group: g,
      authorUserId: ALEX,
      expense: expense({ currency: 'SEK', amountCents: 10000 }),
    };
    const payload = build(input)!;
    expect(payload.expense!.currency).toBe('SEK');
    expect(payload.message).toContain('kr100,00');
  });
});

// ---------- per-event messages + blocks ----------

describe('buildSplitWebhookPayload — events', () => {
  it('expense.created', () => {
    const payload = build(created())!;
    expect(payload.event).toBe('expense.created');
    expect(payload.message).toBe("Alex added 'Groceries' — €42,50 in Flatmates");
    expect(payload.expense).toEqual({
      id: 'e1',
      title: 'Groceries',
      category: 'Food',
      amountCents: 4250,
      currency: 'EUR',
      date: '2026-03-04',
      source: 'manual',
    });
    expect(payload.payment).toBeUndefined();
  });

  it('expense.updated', () => {
    const payload = build({ ...created(), event: 'expense.updated' })!;
    expect(payload.event).toBe('expense.updated');
    expect(payload.message).toBe("Alex updated 'Groceries' — €42,50 in Flatmates");
  });

  it('expense.deleted', () => {
    const payload = build({ ...created(), event: 'expense.deleted' })!;
    expect(payload.event).toBe('expense.deleted');
    expect(payload.message).toBe("Alex deleted 'Groceries' — €42,50 in Flatmates");
  });

  it('expense.generated names the rule payer and passes the source through', () => {
    const payload = build({
      event: 'expense.generated',
      group: group(),
      authorUserId: SAM,
      expense: expense({ title: 'Rent', amountCents: 90000, source: 'recurring', generatedFromRuleId: 'r1' }),
    })!;
    expect(payload.message).toBe("Recurring expense 'Rent' — €900,00 added in Flatmates (paid by Sam)");
    expect(payload.expense!.source).toBe('recurring');
    // The rule's payer is the author, so they are not notified.
    expect(payload.recipients.map((r) => r.id)).toEqual([ALEX, KIM]);
  });

  it('payment.recorded names payer and payee, with no suffix when the payer recorded it', () => {
    const payload = build({ event: 'payment.recorded', group: group(), authorUserId: SAM, payment: payment() })!;
    expect(payload.event).toBe('payment.recorded');
    expect(payload.message).toBe('Sam paid Alex €42,50 in Flatmates');
    expect(payload.message).not.toContain('recorded by');
    expect(payload.payment).toEqual({
      fromUserId: SAM,
      toUserId: ALEX,
      amountCents: 4250,
      currency: 'EUR',
    });
    expect(payload.expense).toBeUndefined();
  });

  it('payment.recorded appends the recorder when someone else logged it', () => {
    const payload = build({ event: 'payment.recorded', group: group(), authorUserId: KIM, payment: payment() })!;
    expect(payload.message).toBe('Sam paid Alex €42,50 in Flatmates (recorded by Kim)');
  });
});

// ---------- transport ----------

describe('postSplitWebhook', () => {
  const HOOK = 'https://ha.example.com/api/webhook/s3cret-id';
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const payloadOf = () => build(created())!;

  it('POSTs JSON that round-trips, with the JSON content type', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const payload = payloadOf();
    await postSplitWebhook(HOOK, payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(errors).toEqual([]);
  });

  it('resolves (never throws) when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(postSplitWebhook(HOOK, payloadOf())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expense.created');
    expect(errors[0]).toContain('TypeError');
  });

  it('resolves and logs the status when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(postSplitWebhook(HOOK, payloadOf())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expense.created');
    expect(errors[0]).toContain('503');
  });

  it('never logs the webhook URL, member names, or amounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await postSplitWebhook(HOOK, payloadOf());
    const logged = errors.join('\n');
    expect(logged).not.toContain(HOOK);
    expect(logged).not.toContain('s3cret-id');
    expect(logged).not.toContain('Alex');
    expect(logged).not.toContain('Sam');
    expect(logged).not.toContain('sam@example.com');
    expect(logged).not.toContain('Groceries');
    expect(logged).not.toContain('42,50');
    expect(logged).not.toContain('Flatmates');
  });
});
