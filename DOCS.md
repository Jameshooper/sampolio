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
4. Start the add-on, then use **Open Web UI**, or the sidebar panel it adds —
   this is an **Ingress** add-on with no direct port, so it's only reachable
   through an authenticated Home Assistant session. See "Access" below.

## Configuration options

| Option | Required | Notes |
|---|---|---|
| `auth_secret` | **Yes** | NextAuth session secret. Generate with `openssl rand -base64 32`. |
| `encryption_key` | **Yes** | AES-256-GCM master key for the encrypted data files. Generate with `openssl rand -hex 32`. **Never change this once data exists** — existing accounts become unreadable. |
| `auth_url` | **Yes** | A syntactically valid `https://` URL for NextAuth's own internal use. Since this add-on is Ingress-only (no fixed public hostname — Ingress can be reached via a LAN IP, `homeassistant.local`, a Tailscale hostname, or Nabu Casa's cloud domain depending on how you're connected), it doesn't need to exactly match whatever URL you're actually browsing through; `AUTH_TRUST_HOST=true` (set by `run.sh`) plus this app's own use of relative redirects makes that unnecessary. Any stable placeholder like `https://sampolio.local` works. |
| `enable_banking_app_id` | No | Enable Banking (PSD2 AIS) application id. Leave all three `enable_banking_*` options blank to keep bank sync fully disabled (zero network calls) — see [`docs/bank-sync.md`](docs/bank-sync.md). |
| `enable_banking_redirect_url` | No | Must be `<auth_url>/api/bank/callback` and publicly reachable if bank sync is enabled. |
| `enable_banking_private_key` | No | The RS256 PKCS#8 PEM contents (not a file path) for the Enable Banking application. Written to `/data/sampolio/enable_banking_private_key.pem` (mode `0600`) inside the add-on's persistent storage at startup. |
| `ha_webhook_url` | No | A Home Assistant webhook URL (`.../api/webhook/<id>`) that Sampolio's own Split feature POSTs shared-expense activity to — see `docs/features.md` "Home Assistant notifications". This is unrelated to installing the add-on itself; it lets Sampolio *notify* Home Assistant. |
| `tailscale_auth_key` | No | An auth key from your Tailscale admin console (Settings → Keys). Joins this add-on's own container as a separate tailnet device (distinct from any standalone Tailscale add-on), so it needs its own approval on first connect if your tailnet requires it. Leave blank to disable — the add-on has no Tailscale of its own by default. See "Embedded Tailscale" below. |
| `tailscale_funnel` | No | `true`/`false`, only meaningful when `tailscale_auth_key` is set. Exposes **only `/api/bank/callback`** to the public internet via Tailscale Funnel — nothing else on the app (not the login page, not any other route). Off by default. |

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
front of it. Setting an auth key alone would then reopen exactly the bypass
`ingress: true` exists to close, whether or not `tailscale_funnel` is on.
Userspace mode terminates inbound traffic inside tailscaled instead, so only
what `tailscale serve`/`funnel` explicitly publishes is reachable. It also
needs no TUN device and no `NET_ADMIN`/`NET_RAW`, which is why `config.yaml`
requests **no** `privileged:` capabilities and **no** `devices:` at all.

This exists specifically for `tailscale_funnel`: a **standalone** Tailscale
add-on's Services/Serve feature is tailnet-only, but some flows — notably an
Enable Banking (or other PSD2 AIS) consent redirect — may need a genuinely
public HTTPS callback URL. Funnel provides that; plain tailnet-only Serve
does not. `run.sh` scopes it to `tailscale serve --set-path=/api/bank/callback`
plus `tailscale funnel 443 on` — Funnel publishes whatever `serve` already
exposes on that port, and nothing else is mapped, so the login page and
every other route stay unreachable from outside the tailnet even while
Funnel is on. **Disable self-signup** (Settings → Admin, in the app) before
ever enabling this — Funnel's hostname becomes publicly discoverable via
Certificate Transparency logs the moment its cert is issued, regardless of
whether anyone guesses it.

This embedded device joins your tailnet as `sampolio-callback` — deliberately
a different name from the standalone add-on's `svc:sampolio` Service, so the
two don't collide. `ENABLE_BANKING_REDIRECT_URL` therefore needs its own
hostname: `https://sampolio-callback.<your-tailnet-name>.ts.net/api/bank/callback`,
**not** the `auth_url`/Services hostname you browse the app at day to day —
register that exact URL with Enable Banking.

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

This add-on has **no direct port** — `config.yaml` sets `ingress: true` with
no `ports`/`webui`, so the only way in day to day is through an
**authenticated Home Assistant session**: Supervisor proxies Sampolio inside
an iframe in the HA frontend (from the add-on page's "Open Web UI", or the
sidebar panel it adds). Whatever login method protects your Home Assistant
instance — including 2FA, if you have it configured — protects Sampolio the
same way, since nothing reaches it without first authenticating to HA.

To make that iframe embedding possible at all, this build sets
`ALLOW_IFRAME_EMBED=true` (Dockerfile). Ingress serves the add-on from the HA
frontend's *own* origin, so the framing page and the framed page are
same-origin: that build **relaxes** the CSP's `frame-ancestors` from `'none'`
to `'self'` and drops only `X-Frame-Options` (which has no allowlist that can
express "same origin only"). Framing protection is not removed — a
third-party page still cannot frame this app.

**This only holds if it stays the only way in.** If you also keep a
standalone Tailscale add-on's `svc:sampolio` Service (or re-add a direct
port), that path bypasses HA's login/2FA entirely — Ingress isn't a security
boundary you also have, it's the boundary, so anything parallel to it
undermines the point of using it. The one deliberate exception is the
scoped Tailscale Funnel path (`tailscale_funnel`), which exposes only
`/api/bank/callback` — not a browsable page, and unrelated to this iframe
concern.

## Updating

Update like any other add-on from the Supervisor UI. Your `/data` volume is
untouched by updates. `encryption_key` must never change across an update —
losing it (or changing it) makes existing data unreadable.
