/**
 * Tests for the Home Assistant Ingress rewriting proxy (ha-ingress-proxy.mjs
 * at the repo root — part of the add-on runtime, not the Next.js app).
 *
 * The proxy fronts the whole app under Ingress, so a defect here is a defect
 * on every request: broken asset paths, a leaked ingress prefix, or an
 * unvalidated header spliced into an href. The unit tests cover the rewriting
 * and validation logic; the integration tests run a real upstream and a real
 * proxy over loopback to cover header handling and streaming.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  rewriteBody,
  rewriteLocation,
  ingressPrefixOf,
  isRewritableType,
  createProxyServer,
} from '../../ha-ingress-proxy.mjs';

const PREFIX = '/api/hassio_ingress/TOKEN123';

describe('rewriteBody', () => {
  it('prefixes root-absolute HTML attributes', () => {
    const html = '<link href="/_next/static/a.css"/><script src="/_next/x.js"></script>';
    const out = rewriteBody(html, PREFIX);
    expect(out).toContain(`href="${PREFIX}/_next/static/a.css"`);
    expect(out).toContain(`src="${PREFIX}/_next/x.js"`);
  });

  it('prefixes in-app navigation links, not just assets', () => {
    // Next's <Link> renders a root-absolute href; without this the whole nav
    // breaks under Ingress even once assets load.
    expect(rewriteBody('<a href="/settings">S</a>', PREFIX)).toBe(
      `<a href="${PREFIX}/settings">S</a>`
    );
  });

  it('prefixes form action attributes', () => {
    expect(rewriteBody('<form action="/auth/signin">', PREFIX)).toContain(
      `action="${PREFIX}/auth/signin"`
    );
  });

  it('prefixes paths inside the escaped RSC script payload', () => {
    const rsc = String.raw`self.__next_f.push([1,"[\"$\",\"a\",null,{\"href\":\"/auth/signup\"}]"])`;
    const out = rewriteBody(rsc, PREFIX);
    expect(out).toContain(String.raw`\"href\":\"${PREFIX}/auth/signup\"`);
  });

  it('prefixes plain JSON fields (manifest.webmanifest)', () => {
    const manifest = '{"start_url":"/","icons":[{"src":"/icons/icon-192.png"}]}';
    const out = rewriteBody(manifest, PREFIX);
    expect(out).toContain(`"start_url":"${PREFIX}/"`);
    expect(out).toContain(`"src":"${PREFIX}/icons/icon-192.png"`);
  });

  it('prefixes CSS url() references in every quoting style', () => {
    // Fonts are reached this way. Observed in a browser: without it the woff2
    // files 404 against the Home Assistant origin and typography silently
    // falls back to system fonts.
    const css = '@font-face{src:url(/_next/static/media/a.woff2) format("woff2")}' +
      '.x{background:url("/icons/i.png")}.y{background:url(\'/icons/j.png\')}';
    const out = rewriteBody(css, PREFIX);
    expect(out).toContain(`url(${PREFIX}/_next/static/media/a.woff2)`);
    expect(out).toContain(`url("${PREFIX}/icons/i.png")`);
    expect(out).toContain(`url('${PREFIX}/icons/j.png')`);
  });

  it('leaves data: and cross-origin CSS urls alone', () => {
    const css = '.a{background:url(data:image/png;base64,AAA)}.b{src:url(//cdn.example/f.woff2)}';
    expect(rewriteBody(css, PREFIX)).toBe(css);
  });

  it('leaves protocol-relative URLs alone', () => {
    // //cdn.example/x is another host entirely — prefixing it would break it.
    const html = '<script src="//cdn.example.com/x.js"></script>';
    expect(rewriteBody(html, PREFIX)).toBe(html);
  });

  it('leaves absolute and relative URLs alone', () => {
    const html = '<a href="https://example.com/x">x</a><img src="rel/path.png"/>';
    expect(rewriteBody(html, PREFIX)).toBe(html);
  });

  it('does not double-prefix when applied to already-rewritten output', () => {
    const once = rewriteBody('<a href="/settings">S</a>', PREFIX);
    const twice = rewriteBody(once, PREFIX);
    expect(twice).toBe(once);
  });
});

describe('rewriteLocation', () => {
  const HOST = 'homeassistant.local:8123';

  it('prefixes a root-absolute redirect path', () => {
    expect(rewriteLocation('/auth/signin', PREFIX, HOST)).toBe(`${PREFIX}/auth/signin`);
  });

  it('prefixes the callbackUrl the sign-in page will router.push()', () => {
    // src/proxy.ts sets callbackUrl to the app-side path; the sign-in page
    // passes it to router.push(), a client-side navigation resolved against
    // the origin root. Un-prefixed, a successful login lands outside the
    // add-on — the very first thing a user does.
    const out = rewriteLocation('/auth/signin?callbackUrl=%2Fsettings', PREFIX, HOST);
    expect(out).toBe(`${PREFIX}/auth/signin?callbackUrl=${encodeURIComponent(`${PREFIX}/settings`)}`);
  });

  it('leaves a callbackUrl that is already prefixed alone', () => {
    const once = rewriteLocation('/auth/signin?callbackUrl=%2Fsettings', PREFIX, HOST);
    expect(rewriteLocation(once, PREFIX, HOST)).toBe(once);
  });

  it('leaves a malformed callbackUrl encoding exactly as sent', () => {
    const out = rewriteLocation('/auth/signin?callbackUrl=%E0%A4%A', PREFIX, HOST);
    expect(out).toBe(`${PREFIX}/auth/signin?callbackUrl=%E0%A4%A`);
  });

  it('leaves an absolute callbackUrl alone', () => {
    // Only same-origin relative targets get the mount point.
    const out = rewriteLocation('/auth/signin?callbackUrl=https%3A%2F%2Fevil.example', PREFIX, HOST);
    expect(out).toBe('/api/hassio_ingress/TOKEN123/auth/signin?callbackUrl=https%3A%2F%2Fevil.example');
  });

  it('prefixes an absolute redirect that points back at this same host', () => {
    // NextAuth builds absolute URLs for sign-out; they carry no ingress
    // prefix and would drop the user out of the add-on.
    expect(rewriteLocation(`http://${HOST}/auth/signin`, PREFIX, HOST)).toBe(
      `http://${HOST}${PREFIX}/auth/signin`
    );
  });

  it('never touches a redirect to another host', () => {
    // The bank's PSD2 consent page — rewriting it would break the SCA flow.
    expect(rewriteLocation('https://bank.example/consent?x=1', PREFIX, HOST)).toBe(
      'https://bank.example/consent?x=1'
    );
    expect(rewriteLocation('//evil.example/x', PREFIX, HOST)).toBe('//evil.example/x');
  });

  it('preserves the fragment on a same-host absolute redirect', () => {
    expect(rewriteLocation(`http://${HOST}/settings#cards`, PREFIX, HOST)).toBe(
      `http://${HOST}${PREFIX}/settings#cards`
    );
  });

  it('is a no-op without an ingress prefix', () => {
    expect(rewriteLocation('/auth/signin', undefined, HOST)).toBe('/auth/signin');
  });
});

describe('ingressPrefixOf', () => {
  const withHeader = (v: unknown) => ({ headers: { 'x-ingress-path': v } });

  it('accepts a normal Supervisor ingress path', () => {
    expect(ingressPrefixOf(withHeader(PREFIX))).toBe(PREFIX);
  });

  it('rejects a value containing a quote (attribute breakout)', () => {
    // Without this the value lands inside href="…" and can add an attribute.
    expect(ingressPrefixOf(withHeader('/x" onerror="alert(1)'))).toBeUndefined();
  });

  it.each([
    ['no leading slash', 'api/hassio_ingress/x'],
    ['a scheme', 'https://evil.example'],
    ['whitespace/CRLF', '/x\r\nX-Evil: 1'],
    ['angle brackets', '/x<script>'],
  ])('rejects %s', (_label, value) => {
    expect(ingressPrefixOf(withHeader(value))).toBeUndefined();
  });

  it('rejects a missing or non-string header', () => {
    expect(ingressPrefixOf({ headers: {} })).toBeUndefined();
    expect(ingressPrefixOf(withHeader(['/a', '/b']))).toBeUndefined();
  });

  it('rejects an over-long value', () => {
    expect(ingressPrefixOf(withHeader('/' + 'a'.repeat(300)))).toBeUndefined();
  });
});

describe('isRewritableType', () => {
  it('rewrites markup, manifest, flight and stylesheet types', () => {
    expect(isRewritableType('text/html; charset=utf-8')).toBe(true);
    expect(isRewritableType('application/manifest+json')).toBe(true);
    expect(isRewritableType('text/x-component')).toBe(true);
    expect(isRewritableType('text/css')).toBe(true);
  });

  it('leaves binary responses untouched', () => {
    // Buffering and rewriting an image would corrupt it.
    expect(isRewritableType('image/png')).toBe(false);
    expect(isRewritableType('font/woff2')).toBe(false);
    expect(isRewritableType('')).toBe(false);
  });
});

describe('proxy request/response handling (integration)', () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders = {};

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      lastUpstreamHeaders = req.headers;
      if (req.url === '/redirect') {
        res.writeHead(307, { Location: '/auth/signin?callbackUrl=%2F' });
        res.end();
        return;
      }
      if (req.url === '/external-redirect') {
        res.writeHead(302, { Location: 'https://bank.example/consent' });
        res.end();
        return;
      }
      if (req.url === '/rsc') {
        // The shape Next serves on a client-side navigation.
        res.writeHead(200, { 'content-type': 'text/x-component' });
        res.end('3:["$","link",null,{"href":"/_next/static/chunks/a.css"}]\n');
        return;
      }
      if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<a href="/settings">S</a>');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));

    proxy = createProxyServer({ upstreamPort: (upstream.address() as AddressInfo).port });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() })
        );
      });
      req.on('error', reject);
      req.end();
    });

  it('rewrites a root-relative redirect so it keeps the ingress prefix', async () => {
    // This is the first hop on every visit — if Location loses the prefix the
    // browser lands outside the ingress mount and 404s before anything loads.
    const res = await get('/redirect', { 'x-ingress-path': PREFIX });
    expect(res.headers.location).toBe(
      `${PREFIX}/auth/signin?callbackUrl=${encodeURIComponent(`${PREFIX}/`)}`
    );
  });

  it('rewrites the React Server Components navigation payload', async () => {
    // Verified against a real `next start`: every client-side navigation is
    // served as text/x-component. Skipping it means only the first page load
    // works and every link click afterwards 404s against Home Assistant.
    const res = await get('/rsc', { 'x-ingress-path': PREFIX });
    expect(res.headers['content-type']).toContain('text/x-component');
    expect(res.body).toContain(`"href":"${PREFIX}/_next/static/chunks/a.css"`);
  });

  it('leaves an absolute redirect to another host untouched', async () => {
    // The bank consent redirect must not be rewritten into a local path.
    const res = await get('/external-redirect', { 'x-ingress-path': PREFIX });
    expect(res.headers.location).toBe('https://bank.example/consent');
  });

  it('rewrites HTML bodies when an ingress prefix is present', async () => {
    const res = await get('/page', { 'x-ingress-path': PREFIX });
    expect(res.body).toBe(`<a href="${PREFIX}/settings">S</a>`);
  });

  it('passes everything through untouched without an ingress header', async () => {
    // The Tailscale Funnel bank-callback path reaches the proxy this way.
    const res = await get('/page');
    expect(res.body).toBe('<a href="/settings">S</a>');
    const redirect = await get('/redirect');
    expect(redirect.headers.location).toBe('/auth/signin?callbackUrl=%2F');
    const rsc = await get('/rsc');
    expect(rsc.body).toContain('"href":"/_next/static/chunks/a.css"');
  });

  it('does not rewrite when the ingress header is malformed', async () => {
    const res = await get('/page', { 'x-ingress-path': '/x" onerror="alert(1)' });
    expect(res.body).toBe('<a href="/settings">S</a>');
    expect(res.body).not.toContain('onerror');
  });

  it('passes binary responses through unmodified', async () => {
    const res = await get('/binary', { 'x-ingress-path': PREFIX });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body, 'binary').length).toBeGreaterThan(0);
  });

  it('replaces caller-supplied forwarding headers', async () => {
    // src/proxy.ts keys rate limiting on X-Forwarded-For's first entry, and
    // the bank client sends it on as the PSD2 PSU-IP attribute, so a
    // spoofable value is a forged client identity.
    await get('/page', { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'evil.example' });
    expect(lastUpstreamHeaders['x-forwarded-for']).toBe('127.0.0.1');
    expect(lastUpstreamHeaders['x-forwarded-host']).toBeUndefined();
  });

  it('cannot be tricked out of sanitising by a forged X-Ingress-Path', async () => {
    // The sanitisation used to be skipped whenever this header was present,
    // on the premise that only Supervisor sends it. Nothing legitimate sends
    // it now, and the port is directly reachable, so that premise made the
    // whole control one forged header away from off.
    await get('/page', { 'x-ingress-path': PREFIX, 'x-forwarded-for': '203.0.113.9' });
    expect(lastUpstreamHeaders['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('never forwards the ingress header upstream', async () => {
    await get('/page', { 'x-ingress-path': PREFIX });
    expect(lastUpstreamHeaders['x-ingress-path']).toBeUndefined();
  });

  it('strips accept-encoding so rewriting never sees gzip', async () => {
    await get('/page', { 'x-ingress-path': PREFIX, 'accept-encoding': 'gzip' });
    expect(lastUpstreamHeaders['accept-encoding']).toBeUndefined();
  });

  it('returns 502 rather than hanging when upstream is unreachable', async () => {
    const orphan = createProxyServer({ upstreamPort: 1 });
    await new Promise<void>((r) => orphan.listen(0, '127.0.0.1', r));
    const port = (orphan.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(502);
    await new Promise<void>((r) => orphan.close(() => r()));
  });
});
