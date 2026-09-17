# Sampolio — Home Assistant Add-on

This add-on packages Sampolio, the self-hosted personal finance planner in
this repository, so it can be installed and run directly from Home
Assistant's Supervisor (Settings → Add-ons). It is a container image built
from the repo's own `Dockerfile`, running the same Next.js app documented in
the root [`README.md`](README.md) and [`docs/`](docs/) — not a different
build.

This is an **alternative deployment path**. It does not change or depend on
the maintainer's own launchd/Caddy production setup described in
[`docs/operations.md`](docs/operations.md); the two are independent
installs of the same app.

## Installing

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**,
   add this repository's URL.
2. Find **Sampolio** in the store and click **Install**. The first install
   builds the image locally (it is not published to a registry), which can
   take a few minutes.
3. Open the **Configuration** tab and fill in the required options (below)
   before starting.
4. Start the add-on, then use **Open Web UI** (it serves on port 3999).
   Read "Access" below first: Home Assistant does **not** authenticate this
   port for you.

## Configuration options

| Option | Required | Notes |
|---|---|---|
| `auth_secret` | **Yes** | NextAuth session secret. Generate with `openssl rand -base64 32`. |
| `encryption_key` | **Yes** | AES-256-GCM master key for the encrypted data files. Generate with `openssl rand -hex 32`. **Never change this once data exists** — existing accounts become unreadable. |
| `auth_url` | **Yes** | A syntactically valid `https://` URL for NextAuth's own internal use. It doesn't need to exactly match whatever URL you're actually browsing through (a LAN IP, `homeassistant.local`, or a Tailscale hostname all reach the same port); `AUTH_TRUST_HOST=true` (set by `run.sh`) plus this app's own use of relative redirects makes that unnecessary. Any stable placeholder like `https://sampolio.local` works. |
| `enable_banking_app_id` | No | Enable Banking (PSD2 AIS) application id. Leave all three `enable_banking_*` options blank to keep bank sync fully disabled (zero network calls) — see [`docs/bank-sync.md`](docs/bank-sync.md). |
| `enable_banking_redirect_url` | No | Must be `<auth_url>/api/bank/callback` and publicly reachable if bank sync is enabled. |
| `enable_banking_private_key` | No | The RS256 PKCS#8 PEM contents (not a file path) for the Enable Banking application. Written to `/data/sampolio/enable_banking_private_key.pem` (mode `0600`) inside the add-on's persistent storage at startup. |
| `ha_webhook_url` | No | A Home Assistant webhook URL (`.../api/webhook/<id>`) that Sampolio's own Split feature POSTs shared-expense activity to — see `docs/features.md` "Home Assistant notifications". This is unrelated to installing the add-on itself; it lets Sampolio *notify* Home Assistant. |
| `tailscale_auth_key` | No | An auth key from your Tailscale admin console (Settings → Keys). Joins this add-on's own container as a separate tailnet device (distinct from any standalone Tailscale add-on), so it needs its own approval on first connect if your tailnet requires it. Leave blank to disable — the add-on has no Tailscale of its own by default. See "Embedded Tailscale" below. |
| `tailscale_funnel` | No | `true`/`false`, only meaningful when `tailscale_auth_key` is set. Two exposures, both needed for the bank flow: **publicly**, via Tailscale Funnel, only `/api/bank/callback` — no other route, not the login page; and **to your tailnet**, on port 8443 of the same hostname, the **whole app**, because the callback needs a session cookie set on that hostname (see "Embedded Tailscale"). Everyone on your tailnet can therefore reach Sampolio's login while this is on. Off by default; turn it back off once the bank is linked. |

Options marked required are enforced at container startup: the add-on exits
immediately with a clear error if any are missing, rather than falling back
to an insecure default (matching the non-Docker deployment's behavior — see
`docs/operations.md` §8).

## Embedded Tailscale (optional)

Setting `tailscale_auth_key` runs `tailscaled` inside the add-on's own
container (state persisted under `/data/tailscale`, so it doesn't need
re-approval on every restart), in **userspace networking mode**
(`--tun=userspace-networking`).

That mode is a security requirement here, not a detail. In normal TUN mode
tailscaled gives the container a tailnet IP and delivers inbound tailnet
packets to its kernel stack, which makes every port in the container
reachable by every device on the tailnet — with no Home Assistant login in
front of it. Setting an auth key alone would then quietly put the whole app
on your tailnet, whether or not `tailscale_funnel` is on.
Userspace mode terminates inbound traffic inside tailscaled instead, so only
what `tailscale serve`/`funnel` explicitly publishes is reachable. It also
needs no TUN device and no `NET_ADMIN`/`NET_RAW`, which is why `config.yaml`
requests **no** `privileged:` capabilities and **no** `devices:` at all.

This exists specifically for `tailscale_funnel`: a **standalone** Tailscale
add-on's Services/Serve feature is tailnet-only, but some flows — notably an
Enable Banking (or other PSD2 AIS) consent redirect — may need a genuinely
public HTTPS callback URL. Funnel provides that; plain tailnet-only Serve
does not. `run.sh` maps exactly one path on the public port —
`tailscale funnel --set-path=/api/bank/callback` — and that single mapping is
what limits the exposure: Tailscale cannot mix tailnet-only Serve and public
Funnel on one port (the last command to configure a port wins), so enabling
Funnel makes the whole port public and only this one path has anything
behind it. `AllowFunnel` is keyed per host **and port**, which is why the
whole-app mount on `:8443` stays tailnet-only. **Disable self-signup** (Settings → Admin, in the app) before
ever enabling this — Funnel's hostname becomes publicly discoverable via
Certificate Transparency logs the moment its cert is issued, regardless of
whether anyone guesses it.

This embedded device joins your tailnet as `sampolio-callback` — deliberately
a different name from the standalone add-on's `svc:sampolio` Service, so the
two don't collide. `ENABLE_BANKING_REDIRECT_URL` therefore needs its own
hostname: `https://sampolio-callback.<your-tailnet-name>.ts.net/api/bank/callback`
— register that exact URL with Enable Banking.

**While linking a bank, browse the app at
`https://sampolio-callback.<your-tailnet-name>.ts.net:8443`** (tailnet-only,
set up automatically when `tailscale_funnel` is on), and set `auth_url` to
that same URL. This is not cosmetic. The callback requires an authenticated
session, and the session cookie is host-only: if you start the bank
connection from any other hostname, the bank's redirect arrives at
`sampolio-callback...` with no cookie, the callback bounces you to sign-in,
and the single-use `code` and `state` are spent without the connection ever
completing. Browsing on `:8443` works because cookies ignore the port number,
so the session is sent with the redirect to `:443`.

If you don't need public exposure, you likely don't need this at all — a
separate standalone Tailscale add-on's Services config already gets you
private, certificate-backed HTTPS to this add-on without any of the above.
To stop using the embedded Tailscale later: either set `tailscale_funnel` to
`false` (stays joined to the tailnet, drops the public exposure) or clear
`tailscale_auth_key` entirely (disables this block completely) — both are
config-only changes, no rebuild needed.

## Data & backups

All encrypted user data lives under `/data/sampolio` inside the add-on's
persistent storage volume, which Home Assistant keeps across add-on updates
and restarts. Include this add-on's data in your normal Home Assistant
**Settings → System → Backups** snapshots to back it up.

## Access

The add-on publishes **port 3999**; it does not use Home Assistant Ingress.
Ingress would put HA's own login and 2FA in front of Sampolio, which would be
strictly better, but the app does not render under it — Next.js needs a
build-time `basePath` to match the rotating ingress-token path prefix, and
that token isn't known until the add-on runs. This is recorded in the repo's
`docs/known-gaps.md` #4 and will be revisited if Next.js gains runtime
base-path support.

**You must reach it over HTTPS.** The session cookie is
`__Secure-authjs.session-token`, which browsers refuse to store unless it
arrives over HTTPS, so signing in at `http://<your-ha-host>:3999` fails — you
land back on the sign-in page with no session. Use an HTTPS front door: a
standalone Tailscale add-on's Serve/Services gives you a real certificate and
a `*.ts.net` hostname pointing at this port, which is tailnet-only. (From the
Home Assistant host itself, `http://localhost:3999` also works, because
browsers treat localhost as trustworthy.) See `docs/known-gaps.md` #5.

**And on this port, Sampolio's own login is the only thing protecting your
financial data.** There is no Home Assistant session check in front of it. So:

- Do **not** port-forward 3999 or otherwise expose it to the internet.
- Keep the HTTPS front door tailnet-only.
- Use a strong, unique password for your Sampolio account.
- **Turn off self-signup** (Settings → Admin, in the app) as soon as your own
  account exists. It defaults to **on** so that the first account can be
  created, which means that until you turn it off, anything that can reach
  this port can register itself an account.

The one deliberate public exception is the scoped Tailscale Funnel path
(`tailscale_funnel`), which publishes only `/api/bank/callback` — not a
browsable page — and which `run.sh` tears down again when you turn the option
off. See "Embedded Tailscale".

Because Ingress is not used, `ALLOW_IFRAME_EMBED` is **not** set, so
`X-Frame-Options: DENY` and `frame-ancestors 'none'` both apply. That blocks
clickjacking, and it also means Sampolio cannot be embedded in a Home
Assistant iframe panel — open it in its own tab.



## Updating

Update like any other add-on from the Supervisor UI. Your `/data` volume is
untouched by updates. `encryption_key` must never change across an update —
losing it (or changing it) makes existing data unreadable.
