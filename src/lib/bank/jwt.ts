/**
 * Enable Banking — Layer A app token (fully automatic, invisible to the user).
 *
 * Mints an RS256 JWT signed with the app's private key (a 0600 PEM outside the
 * repo). The token is memory-cached and re-minted shortly before expiry, so a
 * single token is reused across requests (minimizing churn). The private key is
 * loaded once and kept only in memory by `jose` — never logged, never persisted.
 */

import * as fs from 'fs/promises';
import { SignJWT, importPKCS8 } from 'jose';

/** jose v6 returns a CryptoKey/KeyObject from importPKCS8; infer it. */
type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;
import {
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_TTL_SECONDS,
  JWT_REMINT_SKEW_SECONDS,
  getBankConfig,
} from './constants';

interface CachedToken {
  token: string;
  expiresAtMs: number; // absolute expiry of the minted token
  keyFile: string; // which key file produced it (re-mint if config changes)
  appId: string;
}

let cached: CachedToken | null = null;
let cachedKey: { file: string; key: SigningKey } | null = null;

async function loadPrivateKey(keyFile: string): Promise<SigningKey> {
  if (cachedKey && cachedKey.file === keyFile) return cachedKey.key;
  const pem = await fs.readFile(keyFile, 'utf8');
  const key = await importPKCS8(pem, 'RS256');
  cachedKey = { file: keyFile, key };
  return key;
}

/**
 * Return a valid app JWT, minting a fresh one only when none is cached or the
 * cached one is within the re-mint skew of expiry.
 */
export async function getAppToken(now: number = Date.now()): Promise<string> {
  const config = getBankConfig();
  if (!config) {
    throw new Error('Enable Banking is not configured (missing secrets)');
  }

  const skewMs = JWT_REMINT_SKEW_SECONDS * 1000;
  if (
    cached &&
    cached.appId === config.appId &&
    cached.keyFile === config.privateKeyFile &&
    cached.expiresAtMs - skewMs > now
  ) {
    return cached.token;
  }

  const key = await loadPrivateKey(config.privateKeyFile);
  const iat = Math.floor(now / 1000);
  const exp = iat + JWT_TTL_SECONDS;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: config.appId, typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);

  cached = {
    token,
    expiresAtMs: exp * 1000,
    keyFile: config.privateKeyFile,
    appId: config.appId,
  };
  return token;
}

/** Test/maintenance hook: drop the in-memory token + key caches. */
export function resetAppTokenCache(): void {
  cached = null;
  cachedKey = null;
}
