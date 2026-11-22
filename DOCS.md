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
   add this repository's URL **including the branch suffix** — for example
   `https://github.com/<owner>/sampolio#<branch>`. Without `#<branch>` the
   store reads the default branch, which may not carry the add-on files.
2. Find **Sampolio** in the store and click **Install**. The first install
   builds the image locally (it is not published to a registry), which can
   take a few minutes.
3. Open the **Configuration** tab and fill in the required options (below)
   before starting.
4. Decide how you will reach it **before** starting — no host port is
   published by default, so nothing answers until you choose (see "Access"):
   either set host port 3999 in the add-on's **Network** section, or set
   `tailscale_auth_key` and use the tailnet HTTPS address. **Open Web UI**
   only works once a host port is set.
5. Start the add-on and sign up. The first account becomes the admin, and
   self-signup is closed by default for everyone after it.

## Configuration options

| Option | Required | Notes |
|---|---|---|
| `auth_secret` | **Yes**, here or as `auth_secret_file` | NextAuth session secret. Generate with `openssl rand -base64 32`. |
| `encryption_key` | **Yes**, here or as `encryption_key_file` | AES-256-GCM master key for the encrypted data files. Generate with `openssl rand -hex 32`. **Never change this once data exists** — existing accounts become unreadable. |
| `auth_secret_file` | No | Path to a file holding `auth_secret` instead of pasting the value above — e.g. `/ssl/sampolio-auth-secret`. Keeps it off the Configuration tab and out of the add-on's config backup. Still a plain-text file on the host: this reduces where the value appears, it does not encrypt it. |
| `encryption_key_file` | No | Same, for `encryption_key`. If you use it, clear the inline option — a value left there stays in `options.json` regardless. |
| `auth_url` | **Yes** | The address you actually open the app at — and it must match, because two things depend on it. Its **scheme** decides the session cookie: `https://` gets a `Secure` cookie, an explicit `http://` does not. Get that wrong and sign-in silently never sticks (an `https://` value while browsing over plain `http://` makes the browser discard the cookie). It is also the base for the redirect after a bank connection. Use `http://<ha-host>:3999` with a published port, or `https://sampolio-callback.<your-tailnet>.ts.net:8443` with `tailscale_serve`. |
| `enable_banking_app_id` | No | Enable Banking (PSD2 AIS) application id. Leave all three `enable_banking_*` options blank to keep bank sync fully disabled (zero network calls) — see [`docs/bank-sync.md`](docs/bank-sync.md). |
| `enable_banking_redirect_url` | No | The public consent-callback URL you register with Enable Banking. With this add-on's Funnel that is `https://sampolio-callback.<your-tailnet>.ts.net/api/bank/callback` — port 443, **not** your `:8443` `auth_url` with the path appended. Must be reachable from the public internet while you link a bank. |
| `enable_banking_private_key_file` | No | **Path** to the RS256 PKCS#8 PEM — not its contents. Put the file in `/ssl` (mapped read-only into the add-on) and leave this at the default `/ssl/sampolio-enable-banking.pem`, or point it elsewhere under `/ssl`. The key is never copied, so it stays out of `options.json`, out of the Configuration tab and out of Home Assistant backups of the add-on's data. |
| `ha_webhook_url` | No | A Home Assistant webhook URL (`.../api/webhook/<id>`) that Sampolio's own Split feature POSTs shared-expense activity to — see `docs/features.md` "Home Assistant notifications". This is unrelated to installing the add-on itself; it lets Sampolio *notify* Home Assistant. |
| `ha_summary_minutes` | No | `0` = off. How often to push **summary numbers** to `ha_webhook_url`: account balances, card totals and what is left for the rest of the month. Numbers only — no transactions, merchants, categories, IBANs. Clamped to 5–1440 minutes. The payload is tagged `event: "summary.updated"` so an automation can tell it apart from Split activity on the same webhook. |
| `tailscale_auth_key` | No | An auth key from your Tailscale admin console (Settings → Keys). Joins this add-on's own container as a separate tailnet device (distinct from any standalone Tailscale add-on), so it needs its own approval on first connect if your tailnet requires it. Leave blank to disable — the add-on has no Tailscale of its own by default. See "Embedded Tailscale" below. |
| `tailscale_serve` | No | On by default when `tailscale_auth_key` is set. Publishes the **whole app** on port 8443 of this add-on's tailnet hostname — reachable from your tailnet only, over HTTPS with a real certificate. This is the intended way to use Sampolio, and why no host port is published by default. The HTTPS part is not cosmetic: over plain `http://` on a LAN address the browser discards the session cookie and sign-in never sticks. |
| `tailscale_funnel` | No | `true`/`false`, only meaningful when `tailscale_auth_key` is set. Publishes **only** `/api/bank/callback` to the public internet, on port 443 — no other route, not the login page. Needed only while linking a bank. The callback also needs `tailscale_serve` on, because it requires a session cookie set on that same hostname (see "Embedded Tailscale"). Off by default; turn it back off once the bank is linked. |
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

It does two separate jobs. **`tailscale_serve`** (on by default once a key
is set) serves the whole app on `:8443`, tailnet-only, over HTTPS — the
intended everyday way in, and the reason no host port is published.
**`tailscale_funnel`** exists for one flow: an Enable Banking (or other PSD2
AIS) consent redirect needs a genuinely public HTTPS callback URL, which
tailnet-only Serve cannot provide. `run.sh` maps exactly one path on the public port —
`tailscale funnel --set-path=/api/bank/callback` — and that single mapping is
what limits the exposure: Tailscale cannot mix tailnet-only Serve and public
Funnel on one port (the last command to configure a port wins), so enabling
Funnel makes the whole port public and only this one path has anything
behind it. `AllowFunnel` is keyed per host **and port**, which is why the
whole-app mount on `:8443` stays tailnet-only. Self-signup is closed by
default; keep it that way before enabling Funnel — the hostname becomes
publicly discoverable via Certificate Transparency logs the moment its
certificate is issued, whether or not anyone guesses it.

This embedded device joins your tailnet as `sampolio-callback` — deliberately
a different name from the standalone add-on's `svc:sampolio` Service, so the
two don't collide. `ENABLE_BANKING_REDIRECT_URL` therefore needs its own
hostname: `https://sampolio-callback.<your-tailnet-name>.ts.net/api/bank/callback`
— register that exact URL with Enable Banking.

**While linking a bank, browse the app at
`https://sampolio-callback.<your-tailnet-name>.ts.net:8443`** (tailnet-only,
served by `tailscale_serve`), and set `auth_url` to
that same URL. This is not cosmetic. The callback requires an authenticated
session, and the session cookie is host-only: if you start the bank
connection from any other hostname, the bank's redirect arrives at
`sampolio-callback...` with no cookie, the callback bounces you to sign-in,
and the single-use `code` and `state` are spent without the connection ever
completing. Browsing on `:8443` works because cookies ignore the port number,
so the session is sent with the redirect to `:443`.

A standalone Tailscale add-on's Services/Serve can front this add-on
instead, but it proxies to a port on the Home Assistant host — so it needs a
host port published in the Network section, which this add-on's own
`tailscale_serve` avoids. To stop using the embedded Tailscale: set
`tailscale_funnel` to `false` to drop the public callback (Serve and the
tailnet membership stay), or clear `tailscale_auth_key` to disable the block
entirely. Both are config-only changes. Serve and Funnel are reset and
reapplied on every start, so turning an option off really does remove it —
they persist in tailscaled's state otherwise.

## If you cannot sign in

Nothing here needs a reinstall, and none of it touches your data except where
it says so.

1. **Locked out after too many attempts.** The lockout is held in memory, so
   simply restarting the add-on clears it. No option needed.
2. **Forgotten password.** Set `reset_admin_password` to `true`, restart, and
   read the new password from the add-on **Log** tab — it is printed once, in
   a boxed banner. Sign in with it, change it in Settings → Account, then set
   the switch back to `false`.
3. **Sign-in appears to do nothing.** Almost always `auth_url` does not match
   the address in your browser — typically an `https://` `auth_url` while you
   open the app over plain `http://`, so the browser discards the `Secure`
   session cookie. Set `auth_url` to exactly the address you use and restart.
   The sign-in page says so explicitly rather than silently bouncing, and the
   add-on log names the reason for any rejected sign-in.
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
unavoidable here. Disk encryption is the only thing that protects them from
someone holding the device itself, and the add-on cannot provide that.

## Data & backups

All user data lives under `/data/sampolio` inside the add-on's
persistent storage volume, which Home Assistant keeps across add-on updates
and restarts. Financial data is AES-256-GCM encrypted; avatar images are
stored unencrypted. Include this add-on's data in your normal Home Assistant
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
section (3999 is offered), set `auth_url` to `http://<ha-host>:3999`, and open
it there. Sign-in works because a plain-`http://` `auth_url` drops the
cookie's `Secure` attribute — which also means the session cookie travels in
clear text on your network.

**And on this port, Sampolio's own login is the only thing protecting your
financial data.** There is no Home Assistant session check in front of it. So:

- Do **not** port-forward 3999 or otherwise expose it to the internet.
- Keep the HTTPS front door tailnet-only.
- Use a strong, unique password for your Sampolio account.
- Leave self-signup **off** (Settings → Admin) unless you are adding someone.
  It is closed by default, and the very first account can always be created
  regardless, so it only needs opening to invite a second person.

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
