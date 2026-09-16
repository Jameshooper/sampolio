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
4. Start the add-on, then use **Open Web UI** (or `http://<your-ha-host>:3999`).

## Configuration options

| Option | Required | Notes |
|---|---|---|
| `auth_secret` | **Yes** | NextAuth session secret. Generate with `openssl rand -base64 32`. |
| `encryption_key` | **Yes** | AES-256-GCM master key for the encrypted data files. Generate with `openssl rand -hex 32`. **Never change this once data exists** — existing accounts become unreadable. |
| `auth_url` | **Yes** | The public URL you'll reach Sampolio at, e.g. `http://homeassistant.local:3999` or your own reverse-proxy URL. Used by NextAuth for redirects. |
| `enable_banking_app_id` | No | Enable Banking (PSD2 AIS) application id. Leave all three `enable_banking_*` options blank to keep bank sync fully disabled (zero network calls) — see [`docs/bank-sync.md`](docs/bank-sync.md). |
| `enable_banking_redirect_url` | No | Must be `<auth_url>/api/bank/callback` and publicly reachable if bank sync is enabled. |
| `enable_banking_private_key` | No | The RS256 PKCS#8 PEM contents (not a file path) for the Enable Banking application. Written to `/data/enable_banking_private_key.pem` inside the add-on's persistent storage at startup. |
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
re-approval on every restart). This needs `NET_ADMIN`/`NET_RAW` and
`/dev/net/tun`, which `config.yaml` requests — deliberately narrower than a
full Tailscale add-on (no `SYS_ADMIN`, no `host_network`), so Sampolio keeps
its own network namespace and published port regardless.

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

## Ports

The add-on listens on `3999/tcp` by default; remap it from the add-on's
**Network** tab like any other add-on. It is a direct port (not Ingress), so
opening the web UI takes you to Sampolio in a new browser tab rather than
embedding it in the Home Assistant frontend — Sampolio's security headers
deny being framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), which
this add-on does not change.

## Updating

Update like any other add-on from the Supervisor UI. Your `/data` volume is
untouched by updates. `encryption_key` must never change across an update —
losing it (or changing it) makes existing data unreadable.
