import type { NextConfig } from "next";

const securityHeaders = [
  // Prevent clickjacking
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
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
  // Force HTTPS (should be set by proxy, but also set here as fallback)
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
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
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
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
