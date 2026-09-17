#!/usr/bin/env node
// Home Assistant Ingress rewriting proxy.
//
// Supervisor already strips its own ingress-token path prefix before
// forwarding requests to this container — confirmed via a direct proxy
// test: this app receives plain paths like "/", not
// "/api/hassio_ingress/<token>/" — and it tells us the CURRENT prefix via
// the X-Ingress-Path request header on every request. The problem is
// entirely on the way OUT: Next.js/React emit root-absolute paths
// ("/_next/...", <Link href="/settings">, NextAuth's redirect Location),
// both as plain HTML attributes and, for React Server Components, as
// escaped JSON strings inside inline <script> tags. A root-absolute path
// is always resolved by the browser against the origin, not the current
// URL, so without rewriting, every such reference silently drops the
// ingress prefix and 404s against Home Assistant's own routing instead of
// reaching this app. The ingress token also rotates on every add-on
// restart, which rules out a normal static Next.js `basePath` (a single
// build-time string) as a fix.
//
// This proxy sits in front of the real Next.js server (which moves to an
// internal-only port, see run.sh) and rewrites root-absolute references in
// HTML/JS/manifest responses — and redirect Location headers — to include
// the current request's ingress prefix, read fresh each time. Requests
// without X-Ingress-Path (direct access, or the Tailscale Funnel bank
// callback path, which bypasses Ingress entirely) pass through completely
// unmodified.
import http from 'node:http';
import net from 'node:net';

const LISTEN_PORT = Number(process.env.PROXY_PORT || '3999');
const UPSTREAM_PORT = Number(process.env.NEXT_INTERNAL_PORT || '3998');

const REWRITABLE_TYPES = [
  'text/html',
  'application/manifest+json',
  'application/javascript',
  'text/javascript',
  // React Server Components' flight payload, served on every client-side
  // navigation (a <Link> click, router.push). Its own root-absolute link and
  // chunk references need the same treatment as the initial HTML document's —
  // without it only the first page load works and every navigation after it
  // resolves against the Home Assistant origin root instead of the add-on.
  'text/x-component',
  // Stylesheets reference fonts and images as url(/_next/static/media/...).
  // Confirmed in a browser driven through a mock Supervisor: without this the
  // woff2 files 404 against the Home Assistant origin and the app silently
  // falls back to system fonts.
  'text/css',
];

// Plain HTML: href="/foo", src="/foo", action="/foo" — never "//foo", which
// is protocol-relative to a different host, not this app.
const ATTR_RE = /\b(href|src|action)="(\/(?!\/)[^"]*)"/g;
// The same, JSON-escaped inside a <script> tag's string literal (React
// Server Components' streamed payload uses this form for most links).
const ATTR_ESCAPED_RE = /\\"(href|src|action)\\":\\"(\/(?!\/)[^"\\]*)\\"/g;
// Plain JSON (colon, not equals) — manifest.webmanifest's own start_url and
// icon src fields, served as a standalone JSON document rather than
// embedded in HTML/JS.
const JSON_RE = /"(href|src|action|start_url)":"(\/(?!\/)[^"]*)"/g;
// React Server Components preload hints: HL["/_next/static/media/x.woff2",
// "font"] — a bare string in an array, matching none of the key-based patterns
// above. Appears escaped inside the HTML's inline flight payload and plain in
// a text/x-component response. Found with a browser: the two preloaded woff2
// files were the only things still escaping the mount.
const FLIGHT_HINT_RE = /\bHL\["(\/(?!\/)[^"]*)"/g;
const FLIGHT_HINT_ESCAPED_RE = /\bHL\[\\"(\/(?!\/)[^"\\]*)\\"/g;
// CSS url(...) — bare, single- or double-quoted. Also catches inline <style>
// blocks in the HTML document, which go through the same rewriter.
const CSS_URL_RE = /url\(\s*(['"]?)(\/(?!\/)[^'")]*)\1\s*\)/g;

// A path that already carries the prefix must be left alone. Responses are
// rewritten once each, so this is not about repeated passes: the app itself
// can emit an already-prefixed path, because after hydration the client's
// props hold rewritten values and it echoes them back (a callbackUrl taken
// from the current location, a redirect built from a referring path). Adding
// the prefix a second time produces a dead URL that 404s.
const alreadyPrefixed = (path, prefix) =>
  path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);

export function rewriteBody(body, prefix) {
  const apply = (path) => (alreadyPrefixed(path, prefix) ? path : `${prefix}${path}`);
  let out = body.replace(ATTR_RE, (_m, attr, path) => `${attr}="${apply(path)}"`);
  out = out.replace(JSON_RE, (_m, attr, path) => `"${attr}":"${apply(path)}"`);
  out = out.replace(ATTR_ESCAPED_RE, (_m, attr, path) => `\\"${attr}\\":\\"${apply(path)}\\"`);
  out = out.replace(CSS_URL_RE, (_m, quote, path) => `url(${quote}${apply(path)}${quote})`);
  out = out.replace(FLIGHT_HINT_RE, (_m, path) => `HL["${apply(path)}"`);
  out = out.replace(FLIGHT_HINT_ESCAPED_RE, (_m, path) => `HL[\\"${apply(path)}\\"`);
  return out;
}

// A redirect target can reach us in three shapes, and only the first two
// belong to this app: a root-absolute path ("/auth/signin"), an absolute URL
// on this same host (NextAuth builds these for sign-out), and an external URL
// (the bank's consent page) which must never be touched.
//
// The query string needs the same care as the path. src/proxy.ts sends
// unauthenticated visitors to /auth/signin?callbackUrl=<path>, and the sign-in
// page hands that value straight to router.push() — a client-side navigation,
// which resolves against the origin root, not the ingress mount. Left alone it
// takes the user out of the add-on the moment they successfully sign in.
const CALLBACK_PARAM_RE = /([?&]callbackUrl=)([^&]*)/g;

function prefixCallbackParam(search, prefix) {
  return search.replace(CALLBACK_PARAM_RE, (whole, lead, value) => {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return whole; // malformed percent-encoding — leave it exactly as sent
    }
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return whole;
    if (alreadyPrefixed(decoded, prefix)) return whole;
    return `${lead}${encodeURIComponent(prefix + decoded)}`;
  });
}

function prefixPathAndQuery(pathWithQuery, prefix) {
  const q = pathWithQuery.indexOf('?');
  const path = q === -1 ? pathWithQuery : pathWithQuery.slice(0, q);
  const search = q === -1 ? '' : prefixCallbackParam(pathWithQuery.slice(q), prefix);
  return (alreadyPrefixed(path, prefix) ? path : `${prefix}${path}`) + search;
}

export function rewriteLocation(location, prefix, host) {
  if (!location || !prefix) return location;

  // Absolute or protocol-relative: rewrite only if it points back at us.
  if (location.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location)) {
    if (!host) return location;
    let url;
    try {
      url = new URL(location, `http://${host}`);
    } catch {
      return location;
    }
    if (url.host !== host) return location; // another host entirely — hands off
    return `${url.protocol}//${url.host}${prefixPathAndQuery(url.pathname + url.search, prefix)}${url.hash}`;
  }

  if (!location.startsWith('/')) return location; // relative — already correct
  return prefixPathAndQuery(location, prefix);
}

// Next also preloads fonts through a `Link:` RESPONSE HEADER
// (</_next/static/media/x.woff2>; rel=preload; as="font"), not just markup.
// Found with a browser: this was the last thing still escaping the mount
// after every body-level pattern was covered.
const LINK_TARGET_RE = /<(\/(?!\/)[^>]*)>/g;

export function rewriteLinkHeader(value, prefix) {
  if (!value || !prefix) return value;
  const one = (v) =>
    v.replace(LINK_TARGET_RE, (whole, path) =>
      alreadyPrefixed(path, prefix) ? whole : `<${prefix}${path}>`
    );
  return Array.isArray(value) ? value.map(one) : one(value);
}

export function isRewritableType(contentType) {
  return REWRITABLE_TYPES.some((t) => (contentType || '').includes(t));
}

export function waitForPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  });
}

// Supervisor's own ingress prefix is always a plain absolute path. Anything
// else is either malformed or a client trying to steer what we splice into
// response bodies and Location headers — an unvalidated value containing a
// quote would break out of the href="…" we build. Only requests that reach
// this port directly (another add-on container) can attempt it, and they
// would only poison their own response, but validating is nearly free.
const INGRESS_PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;

export function ingressPrefixOf(req) {
  const raw = req.headers['x-ingress-path'];
  if (typeof raw !== 'string' || raw.length > 256) return undefined;
  return INGRESS_PATH_RE.test(raw) ? raw : undefined;
}

export function createProxyServer({ upstreamPort = UPSTREAM_PORT } = {}) {
  const server = http.createServer((req, res) => {
    const ingressPrefix = ingressPrefixOf(req);

    const headers = { ...req.headers };
    // Force plain-text upstream responses so string rewriting never has to
    // touch gzip — this is a loopback hop, compression cost is irrelevant.
    delete headers['accept-encoding'];
    // src/proxy.ts derives its rate-limit key from X-Forwarded-For's first
    // entry, so a caller that can set that header freely can reset its own
    // auth-attempt budget at will. Requests arriving through Ingress carry
    // Supervisor's own forwarding headers and a valid ingress prefix — keep
    // those, they hold the real client IP. Anything else reached this port
    // outside Ingress (the Funnel-published callback path, or another
    // container on the add-on network) and does not get to name its own IP.
    // Unconditionally, and never keyed on X-Ingress-Path. An earlier version
    // kept the caller's forwarding headers when that header was present, on
    // the theory that only Supervisor sends it. The add-on no longer uses
    // Ingress, so nothing legitimate sends it at all — while the port is
    // directly reachable, which made the whole sanitisation one forged
    // `X-Ingress-Path: /x` away from being skipped. Trust here has to rest on
    // the peer address, which a client cannot choose, not on a header it can.
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    const peer = req.socket.remoteAddress;
    if (peer) headers['x-forwarded-for'] = peer;
    else delete headers['x-forwarded-for'];
    // The app never reads this; only this proxy does. Don't pass a
    // client-controlled value through to it.
    delete headers['x-ingress-path'];

    const upstreamReq = http.request(
      { hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        const contentType = upstreamRes.headers['content-type'] || '';
        const location = upstreamRes.headers.location;
        const rewriteBodyContent = Boolean(ingressPrefix) && REWRITABLE_TYPES.some((t) => contentType.includes(t));

        const outHeaders = { ...upstreamRes.headers };
        if (ingressPrefix && location) {
          outHeaders.location = rewriteLocation(location, ingressPrefix, req.headers.host);
        }
        if (ingressPrefix && outHeaders.link) {
          outHeaders.link = rewriteLinkHeader(outHeaders.link, ingressPrefix);
        }

        if (!rewriteBodyContent) {
          res.writeHead(upstreamRes.statusCode, outHeaders);
          upstreamRes.pipe(res);
          return;
        }

        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          const rewritten = rewriteBody(Buffer.concat(chunks).toString('utf8'), ingressPrefix);
          delete outHeaders['content-length'];
          res.writeHead(upstreamRes.statusCode, outHeaders);
          res.end(rewritten);
        });
      }
    );

    upstreamReq.on('error', (err) => {
      console.error('[ingress-proxy] upstream error:', err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end('Upstream error');
    });

    req.pipe(upstreamReq);
  });

  return server;
}

export function startServer() {
  const server = createProxyServer();
  server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[ingress-proxy] listening on ${LISTEN_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
  });
  return server;
}

// Only bind a port when run as the entrypoint (run.sh execs this file).
// Importing it — as the test suite does — must have no side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
