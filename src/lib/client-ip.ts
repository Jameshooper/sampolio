/**
 * Client IP for rate limiting, login lockout and the bank PSU header.
 *
 * `X-Forwarded-For` is a list that each proxy appends to, so only the entries
 * added by proxies we control are trustworthy; the left-most entry is whatever
 * the client chose to send. `TRUSTED_PROXY_HOPS` says how many proxies sit in
 * front of the app (default 1: Caddy on the LAN and cloudflared both set the
 * header to the real peer). The client is the entry that many places from the
 * right.
 *
 * Set TRUSTED_PROXY_HOPS=0 when the app is reached directly (no proxy). The
 * header is then ignored and every client shares the `direct` bucket — strict,
 * but impossible to spoof.
 *
 * Edge-safe (no Node imports): used by src/proxy.ts as well as server code.
 */

const DIRECT = 'direct';

export function getTrustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/** The client address as seen by the outermost trusted proxy, or `direct`. */
export function getClientIp(headers: Pick<Headers, 'get'>): string {
  const hops = getTrustedProxyHops();
  if (hops === 0) return DIRECT;
  const chain = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length >= hops) {
    return chain[chain.length - hops];
  }
  // Fewer entries than trusted proxies: the request skipped a proxy (e.g. hit
  // the port directly on the LAN). Don't trust anything it says about itself.
  return DIRECT;
}
