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
| `auth_secret_file` | No | Path to a file holding `auth_secret` instead of pasting the value above — e.g. `/ssl/sampolio-auth-secret`. Keeps it off the Configuration tab and out of the add-on's config backup. Still a plain-text file on the host: this reduces where the value appears, it does not encrypt it. |
| `encryption_key_file` | No | Same, for `encryption_key`. If you use it, clear the inline option — a value left there stays in `options.json` regardless. |
| `auth_url` | **Yes** | A syntactically valid `https://` URL for NextAuth's own internal use. It doesn't need to exactly match whatever URL you're actually browsing through (a LAN IP, `homeassistant.local`, or a Tailscale hostname all reach the same port); `AUTH_TRUST_HOST=true` (set by `run.sh`) plus this app's own use of relative redirects makes that unnecessary. Any stable placeholder like `https://sampolio.local` works. |
| `enable_banking_app_id` | No | Enable Banking (PSD2 AIS) application id. Leave all three `enable_banking_*` options blank to keep bank sync fully disabled (zero network calls) — see [`docs/bank-sync.md`](docs/bank-sync.md). |
| `enable_banking_redirect_url` | No | Must be `<auth_url>/api/bank/callback` and publicly reachable if bank sync is enabled. |
| `enable_banking_private_key_file` | No | **Path** to the RS256 PKCS#8 PEM — not its contents. Put the file in `/ssl` (mapped read-only into the add-on) and leave this at the default `/ssl/sampolio-enable-banking.pem`, or point it elsewhere under `/ssl`. The key is never copied, so it stays out of `options.json`, out of the Configuration tab and out of Home Assistant backups of the add-on's data. |
| `ha_webhook_url` | No | A Home Assistant webhook URL (`.../api/webhook/<id>`) that Sampolio's own Split feature POSTs shared-expense activity to — see `docs/features.md` "Home Assistant notifications". This is unrelated to installing the add-on itself; it lets Sampolio *notify* Home Assistant. |
| `ha_summary_minutes` | No | `0` = off. How often to push **summary numbers** to `ha_webhook_url`: account balances, card totals and what is left for the rest of the month. Numbers only — no transactions, merchants, categories, IBANs. Clamped to 5–1440 minutes. The payload is tagged `event: "summary.updated"` so an automation can tell it apart from Split activity on the same webhook. |
| `tailscale_auth_key` | No | An auth key from your Tailscale admin console (Settings → Keys). Joins this add-on's own container as a separate tailnet device (distinct from any standalone Tailscale add-on), so it needs its own approval on first connect if your tailnet requires it. Leave blank to disable — the add-on has no Tailscale of its own by default. See "Embedded Tailscale" below. |
| `tailscale_serve` | No | On by default when `tailscale_auth_key` is set. Publishes the **whole app** on port 8443 of this add-on's tailnet hostname — reachable from your tailnet only, over HTTPS with a real certificate. This is the intended way to use Sampolio, and why no host port is published by default. The HTTPS part is not cosmetic: over plain `http://` on a LAN address the browser discards the session cookie and sign-in never sticks. |
| `tailscale_funnel` | No | `true`/`false`, only meaningful when `tailscale_auth_key` is set. Two exposures, both needed for the bank flow: **publicly**, via Tailscale Funnel, only `/api/bank/callback` — no other route, not the login page; and **to your tailnet**, on port 8443 of the same hostname, the **whole app**, because the callback needs a session cookie set on that hostname (see "Embedded Tailscale"). Everyone on your tailnet can therefore reach Sampolio's login while this is on. Off by default; turn it back off once the bank is linked. |
| `reset_admin_password` | No | A recovery switch, not a password field. Turn it on and restart: the add-on generates a new password for the admin account, prints it **once** in the add-on log, and will not do it again until you turn the switch off. Nothing is stored in `options.json`. Use this instead of reinstalling when you cannot sign in. |
| `wipe_data` | No | Deletes **all** Sampolio data (`/data/sampolio`) on the next start, then refuses to repeat until you switch it off again. Sign up afterwards — the first account becomes the admin. Irreversible: take a Home Assistant backup first. |

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

## If you cannot sign in

Nothing here needs a reinstall, and none of it touches your data except where
it says so.

1. **Locked out after too many attempts.** The lockout is held in memory, so
   simply restarting the add-on clears it. No option needed.
2. **Forgotten password.** Set `reset_admin_password` to `true`, restart, and
   read the new password from the add-on **Log** tab — it is printed once, in
   a boxed banner. Sign in with it, change it in Settings → Account, then set
   the switch back to `false`.
3. **Sign-in appears to do nothing.** You are almost certainly opening the app
   over plain `http://` on something other than `localhost`; see "Access".
   The sign-in page now tells you so explicitly rather than silently bouncing.
4. **Start completely fresh.** Set `wipe_data` to `true` and restart. This
   deletes every account and all financial data, then re-arms only after you
   set it back to `false`.

Each switch acts once. Leaving one on does not repeat it on the next restart —
that is deliberate, so a forgotten `wipe_data` cannot destroy the data you just
restored.

## Moving the Enable Banking key out of the options

Earlier versions took the PEM's **contents** as an add-on option. That value
was written in plain text to `/data/options.json`, shown in the Configuration
tab, and copied into the add-on's data directory — so it also landed in any
Home Assistant backup. If you ever pasted a key there, treat it as exposed:
issue a new one at enablebanking.com rather than reusing it.

To set the new key up:

1. Put the PEM on the Home Assistant host at `/ssl/sampolio-enable-banking.pem`
   (the File editor, Samba or SSH add-ons all reach `/ssl`).
2. Leave `enable_banking_private_key_file` at its default, or set it to
   wherever under `/ssl` you put the file.
3. Clear the old `enable_banking_private_key` option if your configuration
   still has it. The add-on warns on every start until you do.

On start the add-on also deletes any copy of the key that an earlier version
left in its data directory.

## Reading your figures in Home Assistant

Set `ha_webhook_url` to a Home Assistant webhook and `ha_summary_minutes` to,
say, `30`. Sampolio then POSTs a payload like this on that interval:

```json
{
  "event": "summary.updated",
  "ts": "2026-11-14T20:00:00.000Z",
  "currency": "EUR",
  "totals": { "cashBalance": 200000, "cardOutstanding": 50000, "leftThisMonth": 120000 },
  "accounts": [{ "id": "…", "name": "Joint account", "endOfMonthBalance": 150000, "leftThisMonth": 90000 }],
  "cards": [{ "id": "…", "name": "Everyday Visa", "outstanding": 42000, "availableCredit": 158000 }]
}
```

Amounts are in cents. `leftThisMonth` is what the month ends with if no
further income arrives — what there is to last on until the next pay. It stays
correct mid-month: once a salary is booked, the projection counts only the
income that still remains.

The same webhook also receives Split activity, which does contain names and
expense titles. Branch on `event` in your automation: `summary.updated` is the
numbers-only feed.

## A note on secrets and plain text

Home Assistant stores add-on options as a plain JSON file (`/data/options.json`).
The `password` type in an add-on's schema **only masks the input box** — it
does nothing to how the value is stored. Any secret given as an option is
therefore readable on disk, rendered on the Configuration tab, and carried in
the add-on's config backup.

This add-on lets you name a **file** instead for the three that matter
(`auth_secret_file`, `encryption_key_file`, `enable_banking_private_key_file`),
which keeps those values off the Configuration tab and out of the add-on's own
backup. Be clear about what that buys: the file is still plain text on the
host, and a **full** Home Assistant backup includes `/ssl`. It reduces the
number of places a secret appears; it does not encrypt anything.

What actually moves the needle:

- **Encrypt your Home Assistant backups** (set a backup password). This is the
  single highest-value change, because backups are what leave the house.
- Keep the add-on's port unpublished and reach it over Tailscale.
- Treat anything that was ever pasted into an option as exposed, and rotate it.

A process that must start unattended after a power cut has to be able to read
its own secrets without a human present, so some form of on-disk secret is
unavoidable here. The deployment notes in `docs/operations.md` describe a
setup with stronger at-rest properties for anyone who wants them.

## Data & backups

All encrypted user data lives under `/data/sampolio` inside the add-on's
persistent storage volume, which Home Assistant keeps across add-on updates
and restarts. Include this add-on's data in your normal Home Assistant
**Settings → System → Backups** snapshots to back it up.

## Access

**No host port is published by default.** Home Assistant Ingress would be the
best option — it puts HA's own login and 2FA in front — but the app does not
render under it: Next.js needs a build-time `basePath` to match the rotating
ingress-token path prefix, and that token is not known until the add-on runs
(`docs/known-gaps.md` #4). So rather than expose an unauthenticated port by
default, the add-on publishes nothing until you ask for it.

**The intended way in is `tailscale_serve`**: set `tailscale_auth_key`, and the
app is served at `https://sampolio-callback.<your-tailnet>.ts.net:8443`,
reachable from your tailnet only. Set `auth_url` to that same URL. Being real
HTTPS, the session cookie keeps its `Secure` attribute, which plain-HTTP
access cannot do.

**If you want LAN access instead**, set a host port in the add-on's **Network**
section (3999 is offered). Then open it at `http://<ha-host>:3999` — and note
that sign-in works there only because the add-on detects a plain-`http://`
`auth_url` and drops the `Secure` cookie attribute accordingly, which means
the session cookie travels in clear text on your network.

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
