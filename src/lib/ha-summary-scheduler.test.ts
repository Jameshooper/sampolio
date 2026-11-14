/**
 * Tests for the summary scheduler's on/off decision.
 *
 * The important property is that the feature is genuinely off unless asked
 * for: a household that never configures it must make no outbound calls at
 * all, and a misconfiguration must fail closed rather than hammer a webhook.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveSummaryIntervalMinutes } from '@/lib/ha-summary-scheduler';

afterEach(() => vi.restoreAllMocks());

describe('resolveSummaryIntervalMinutes', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-30'],
    ['not a number', 'yes please'],
  ])('is off when %s', (_label, value) => {
    expect(resolveSummaryIntervalMinutes(value)).toBeNull();
  });

  it('accepts a sensible interval as given', () => {
    expect(resolveSummaryIntervalMinutes('30')).toBe(30);
    expect(resolveSummaryIntervalMinutes(' 60 ')).toBe(60);
  });

  it('clamps rather than honouring an extreme value', () => {
    // Every minute would be pointless load on a home server; once a fortnight
    // would be stale enough to mislead an automation reading the sensor.
    expect(resolveSummaryIntervalMinutes('1')).toBe(5);
    expect(resolveSummaryIntervalMinutes('99999')).toBe(1440);
  });
});

describe('startHaSummaryScheduler', () => {
  it('does not start when no webhook is configured, and says why', async () => {
    vi.stubEnv('HA_SUMMARY_MINUTES', '30');
    vi.stubEnv('HA_WEBHOOK_URL', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.resetModules();
    const { startHaSummaryScheduler, stopHaSummaryScheduler } = await import('@/lib/ha-summary-scheduler');
    // Spy only AFTER import: unrelated modules register their own timers at
    // load time, which would otherwise be counted here.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    startHaSummaryScheduler();
    stopHaSummaryScheduler();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('no Home Assistant webhook');
  });

  it('starts nothing at all when the interval is off', async () => {
    vi.stubEnv('HA_SUMMARY_MINUTES', '0');
    vi.stubEnv('HA_WEBHOOK_URL', 'https://ha.example/api/webhook/secret-id');
    vi.resetModules();
    const { startHaSummaryScheduler, stopHaSummaryScheduler } = await import('@/lib/ha-summary-scheduler');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    startHaSummaryScheduler();
    stopHaSummaryScheduler();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});
