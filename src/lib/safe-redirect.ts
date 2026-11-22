/**
 * Post-login redirect target. Only same-origin relative paths are allowed, so a
 * crafted `/auth/signin?callbackUrl=https://evil.example` link can't bounce a
 * freshly signed-in user to another site.
 */
export function safeCallbackPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  const value = raw.trim();
  // Must be a single-slash absolute path; reject protocol-relative (`//host`),
  // backslash tricks (`/\host`, which browsers treat as `//host`) and control chars.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (value.includes('\\') || [...value].some((c) => c.charCodeAt(0) < 0x20)) return fallback;
  return value;
}
