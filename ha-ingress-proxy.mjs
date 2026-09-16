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

function rewriteBody(body, prefix) {
  let out = body.replace(ATTR_RE, (_m, attr, path) => `${attr}="${prefix}${path}"`);
  out = out.replace(JSON_RE, (_m, attr, path) => `"${attr}":"${prefix}${path}"`);
  out = out.replace(ATTR_ESCAPED_RE, (_m, attr, path) => `\\"${attr}\\":\\"${prefix}${path}\\"`);
  return out;
}

export function waitForPort(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  });
}

function startServer() {
  const server = http.createServer((req, res) => {
    const ingressPrefix = req.headers['x-ingress-path'];

    const headers = { ...req.headers };
    // Force plain-text upstream responses so string rewriting never has to
    // touch gzip — this is a loopback hop, compression cost is irrelevant.
    delete headers['accept-encoding'];

    const upstreamReq = http.request(
      { hostname: '127.0.0.1', port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        const contentType = upstreamRes.headers['content-type'] || '';
        const location = upstreamRes.headers.location;
        const rewriteLocation = Boolean(ingressPrefix) && Boolean(location) && location.startsWith('/') && !location.startsWith('//');
        const rewriteBodyContent = Boolean(ingressPrefix) && REWRITABLE_TYPES.some((t) => contentType.includes(t));

        const outHeaders = { ...upstreamRes.headers };
        if (rewriteLocation) outHeaders.location = `${ingressPrefix}${location}`;

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

  server.listen(LISTEN_PORT, '0.0.0.0', () => {
    console.log(`[ingress-proxy] listening on ${LISTEN_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
  });
}

startServer();
