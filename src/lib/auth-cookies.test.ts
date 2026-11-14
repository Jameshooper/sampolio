/**
 * Tests for the session cookie's Secure/`__Secure-` decision.
 *
 * This is the single setting that decided whether the Home Assistant add-on
 * could be signed into at all: served as plain http://<lan-ip>:3999, the
 * browser silently discarded a `__Secure-`-prefixed cookie, so a correct
 * password produced a sign-in that never stuck and logged nothing. It is also
 * a security control on every HTTPS deployment, so the fail-safe direction
 * matters as much as the fix.
 */
import { describe, it, expect } from 'vitest';
import { secureCookiesEnabled, sessionCookieName } from '@/lib/auth-cookies';

describe('secureCookiesEnabled', () => {
  it('keeps secure cookies for an https deployment', () => {
    expect(secureCookiesEnabled('https://sampolio.example.com')).toBe(true);
    expect(secureCookiesEnabled('https://sampolio-callback.tailnet.ts.net:8443')).toBe(true);
  });

  it('drops them only for an explicit http:// deployment', () => {
    // The add-on's own default: a plain-http LAN address.
    expect(secureCookiesEnabled('http://192.168.86.86:3999')).toBe(false);
    expect(secureCookiesEnabled('http://homeassistant.local:3999')).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['not a URL at all', 'sampolio.local'],
    ['a scheme we do not recognise', 'ftp://sampolio.local'],
  ])('fails safe when AUTH_URL is %s', (_label, value) => {
    // A misconfiguration must never quietly downgrade a deployment that does
    // terminate TLS — only an explicit http:// opts out.
    expect(secureCookiesEnabled(value)).toBe(true);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(secureCookiesEnabled('  HTTP://192.168.86.86:3999  ')).toBe(false);
    expect(secureCookiesEnabled('  HTTPS://example.com  ')).toBe(true);
  });

  it('is not fooled by https appearing later in the string', () => {
    expect(secureCookiesEnabled('http://example.com/?next=https://elsewhere')).toBe(false);
  });
});

describe('sessionCookieName', () => {
  it('pairs the __Secure- prefix with the Secure attribute, always', () => {
    // The prefix is only honoured by browsers alongside Secure; the two must
    // never be set independently.
    expect(sessionCookieName(true)).toBe('__Secure-authjs.session-token');
    expect(sessionCookieName(false)).toBe('authjs.session-token');
  });

  it('matches a name src/proxy.ts already recognises', async () => {
    // proxy.ts checks for the session cookie by name to decide whether to
    // bounce an unauthenticated visitor; a name it does not know would make
    // every signed-in user look signed out.
    const proxySource = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../proxy.ts', import.meta.url), 'utf8')
    );
    for (const secure of [true, false]) {
      expect(proxySource).toContain(`'${sessionCookieName(secure)}'`);
    }
  });
});
