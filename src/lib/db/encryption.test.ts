import * as crypto from 'crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { encrypt, decrypt } from './encryption';

// Format + KDF constants — must mirror encryption.ts. The legacy helper below
// reproduces the pre-migration PBKDF2 format so we can prove old files still
// decrypt through the backward-compatible read path.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;
const HKDF_INFO = Buffer.from('sampolio-file-encryption-v1');

const KEY = 'test-encryption-key-0123456789abcdef0123456789abcdef';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

/** Encrypt exactly the way the app did before the HKDF migration (PBKDF2). */
function legacyEncrypt(password: string, data: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha512');
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

function parse(blob: string) {
  const combined = Buffer.from(blob, 'base64');
  return {
    salt: combined.subarray(0, SALT_LENGTH),
    iv: combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH),
    tag: combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
    ct: combined.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH),
  };
}

describe('encryption', () => {
  it('round-trips through the HKDF fast path', () => {
    const payload = JSON.stringify({ hello: 'world', n: 42, nested: [1, 2, 3] });
    expect(decrypt(encrypt(payload))).toBe(payload);
  });

  it('produces distinct ciphertext for identical plaintext (per-file salt)', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('same');
    expect(decrypt(b)).toBe('same');
  });

  it('still decrypts legacy PBKDF2-format files (backward compatible)', () => {
    const payload = 'legacy secret €1234,56';
    const legacyBlob = legacyEncrypt(KEY, payload);
    expect(decrypt(legacyBlob)).toBe(payload);
  });

  it('new files genuinely use HKDF, not PBKDF2 (fast path is primary)', () => {
    const blob = encrypt('fast-path');
    const { salt, iv, tag, ct } = parse(blob);

    // HKDF key decrypts it...
    const hkdfKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(KEY, 'utf8'), salt, HKDF_INFO, KEY_LENGTH));
    const d = crypto.createDecipheriv(ALGORITHM, hkdfKey, iv);
    d.setAuthTag(tag);
    expect(Buffer.concat([d.update(ct), d.final()]).toString('utf8')).toBe('fast-path');

    // ...but the legacy PBKDF2 key for the same salt does NOT — proving the new
    // blob is HKDF-derived and the PBKDF2 branch is only ever a fallback.
    const pbkdf2Key = crypto.pbkdf2Sync(KEY, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    const d2 = crypto.createDecipheriv(ALGORITHM, pbkdf2Key, iv);
    d2.setAuthTag(tag);
    expect(() => Buffer.concat([d2.update(ct), d2.final()])).toThrow();
  });
});
