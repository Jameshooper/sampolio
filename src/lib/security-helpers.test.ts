import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getClientIp, getTrustedProxyHops } from './client-ip';
import { safeCallbackPath } from './safe-redirect';
import { escapeHtml } from './html-escape';
import {
  isMemberLookupThrottled,
  recordFailedMemberLookup,
  resetMemberLookupLimitForTests,
  MAX_FAILED_MEMBER_LOOKUPS,
} from './member-lookup-limit';

const headers = (xff?: string) => new Headers(xff ? { 'x-forwarded-for': xff } : {});

describe('getClientIp', () => {
  afterEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  it('defaults to one trusted hop and takes the right-most entry', () => {
    expect(getTrustedProxyHops()).toBe(1);
    expect(getClientIp(headers('198.51.100.7'))).toBe('198.51.100.7');
    // A client-supplied left-most entry is ignored.
    expect(getClientIp(headers('6.6.6.6, 198.51.100.7'))).toBe('198.51.100.7');
  });

  it('honours TRUSTED_PROXY_HOPS', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(getClientIp(headers('6.6.6.6, 198.51.100.7, 10.0.0.1'))).toBe('198.51.100.7');
    // Fewer entries than proxies: the request skipped a proxy → untrusted.
    expect(getClientIp(headers('6.6.6.6'))).toBe('direct');
  });

  it('ignores the header entirely with TRUSTED_PROXY_HOPS=0', () => {
    process.env.TRUSTED_PROXY_HOPS = '0';
    expect(getClientIp(headers('198.51.100.7'))).toBe('direct');
  });

  it('treats a missing header as a direct client and garbage config as the default', () => {
    expect(getClientIp(headers())).toBe('direct');
    process.env.TRUSTED_PROXY_HOPS = 'lots';
    expect(getTrustedProxyHops()).toBe(1);
  });
});

describe('safeCallbackPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeCallbackPath('/settings?tab=bank')).toBe('/settings?tab=bank');
    expect(safeCallbackPath('/')).toBe('/');
  });

  it('rejects anything that could leave the origin', () => {
    for (const bad of ['https://evil.example/phish', '//evil.example', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', 'evil.example', '/ok\u0000', ' https://evil.example']) {
      expect(safeCallbackPath(bad), bad).toBe('/');
    }
    expect(safeCallbackPath(null)).toBe('/');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(escapeHtml("Tom & Jerry's `cafe`")).toBe('Tom &amp; Jerry&#39;s &#96;cafe&#96;');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('chart tooltips never interpolate user text raw', () => {
  // ECharts renders tooltip formatter output as HTML. Names (series, nodes,
  // edges, items) come from users and bank feeds, so they must be escaped.
  const roots = ['src/components'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) files.push(full);
    }
  };
  roots.forEach((r) => walk(path.resolve(process.cwd(), r)));

  it('finds the chart sources', () => {
    expect(files.some((f) => f.endsWith('split-spend-chart.tsx'))).toBe(true);
  });

  it('has no raw ${…seriesName|name|source|target|axisValue} inside HTML template strings', () => {
    const raw = /\$\{\s*(?:[A-Za-z_]+(?:\[\d+\])?\.)+(seriesName|name|source|target|axisValue)\s*\}/;
    const offenders: string[] = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Only template literals that themselves build markup are HTML;
        // JSX props like label={`${x.name}`} are escaped by React.
        for (const tpl of line.match(/`[^`]*`/g) ?? []) {
          if (raw.test(tpl) && /<\/?[a-z]+[^>]*>/i.test(tpl)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('member lookup throttle', () => {
  it('blocks a user after too many unknown emails, per user', () => {
    resetMemberLookupLimitForTests();
    for (let i = 0; i < MAX_FAILED_MEMBER_LOOKUPS; i++) recordFailedMemberLookup('sam');
    expect(isMemberLookupThrottled('sam')).toBe(true);
    expect(isMemberLookupThrottled('alex')).toBe(false);
    // Window expiry
    expect(isMemberLookupThrottled('sam', Date.now() + 2 * 60 * 60 * 1000)).toBe(false);
  });
});
