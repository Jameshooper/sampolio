/**
 * Enable Banking — cached ASPSP (bank) capability lookups.
 *
 * `GET /aspsps` is an Enable Banking-side listing (no ASPSP rate allowance is
 * spent calling it), but the connect flow calls it on every "begin connection"
 * / "begin reconnect" plus the bank picker, so a short in-memory TTL cache per
 * country avoids redundant round trips within a burst of activity. Failure is
 * always graceful (`null`) — every caller must degrade to its own default
 * (fallback consent validity, no PSU-header logging) rather than break the
 * connect flow. This is a plain server module (not 'use server') — it exposes
 * no client-invokable endpoints, only helpers other server-only modules import.
 *
 * Never log the raw aspsps payload — it's not sensitive, but there's no
 * reason to dump a whole country's bank list into the logs either.
 */

import { getAspsps } from './client';
import { mapAspspDetails, type AspspDetails } from './mappers';
import { ASPSP_INFO_CACHE_TTL_MS } from './constants';

interface CacheEntry {
  details: AspspDetails[];
  fetchedAt: number;
}

// Module-level in-memory cache, keyed by uppercased ISO country code.
const cache = new Map<string, CacheEntry>();

/**
 * The ASPSP capability list for a country, from cache when fresh. Returns
 * `null` on ANY failure (network, malformed response, etc.) — never throws,
 * and a failed lookup is never cached (so the next call retries immediately).
 */
export async function getAspspDetailsCached(country: string): Promise<AspspDetails[] | null> {
  const key = country.trim().toUpperCase();
  if (!key) return null;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < ASPSP_INFO_CACHE_TTL_MS) {
    return cached.details;
  }

  try {
    const raw = await getAspsps(key);
    const details = mapAspspDetails(raw);
    cache.set(key, { details, fetchedAt: Date.now() });
    return details;
  } catch {
    // Best-effort only — callers fall back to their own defaults.
    return null;
  }
}

/** Case-insensitive exact-name lookup within a country's ASPSP list. */
export async function findAspspInfo(name: string, country: string): Promise<AspspDetails | null> {
  const details = await getAspspDetailsCached(country);
  if (!details) return null;
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return details.find((a) => a.name.trim().toLowerCase() === needle) ?? null;
}

/** Test-only: clear the cache so each test starts from a clean slate. */
export function resetAspspInfoCache(): void {
  cache.clear();
}
