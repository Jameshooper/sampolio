import type { MetadataRoute } from 'next';

// Web App Manifest, served at /manifest.webmanifest and auto-linked by Next.
// Kept fully static (no request-time data) so it prerenders under
// `cacheComponents`. The middleware matcher (src/proxy.ts) exempts this path
// so the install screen can fetch it without an auth redirect.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sampolio — Personal Finance Planner',
    short_name: 'Sampolio',
    description:
      'A personal finance planning tool that replaces your budgeting spreadsheet with a cleaner, more powerful workflow.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F3F6F4',
    theme_color: '#2F6B4F',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
