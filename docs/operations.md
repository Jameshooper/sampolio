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
- **Command:** `next start -p 3999 -H 127.0.0.1` with **`NEXT_DIST_DIR=.next-prod`** so prod
  serves its own build dir, isolated from the dev preview's `.next`. The loopback bind
  (`SAMPOLIO_HOST`, default `127.0.0.1`) means only Caddy and cloudflared on the same host
  reach the app, so nobody can bypass them and forge the `X-Forwarded-For` the rate
  limiter trusts. Re-run `install-launchd.sh` after upgrading to apply it to the plist.
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

These are baked into the launchd plist by `scripts/install-launchd.sh`, which writes the
plist `0600` (it also embeds `AUTH_SECRET` and `ENCRYPTION_KEY`). At token mint time
`src/lib/bank/jwt.ts` warns if the PEM is readable by group/others. The app is
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

**Keep the key out of data backups.** The launch scripts resolve secrets via
`scripts/lib-secrets.sh`: env (`.env`) → `~/.sampolio/secrets/{auth_secret,encryption_key}`
(override with `SAMPOLIO_SECRETS_DIR`) → the legacy `<DATA_DIR>/.auth_secret` /
`.encryption_key`. New installs generate into the secrets directory (`0700`/`0600`);
an existing legacy key keeps working, with a start-up note. To migrate: stop the app,
`mkdir -m 700 ~/.sampolio/secrets && mv ~/.sampolio/data/.encryption_key ~/.sampolio/secrets/encryption_key`
(same for `.auth_secret` → `auth_secret`), make sure the external backup script backs up
`data/` but **not** `secrets/`, store a copy of the key somewhere separate (password
manager), then re-run `install-launchd.sh`. The scripts refuse to generate a new
`ENCRYPTION_KEY` when `.enc` files already exist, so a lost key fails loudly instead
of silently producing an unreadable data set.

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
| `reencrypt-data.mjs` | Re-encrypts every `.enc` file into the current format **v2** (path-bound) with the same key (see §8). `--dry-run` supported. |
| `rotate-encryption-key.mjs` | Rotates the data set to a **new** `ENCRYPTION_KEY`: decrypts every `.enc` (any format) with `OLD_ENCRYPTION_KEY`, re-encrypts with the new key as v2 (see §8). `--dry-run` supported. |
| `lib-file-crypto.mjs` | The encrypted-file formats for the two scripts above (kept byte-compatible with `src/lib/db/encryption.ts` by `file-format-v2.test.ts`) and their key resolution (env → `~/.sampolio/secrets/encryption_key` → `<DATA_DIR>/.encryption_key`). |
| `generate-icons.mjs` | Regenerates the committed PWA PNG icon set from the master SVGs in `public/icons/` (uses `sharp`). Run after editing the SVGs. |
| `lib-node.sh` | Shared shell helpers (Node/nvm resolution) sourced by the other scripts. |
| `lib-secrets.sh` | `sampolio_load_secrets <data_dir>`: resolves `AUTH_SECRET` / `ENCRYPTION_KEY` (env → secrets dir → legacy data-dir files), generates missing ones with `umask 077`, never generates a key over existing encrypted data (§6). Sourced by `run-sampolio.sh` and `install-launchd.sh`. |

## 8. Encryption maintenance

All data files are AES-256-GCM with a per-file key derived from `ENCRYPTION_KEY`
via **HKDF-SHA256**. Every write uses **format v2**, which also binds the file to its
path under `DATA_DIR`, so an encrypted file copied over another one no longer decrypts.
Older **v1** files (HKDF, or the legacy PBKDF2 derivation) remain readable and upgrade on
their next write. Details: `src/lib/db/encryption.ts`, `src/lib/db/AGENTS.md`.

**Upgrading a data set to v2** (once, after deploying a v2-capable build — 4.0.0+):

1. Stop the app and take a backup of `~/.sampolio/data`.
2. `DATA_DIR=$HOME/.sampolio/data node scripts/reencrypt-data.mjs --dry-run` — check
   `failed: 0`, then run it without `--dry-run`. It is idempotent and atomic per file
   (0600 temp file + fsync + rename) and never deletes data. Key resolution matches the
   launch scripts (env → `~/.sampolio/secrets/encryption_key` → `<DATA_DIR>/.encryption_key`).
3. Add `ENCRYPTION_REQUIRE_PATH_BINDING=true` to `~/sampolio/.env` and re-run
   `install-launchd.sh`, so the app refuses any v1 file from now on (an old backup file or a
   planted one can no longer be substituted).
4. Start the app and sign in.

**Rollback caveat:** builds before 4.0.0 cannot read v2 files. To roll back, restore the
backup from step 1 (any data written since is lost) — don't point an old build at
migrated data.

**Key rotation** — `OLD_ENCRYPTION_KEY=<old> ENCRYPTION_KEY=<new>
node scripts/rotate-encryption-key.mjs [--dry-run]` decrypts every `.enc` file
with the old key (any format) and re-encrypts it with the new key as v2. It refuses to run when the two keys are identical (that is
`reencrypt-data.mjs`'s job). Atomic per file, but a crash mid-run leaves the
tree mixed between keys — **stop the app and take a backup first**; re-running
with the same env resumes safely (already-rotated files are detected via the
new key and skipped). Afterwards update the key file the launch scripts read
(`~/.sampolio/secrets/encryption_key`, or the legacy `<DATA_DIR>/.encryption_key`) and reload
the launchd plist env (see §6 for the full-reload nuance).

**Missing `ENCRYPTION_KEY` is a hard failure in production**: the app throws on
the first data read/write instead of falling back to the publicly known dev
default key. In development the fallback (plus a console warning) remains.

## 9. Environment variable reference

Every variable the code reads (`grep -r "process.env" src scripts next.config.ts`):

| Variable | Required | Read in | Meaning |
|---|---|---|---|
| `ENCRYPTION_KEY` | yes | `db/encryption.ts`, `reencrypt-data.mjs`, `rotate-encryption-key.mjs` | AES-256-GCM master key for all `.enc` files. Resolved by `scripts/lib-secrets.sh` from `.env`, `~/.sampolio/secrets/encryption_key`, or the legacy `~/.sampolio/data/.encryption_key`, and injected into the env by the plist/launch config — the app itself reads only the env. |
| `ENCRYPTION_REQUIRE_PATH_BINDING` | no (default off) | `db/encryption.ts` | `true` → refuse v1 (unbound) encrypted files. Turn on after running `reencrypt-data.mjs` (§8). |
| `AUTH_SECRET` | yes | NextAuth (via env convention) | NextAuth session secret. |
| `AUTH_URL` | yes | NextAuth (env convention), `api/bank/callback/route.ts` | Canonical app URL (prod domain; `http://localhost:4999` for the dev preview). The bank-callback route builds its external redirect base from it (else from the origin of `ENABLE_BANKING_REDIRECT_URL`; never from request headers). |
| `TRUSTED_PROXY_HOPS` | no (default `1`) | `lib/client-ip.ts` | How many reverse proxies sit in front of the app. The client IP for rate limiting, login lockout and the bank PSU header is the `X-Forwarded-For` entry that many places from the right. Prod: `1` (Caddy and cloudflared each set the header). `0` = reached directly; the header is ignored and all clients share one bucket. |
| `SAMPOLIO_SECRETS_DIR` | no (default `~/.sampolio/secrets`) | `scripts/lib-secrets.sh` | Where the launch scripts read/generate `auth_secret` and `encryption_key`. |
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
`.claude/launch.json` starts `next dev -p 4999 -H 127.0.0.1` (loopback only — the
preview enables a password-less login) with the `./data` dot-file secrets
exported (copy the key into `./data/.encryption_key` if prod keeps it in
`~/.sampolio/secrets/`), `DATA_DIR=$PWD/data`, and `DEV_AUTH_BYPASS` enabled (`/dev-login`).
Port 3999 belongs to production (launchd `KeepAlive` restarts it if killed) —
never point a dev server at prod's port or data dir.

## 11. What is intentionally NOT in this repo

Kept out of version control (this is a public repo): the `.env` secrets, the PEM
key, the Cloudflare account/app/IdP IDs, the tunnel UUID, the Zero Trust team
domain, and the allow-listed personal emails. Real values live in `~/sampolio/.env`,
`~/.sampolio/`, and the Cloudflare dashboard. The daily backup script and its
launchd plist also live outside the repo.
