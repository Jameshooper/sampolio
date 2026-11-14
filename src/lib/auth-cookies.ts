/**
 * Whether the session cookie carries the `Secure` attribute and the
 * `__Secure-` name prefix.
 *
 * Derived from the scheme in `AUTH_URL`, not from `NODE_ENV`. Browsers
 * discard a `__Secure-`-prefixed cookie that does not arrive over HTTPS, and
 * a bare LAN IP is not a trustworthy origin the way `localhost` is. A
 * container served as plain `http://<ip>:<port>` — which is what the Home
 * Assistant add-on looks like without a TLS front door — could therefore
 * create an account and then never stay signed in: the sign-in succeeds, the
 * cookie is dropped, and the browser lands back on the sign-in page with
 * nothing logged anywhere. Keying on the scheme the deployment actually
 * serves fixes that without weakening one that terminates TLS.
 *
 * Fail safe on purpose: only an explicit `http://` drops the secure cookie.
 * A missing, empty or malformed `AUTH_URL` keeps it, so a misconfiguration
 * can never silently downgrade a deployment that is served over HTTPS.
 *
 * The trade-off where it does apply: over plain HTTP the session cookie
 * travels in clear text and anything on that network segment can read it.
 * That is why the add-on docs push the Tailscale HTTPS front door first.
 */
export function secureCookiesEnabled(authUrl: string | undefined = process.env.AUTH_URL): boolean {
  return !(authUrl ?? '').trim().toLowerCase().startsWith('http://');
}

/**
 * The session cookie's name. The `__Secure-` prefix is only valid alongside
 * the `Secure` attribute, so the two always move together.
 */
export function sessionCookieName(secure: boolean = secureCookiesEnabled()): string {
  return secure ? '__Secure-authjs.session-token' : 'authjs.session-token';
}
