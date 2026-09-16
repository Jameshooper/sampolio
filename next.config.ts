import type { NextConfig } from "next";

// Strict-Transport-Security and the CSP's upgrade-insecure-requests both tell
// the browser "this origin is TLS — rewrite every request to https://". That
// holds for the maintainer's own deployment (Caddy terminates TLS in front),
// but not for the Docker image (Dockerfile), which next start serves as
// plain http with no TLS of its own — including the Home Assistant add-on's
// direct-port setup. Forcing an https upgrade there makes every asset
// request 404 against a nonexistent TLS listener, silently blanking the
// page. The Dockerfile sets DISABLE_TLS_HEADERS=true so this build drops
// both; the non-Docker deploy path (server-deploy.sh/launchd) never sets it,
// so production is unaffected.
const forceHttps = process.env.DISABLE_TLS_HEADERS !== 'true';

// X-Frame-Options: DENY and the CSP's frame-ancestors 'none' block ANY
// framing — including Home Assistant's own Ingress, which embeds the add-on
// in an iframe inside the HA frontend. There's no static allowlist that
// works here: the HA frontend's own origin varies by how the browser reaches
// it (LAN IP, homeassistant.local, a Tailscale hostname, Nabu Casa's cloud
// domain), so frame-ancestors can't name it in advance. ALLOW_IFRAME_EMBED
// is set only by an add-on build with ingress: true in config.yaml, and only
// alongside dropping the add-on's own direct port — Ingress access is
// already gated by an authenticated HA session before Supervisor proxies the
// request through, so the framing check becomes redundant for that path,
// and there's no other browsable path left where it would have mattered.
const allowFraming = process.env.ALLOW_IFRAME_EMBED === 'true';

const securityHeaders = [
  // Prevent clickjacking — omitted when embedding is deliberately allowed
  // (Home Assistant Ingress). See allowFraming above.
  ...(allowFraming ? [] : [{
    key: 'X-Frame-Options',
    value: 'DENY',
  }]),
  // Prevent MIME type sniffing
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  // Control referrer information
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  // Prevent DNS prefetch to avoid leaking hostnames
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
  // Restrict browser features
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  // Force HTTPS (should be set by proxy, but also set here as fallback) —
  // only when this build actually sits behind TLS. See forceHttps above.
  ...(forceHttps ? [{
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  }] : []),
  // Content Security Policy
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Required for Next.js
      "worker-src 'self'", // Service worker (PWA)
      "style-src 'self' 'unsafe-inline'", // Required for PrimeReact
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      ...(allowFraming ? [] : ["frame-ancestors 'none'"]),
      "base-uri 'self'",
      "form-action 'self'",
      ...(forceHttps ? ["upgrade-insecure-requests"] : []),
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  // Deployed via `next start` from a git clone built in place (see scripts/).
  // We intentionally do NOT use `output: 'standalone'` — its dependency tracing
  // dropped @swc/helpers for this Next + pnpm combo, breaking the packaged server.

  // Isolate prod from dev builds. Prod (the launchd plist + deploy scripts) sets
  // NEXT_DIST_DIR=.next-prod, so `next build`/`next start` use `.next-prod`, while
  // the dev preview (`next dev`, no env) keeps `.next`. This stops a dev session
  // from clobbering the build that `next start` serves — without it, a reboot
  // after `next dev` would start prod against a dev build and fail (KeepAlive loop).
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Enable Next.js 16 Cache Components ("use cache" directive)
  cacheComponents: true,

  // Custom cache lifetime profiles
  cacheLife: {
    // Data never expires by time — only invalidated via updateTag or admin button
    indefinite: {
      stale: 31536000,    // 1 year
      revalidate: 31536000,
      expire: 31536000,   // 1 year (effectively indefinite)
    },
    // Background-synced data (bank balances/transactions, bank-sync anchor
    // snapshots). The bank scheduler writes to disk OUTSIDE any request scope,
    // so its `updateTag` invalidation is swallowed (see safeUpdateTags in
    // bank/sync.ts) and can never refresh the 'use cache' store. A short
    // revalidate window makes these reads eventually-consistent with disk so a
    // background sync shows up in the UI without a manual "Refresh now".
    // Request-scoped mutations still invalidate instantly via tags.
    synced: {
      stale: 60,
      revalidate: 300,    // catch up to disk within ~5 min
      expire: 3600,
    },
  },

  // Disable image optimization for self-hosted deployment
  images: {
    unoptimized: true,
  },

  // Server external packages for file system operations
  serverExternalPackages: ['bcryptjs'],

  experimental: {
    serverActions: {
      // The Settings data-import action receives a whole backup JSON in one
      // request; the 1 MB default is too small for a real data set.
      bodySizeLimit: '20mb',
    },
  },

  // Security headers for all routes
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // The service worker must not be HTTP-cached, or an old SW could persist
        // across deploys. Re-checked on every load; updates take effect immediately.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },

  // Disable x-powered-by header
  poweredByHeader: false,
};

export default nextConfig;
