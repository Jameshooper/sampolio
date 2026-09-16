# Sampolio — Operations (Infrastructure, Deploy, Backups, Secrets)

How the maintainer's production instance is deployed, exposed, backed up, and
configured. This is a **self-hosted, single-machine** setup: one macOS host runs
the app, serves it on the LAN through Caddy, and exposes it to the internet
through a Cloudflare Tunnel gated by Cloudflare Access (Zero Trust).

> **Public repo note:** this file deliberately contains **no secrets, account
> IDs, identity-provider IDs, tunnel UUIDs, or personal emails**. Those live only
> in the host's env file, the 0600 key file, and the Cloudflare dashboard.
> Placeholders like `<your-domain>` / `<team>` / `the allow-listed emails` stand
> in for account-specific values. Replace them if you reproduce this setup.

## Topology

```
                         ┌─────────────────────────── the internet ───────────────────────────┐
                         │                                                                      │
  Browser (cellular) ──▶ Cloudflare edge ──▶ Cloudflare Access (Zero Trust login gate)          │
                         │                        │  allow: the household emails                │
                         │                        ▼                                             │
                         │                   cloudflared "home" tunnel (outbound from the host) │
                         │                        │                                             │
  Browser (home LAN) ──▶ split-horizon DNS ──▶ Caddy (LAN, :443)  ──────────┐                   │
                                                                            ▼                   ▼
                                                            next start -p 3999  (launchd: com.sampolio.app)
                                                                            │  serves .next-prod
                                                                            ▼
                                                            ~/.sampolio/data  (encrypted JSON, AES-256-GCM)
```

- **From the LAN**, split-horizon DNS resolves `<your-domain>` to the Caddy host,
  so home traffic never leaves the network and never hits Cloudflare Access.
- **From the internet**, public DNS is a Cloudflare-proxied record; traffic enters
  the Cloudflare edge, is gated by Access, and is delivered to the host over the
  tunnel. There is **no inbound port forwarding** — the tunnel is outbound-only.

## 1. Application runtime (launchd)

- **Service:** launchd agent `com.sampolio.app`
  (`~/Library/LaunchAgents/com.sampolio.app.plist`, `KeepAlive` → auto-restarts on
  crash, starts at login).
- **Command:** `next start -p 3999` with **`NEXT_DIST_DIR=.next-prod`** so prod
  serves its own build dir, isolated from the dev preview's `.next`.
- **Working copy:** there is **one** git clone at `~/sampolio`. Deploying =
  rebuild `.next-prod` in place + restart the agent (no separate prod checkout).
- **Data:** `~/.sampolio/data` (per-user encrypted `.enc` files; see the DB layer
  docs). The app reads its secrets from the environment, not from disk.
- **Logs:** `~/.sampolio/logs/sampolio.log` and `sampolio-error.log`.
- **Env:** baked into the plist from `~/sampolio/.env` by
  `scripts/install-launchd.sh` (see §5). The plist embeds the resolved Node path
  (from `.nvmrc`) so boot doesn't depend on an interactive shell.

The Node version is pinned in `.nvmrc`; run prod tooling under that version (nvm).

## 2. Reverse proxy + DNS

- **Caddy** (on the LAN host) terminates TLS and reverse-proxies
  `https://<your-domain>` → `http://localhost:3999`.
- **Split-horizon DNS:** the LAN resolver points `<your-domain>` at the internal
  Caddy host; public DNS points it at Cloudflare (proxied). Same URL works at home
  (direct → Caddy) and away (→ Cloudflare Access → tunnel), which is why a login
  gate only ever appears from the internet.

## 3. Public exposure — Cloudflare Tunnel

- A single **cloudflared tunnel named `home`** serves several hostnames; Sampolio
  reuses it (one tunnel can serve many hostnames — no need for a per-app tunnel).
- Config: `~/.cloudflared/config.yml`. The Sampolio ingress rule maps
  `<your-domain>` → `http://localhost:3999`. Other hostnames on the same tunnel
  (e.g. Home Assistant, photos) are **not** gated by Access — gating is per-app
  in Cloudflare, see §4.

## 4. Access control — Cloudflare Access (Zero Trust)

The whole app is internet-reachable but **gated at the Cloudflare edge** by Access.
Auth happens before any request reaches the tunnel/host, in addition to the app's
own NextAuth login.

Two Access applications cover the one hostname:

| Application | Scope | Policy | Why |
|---|---|---|---|
| **Sampolio** | `<your-domain>` (whole app) | `allow` — the household's email addresses only | Gate the app to a small allow-list |
| **Sampolio bank callback (bypass)** | `<your-domain>/api/bank/callback` | `bypass` — everyone | The bank's PSD2/SCA consent redirect must land without an Access login. Still protected by the NextAuth session + a single-use CSRF `state` |

**Identity provider (login method):** **One-time PIN** (email code). The visitor
enters their email, Cloudflare emails a 6-digit code; the `allow` policy means
only the allow-listed addresses can complete login. No external IdP setup is
required, and OTP works for any email domain (iCloud, Gmail, …).

> A Zero Trust account with **no identity provider** shows *"There are no login
> methods available for this account"* on the login screen — that is the symptom
> of a missing IdP, not a code bug. Creating the One-time PIN IdP fixes it.

**Optional — Google login:** can be added as a second login method for one-click
sign-in, but it requires a Google OAuth client (client_id + secret) created in
Google Cloud Console and entered in the Zero Trust dashboard
(*Settings → Authentication → Login methods → Add → Google*). One-time PIN already
covers every allow-listed email, so Google is convenience only.

**Session length:** the Sampolio app's **session duration is `730h` (≈1 month)**
— Cloudflare's maximum. After one PIN login, a device's `CF_Authorization`
cookie stays valid for ~1 month before re-verifying. The cookie is per-browser and
server-set (so it isn't subject to Safari's 7-day script-cookie cap). A lost
device keeps access until expiry → revoke sessions if needed (§6).

## 5. Enable Banking secrets (bank sync)

Bank sync (read-only PSD2 AIS) hard-disables itself unless all three env vars are
present, so these are the only secrets the feature needs:

| Variable | What | Where |
|---|---|---|
| `ENABLE_BANKING_APP_ID` | Enable Banking application id (JWT `kid`) | `~/sampolio/.env` |
| `ENABLE_BANKING_REDIRECT_URL` | `https://<your-domain>/api/bank/callback` | `~/sampolio/.env` |
| `ENABLE_BANKING_PRIVATE_KEY_FILE` | Path to the RS256 **PKCS#8 PEM** | `~/.sampolio/enable_banking_private_key.pem` (chmod `0600`, **outside** the repo) |

These are baked into the launchd plist by `scripts/install-launchd.sh`. The app is
**production** (no `ENABLE_BANKING_BASE_URL` override). See
[`docs/bank-sync.md`](bank-sync.md) and the "Bank Sync" section of
[`AGENTS.md`](../AGENTS.md) for the feature itself.

## 6. Operations runbook

**Deploy** — snapshot the data dir first, then run `pnpm install --frozen-lockfile`
/ `lint` / `test` and build into `.next-prod`. Restart and health-check only once
every gate passes; never restart if any of them fails. `server-deploy.sh` (§7) is
the scripted form of this sequence.

- **Code-only deploy:** `launchctl kickstart -k gui/$(id -u)/com.sampolio.app`.
- **After changing plist env vars** (e.g. adding `ENABLE_BANKING_*` or
  `HA_WEBHOOK_URL` — see §9): `kickstart` reuses the loaded job and does **not**
  re-read the plist — do a **full reload** once:
  `launchctl bootout gui/$(id -u)/com.sampolio.app` then
  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sampolio.app.plist`.
  Until that reload the new variable is absent, so the feature it gates (bank
  sync, split notifications) stays hard-disabled and silently does nothing.
- **Health checks:** `curl -sS -o /dev/null -w '%{http_code}' http://localhost:3999/`
  (expect `307`); `launchctl list | grep com.sampolio.app`;
  `curl -skI https://<your-domain>/ | head -1` (expect `307`).

**Backups** — a daily snapshot runs via a launchd agent
(`com.example.sampolio_backup`) pointed at a backup script kept outside this repo:
a `tar.gz` of `~/.sampolio` (top-level `data/`), integrity-checked locally, then
copied to each backup target. Tarball the data dir before each deploy too
(`~/sampolio-data-backup-<timestamp>.tar.gz`). Never write to `~/.sampolio/data`
except read-only snapshots.

**Cloudflare Access changes** (login methods, allow-list, session length) are made
in the Cloudflare Zero Trust dashboard or via the API:
- Identity providers: `/accounts/{account_id}/access/identity_providers`
- App + policies: `/accounts/{account_id}/access/apps/{app_id}` and `…/policies`
- **Add an allowed user:** append their email to the "Sampolio" app's allow policy.
- **Revoke all sessions** (lost device): Zero Trust → *Access → revoke*, or the API.
- **Change session length:** the app's `session_duration` (max `730h`).

**Consent renewal** — Enable Banking consent is time-boxed; the app surfaces a
reconnect banner before expiry (Overview) and a Reconnect button in
*Settings → Accounts & Banking*.

## 7. Repo scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `server-deploy.sh` | Build in place from the git clone: pins Node from `.nvmrc`, `pnpm install`, builds into **`.next-prod`** (`NEXT_DIST_DIR`), so a parallel `next dev` (which uses `.next`) can never clobber what `next start` serves. Flags: `--pull` (ff-only pull first), `--run` (start foreground after build). This is the normal deploy path. |
| `install-launchd.sh` | Installs `com.sampolio.app` (`~/Library/LaunchAgents/`): resolves the Node binary from `.nvmrc` at install time and bakes it + the env from `~/sampolio/.env` into the plist, so boot doesn't depend on an interactive shell. Build with `server-deploy.sh` first. |
| `uninstall-launchd.sh` | Removes the launchd agent. |
| `run-sampolio.sh` | Starts the app in the foreground from the in-place build (dev/diagnostic use). |
| `reencrypt-data.mjs` | One-shot re-encryption of every `.enc` file into the fast **HKDF** key-derivation format (see §8). `--dry-run` supported. |
| `rotate-encryption-key.mjs` | Rotates the data set to a **new** `ENCRYPTION_KEY`: decrypts every `.enc` with `OLD_ENCRYPTION_KEY`, re-encrypts with the new key (see §8). `--dry-run` supported. |
| `generate-icons.mjs` | Regenerates the committed PWA PNG icon set from the master SVGs in `public/icons/` (uses `sharp`). Run after editing the SVGs. |
| `lib-node.sh` | Shared shell helpers (Node/nvm resolution) sourced by the other scripts. |

## 8. Encryption maintenance

All data files are AES-256-GCM with a per-file key derived from `ENCRYPTION_KEY`
via **HKDF-SHA256**; the read path falls back to the legacy PBKDF2 derivation for
old files (see `src/lib/db/encryption.ts` and `src/lib/db/AGENTS.md`).

**Re-encrypting to the fast format** — `node scripts/reencrypt-data.mjs [--dry-run]`
rewrites every `.enc` file under `DATA_DIR` (default `./data`; key from
`ENCRYPTION_KEY` env or `<DATA_DIR>/.encryption_key`) using HKDF. It is a
*performance* migration, not a correctness one: idempotent, atomic per file
(temp-write + rename), never deletes data. Take a backup first anyway. To run it
against production data, stop the app, back up, run with
`DATA_DIR=$HOME/.sampolio/data`, restart.

**Key rotation** — `OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new>
node scripts/rotate-encryption-key.mjs [--dry-run]` decrypts every `.enc` file
with the old key (HKDF with PBKDF2 fallback) and re-encrypts it with the new key
(HKDF). It refuses to run when the two keys are identical (that is
`reencrypt-data.mjs`'s job). Atomic per file, but a crash mid-run leaves the
tree mixed between keys — **stop the app and take a backup first**; re-running
with the same env resumes safely (already-rotated files are detected via the
new key and skipped). Afterwards update `<DATA_DIR>/.encryption_key` and reload
the launchd plist env (see §6 for the full-reload nuance).

**Missing `ENCRYPTION_KEY` is a hard failure in production**: the app throws on
the first data read/write instead of falling back to the publicly known dev
default key. In development the fallback (plus a console warning) remains.

## 9. Environment variable reference

Every variable the code reads (`grep -r "process.env" src scripts next.config.ts`):

| Variable | Required | Read in | Meaning |
|---|---|---|---|
| `ENCRYPTION_KEY` | yes | `db/encryption.ts`, `reencrypt-data.mjs`, `rotate-encryption-key.mjs` | AES-256-GCM master key for all `.enc` files. Prod value in `~/.sampolio/data/.encryption_key` (injected into the env by the plist/launch config — the app itself reads only the env). |
| `AUTH_SECRET` | yes | NextAuth (via env convention) | NextAuth session secret. |
| `AUTH_URL` | yes | NextAuth (env convention), `api/bank/callback/route.ts` | Canonical app URL (prod domain; `http://localhost:4999` for the dev preview). The bank-callback route reads it explicitly to build the external redirect base. |
| `DATA_DIR` | no (default `./data`) | `db/encryption.ts`, scripts | Root of the encrypted data tree. Prod: `~/.sampolio/data`. |
| `OLD_ENCRYPTION_KEY` | rotation only | `rotate-encryption-key.mjs` | The previous master key when rotating to a new `ENCRYPTION_KEY` (§8). Never read by the app. |
| `NEXT_DIST_DIR` | no (default `.next`) | `next.config.ts` | Build output dir; prod sets `.next-prod` to isolate from dev. |
| `DEV_AUTH_BYPASS` | dev only | `lib/auth.ts`, `app/dev-login/` | Email of an existing user; visiting `/dev-login` signs in as them without a password. Never set in prod. |
| `ENABLE_BANKING_APP_ID` | bank sync only | `lib/bank/*` | Enable Banking application id (JWT `kid`). All three `ENABLE_BANKING_*` must be present or the feature hard-disables. |
| `ENABLE_BANKING_REDIRECT_URL` | bank sync only | `lib/bank/*` | Consent callback URL (`https://<your-domain>/api/bank/callback`). |
| `ENABLE_BANKING_PRIVATE_KEY_FILE` | bank sync only | `lib/bank/jwt.ts` | Path to the 0600 RS256 PKCS#8 PEM (outside the repo). |
| `ENABLE_BANKING_BASE_URL` | no | `lib/bank/constants.ts` | API base override (sandbox); unset in prod. |
| `BANK_SYNC_VERBOSE` | no | `lib/bank/` | `1/true/yes` → verbose sync logging. |
| `HA_WEBHOOK_URL` | no | `lib/split-notify.ts` | Full Home Assistant webhook URL **including the secret webhook id** (e.g. `https://<ha-host>/api/webhook/<id>`) that split-activity notifications are POSTed to. Missing/blank ⇒ the feature hard-disables (zero network calls); `AUTH_URL` doubles as the deep-link base and must also be set. Never logged. |
| `NODE_ENV` / `NEXT_RUNTIME` | set by Next | various | Standard runtime flags (e.g. service-worker registration is production-only; the bank scheduler starts only on the Node runtime). |

## 10. Dev workflow against a copy of production data

Covered in detail in [`AGENTS.md`](../AGENTS.md) §"Testing With a Copy of
Production Data". Short version: `rsync -a ~/.sampolio/data/ ./data/` (one
direction only — never back), then the `sampolio-preview` config in
`.claude/launch.json` starts `next dev -p 4999` with the dot-file secrets
exported, `DATA_DIR=$PWD/data`, and `DEV_AUTH_BYPASS` enabled (`/dev-login`).
Port 3999 belongs to production (launchd `KeepAlive` restarts it if killed) —
never point a dev server at prod's port or data dir.

## 11. What is intentionally NOT in this repo

Kept out of version control (this is a public repo): the `.env` secrets, the PEM
key, the Cloudflare account/app/IdP IDs, the tunnel UUID, the Zero Trust team
domain, and the allow-listed personal emails. Real values live in `~/sampolio/.env`,
`~/.sampolio/`, and the Cloudflare dashboard. The daily backup script and its
launchd plist also live outside the repo.

## 12. Home Assistant add-on (alternative deployment)

The maintainer's own instance still runs exactly as described in §1–§11
(launchd + Caddy + Cloudflare Tunnel, no Docker). Independently of that, the
repo root also carries `Dockerfile`, `run.sh`, `config.yaml`, and
`repository.yaml` so the same app can be installed as a Home Assistant
Supervisor add-on (Settings → Add-ons → Add-on Store → ⋮ → Repositories →
add this repo's URL). Full install steps and the option reference are in
[`DOCS.md`](../DOCS.md); the short version:

- `run.sh` is the container entrypoint. When `/data/options.json` exists
  (Supervisor's convention for add-on options) it reads `auth_secret`,
  `encryption_key`, `auth_url`, the three `enable_banking_*` options, and
  `ha_webhook_url` from it and maps them onto the same env vars listed in §9;
  otherwise it reads those as plain env vars, so the same image also runs as
  a bare `docker run` (see the README's Docker Deployment section). Missing
  `auth_secret` / `encryption_key` / `auth_url` is a hard failure at
  container startup, matching the no-Docker path's behavior in §8.
- The add-on's persistent `/data` volume holds the app's encrypted data tree
  at `/data/sampolio` (`DATA_DIR`), plus the Enable Banking PEM (written from
  the `enable_banking_private_key` option) when bank sync is configured.
- The add-on is **Ingress-only** (`ingress: true`, no `ports`/`webui`) — only
  reachable through an authenticated Home Assistant session, which is the
  point: it's a real login/2FA gate the add-on otherwise has none of. That
  requires letting Supervisor frame it, so the Dockerfile sets
  `ALLOW_IFRAME_EMBED=true` (`next.config.ts`). Ingress serves the add-on
  from the HA frontend's own origin, so that **relaxes** `frame-ancestors`
  from `'none'` to `'self'` and drops only `X-Frame-Options`, which cannot
  express "same origin only" — third-party framing stays blocked.
  Reintroducing a direct port or a standalone Tailscale add-on's
  `svc:sampolio` Service alongside Ingress reopens a bypass around HA's
  login and defeats the point of using Ingress at all.
- **The add-on publishes port 3999; it does not use Ingress.** Ingress would
  put Home Assistant's own login and 2FA in front, but the app does not render
  under it (see [`known-gaps.md`](known-gaps.md) #4) — so on this port
  Sampolio's own NextAuth login is the only authentication. Keep the port off
  the public internet. `ALLOW_IFRAME_EMBED` is correspondingly **not** set in
  the `Dockerfile`, so `X-Frame-Options: DENY` and `frame-ancestors 'none'`
  apply; the cost is that Sampolio cannot be embedded in a Home Assistant
  iframe panel. Verified in a browser on the published port: sign-up, sign-in,
  client-side navigation across Cashflow/Goals/Split/Settings, and 390 px with
  no horizontal overflow, all with zero failed requests.
- The Ingress machinery below is retained but **currently unused**, because the
  proxy also sanitises `X-Forwarded-For` (see `ha-ingress-proxy.mjs`) and its
  rewriting is verified lossless. Ingress mounts the app at a path containing a token that **rotates every
  add-on restart** (`/api/hassio_ingress/<token>/`), which a static Next.js
  `basePath` can't track. Next.js/React also emit root-absolute asset and
  link paths (`/_next/...`, `<Link href="/settings">`, NextAuth's redirect
  `Location`) that a browser resolves against the domain root, not the
  current URL — so without correction they silently drop the ingress prefix
  and 404 against Home Assistant's own routing. `ha-ingress-proxy.mjs`
  fixes this: it sits in front of Next.js (which `run.sh` moves to an
  internal-only port, `NEXT_INTERNAL_PORT`) and rewrites those root-absolute
  references — HTML attributes, the same escaped inside React Server
  Components' streamed `<script>` payload, the `text/x-component` flight
  payload served on every client-side navigation, plain JSON in
  `manifest.webmanifest`, and redirect `Location` headers — using the
  current request's `X-Ingress-Path` header, which Supervisor sends fresh on
  every request. Requests with no `X-Ingress-Path` (direct access, or the
  Tailscale Funnel bank-callback path) pass through completely unmodified.
- `Location` rewriting covers three shapes: a root-absolute path, an
  absolute URL **on the same host** (NextAuth builds these), and an external
  URL, which is never touched — the bank's PSD2 consent redirect depends on
  that. It also prefixes the `callbackUrl` query parameter that `proxy.ts`
  attaches when sending an unauthenticated visitor to `/auth/signin`: the
  sign-in page hands that value to `router.push()`, a client-side navigation
  resolved against the origin root, so an un-prefixed value drops the user
  out of the add-on the moment they sign in successfully. A path that
  already carries the prefix is left alone.
- `src/test/ha-ingress-proxy.test.ts`, `src/test/run-sh.test.ts`, and
  `src/test/addon-manifest.test.ts` cover this runtime; the proxy exports its
  rewriting helpers and `createProxyServer()` for that reason and only binds
  a port when executed directly. `run.sh` reads `OPTIONS_FILE`,
  `TAILSCALE_STATE_DIR`, and `TAILSCALE_SOCKET` from the environment purely
  so those tests can redirect them; the defaults are the container paths.
- This is unrelated to `HA_WEBHOOK_URL` (§9), which is Sampolio *sending*
  Split activity notifications to Home Assistant, not Home Assistant running
  Sampolio.
- Two optional add-on options, `tailscale_auth_key` and `tailscale_funnel`,
  run an embedded `tailscaled` inside the add-on's own container (state in
  `/data/tailscale`, joins as device `sampolio-callback` — deliberately
  distinct from the standalone add-on's `svc:sampolio` Service) and
  optionally expose **only `/api/bank/callback`** to the public internet via
  Tailscale Funnel (`tailscale serve --set-path=/api/bank/callback` +
  `funnel 443 on`; nothing else is mapped, so the rest of the app stays
  tailnet-only even while Funnel is on) — see `DOCS.md` "Embedded Tailscale".
  Turning `tailscale_funnel` off does not merely skip the enable: `run.sh`
  runs `funnel 443 off` + `serve reset` on the next start, because both
  persist in tailscaled's state file and that state deliberately survives
  restarts — without the teardown the callback would stay published with no
  sign of it. Verify with `tailscale funnel status` after restarting.
  The Funnel path targets `127.0.0.1:$PORT` inside the container and never
  passes through Ingress, so it is unaffected by whether `config.yaml` uses
  `ingress:` or a published `ports:` entry.
  This exists for cases with no reverse proxy/tunnel at all, where a PSD2
  consent redirect (Enable Banking) needs a genuinely public callback URL; a
  tailnet-only Tailscale Services/Serve setup (a separate, standalone
  Tailscale add-on) isn't enough for that specific case. Off by default.
  `tailscaled` runs with `--tun=userspace-networking`, which is what keeps
  "expose only the callback" true: in normal TUN mode the container would
  get a tailnet IP and every port in it — including Next.js — would be
  reachable by any tailnet device with no HA login in front, from the auth
  key alone, funnel or not. Userspace mode also removes any need for
  `NET_ADMIN`/`NET_RAW` or `/dev/net/tun`, so `config.yaml` requests no
  capabilities and no devices.
- The Dockerfile sets `DISABLE_TLS_HEADERS=true`, which makes `next.config.ts`
  drop `Strict-Transport-Security` and the CSP's `upgrade-insecure-requests`.
  Both assume a TLS-terminating proxy in front (true for §1–§11's launchd +
  Caddy, never true for this plain-http container) — left on, the browser
  rewrites every asset request to a nonexistent https listener and the page
  never renders (blank white screen, no server-side error). Only the Docker
  build sets this; the non-Docker deploy path is unaffected.
