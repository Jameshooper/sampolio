#!/bin/sh
# Sampolio container entrypoint.
#
# Reads Home Assistant add-on options from /data/options.json (present when
# running as a HA Supervisor add-on) and maps them onto the same environment
# variables the non-Docker deployment reads — see docs/operations.md §9 in
# the source repo for the authoritative variable reference. Falls back to
# plain environment variables (docker run -e / --env-file) when
# /data/options.json is absent, so the same image also works as a bare
# `docker run` deployment.
set -eu

# Overridable only so the test suite (src/test/run-sh.test.ts) can point this
# at a fixture; Supervisor always mounts the real file at the default path.
OPTIONS_FILE="${OPTIONS_FILE:-/data/options.json}"

get_option() {
  node -e '
    const fs = require("fs");
    const [key, file] = process.argv.slice(1);
    let opts = {};
    try { opts = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
    const v = opts[key];
    process.stdout.write(v === undefined || v === null ? "" : String(v));
  ' "$1" "$OPTIONS_FILE"
}

if [ -f "$OPTIONS_FILE" ]; then
  AUTH_SECRET="${AUTH_SECRET:-$(get_option auth_secret)}"
  ENCRYPTION_KEY="${ENCRYPTION_KEY:-$(get_option encryption_key)}"
  AUTH_URL="${AUTH_URL:-$(get_option auth_url)}"
  ENABLE_BANKING_APP_ID="${ENABLE_BANKING_APP_ID:-$(get_option enable_banking_app_id)}"
  ENABLE_BANKING_REDIRECT_URL="${ENABLE_BANKING_REDIRECT_URL:-$(get_option enable_banking_redirect_url)}"
  ENABLE_BANKING_PRIVATE_KEY_FILE="${ENABLE_BANKING_PRIVATE_KEY_FILE:-$(get_option enable_banking_private_key_file)}"
  HA_WEBHOOK_URL="${HA_WEBHOOK_URL:-$(get_option ha_webhook_url)}"
  TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-$(get_option tailscale_auth_key)}"
  TAILSCALE_SERVE="${TAILSCALE_SERVE:-$(get_option tailscale_serve)}"
  TAILSCALE_FUNNEL="${TAILSCALE_FUNNEL:-$(get_option tailscale_funnel)}"
  RESET_ADMIN_PASSWORD="${RESET_ADMIN_PASSWORD:-$(get_option reset_admin_password)}"
  WIPE_DATA="${WIPE_DATA:-$(get_option wipe_data)}"
fi

if [ -z "${AUTH_SECRET:-}" ] || [ -z "${ENCRYPTION_KEY:-}" ] || [ -z "${AUTH_URL:-}" ]; then
  echo "Sampolio: auth_secret, encryption_key, and auth_url are required." >&2
  echo "Set them in the add-on's Configuration tab (or as AUTH_SECRET / ENCRYPTION_KEY / AUTH_URL env vars)." >&2
  exit 1
fi

export AUTH_SECRET
export ENCRYPTION_KEY
export AUTH_URL
export AUTH_TRUST_HOST=true

# /data is the add-on's persistent storage volume (survives updates/restarts).
# Keep the app's own data tree in a subdirectory so it never collides with
# Supervisor-managed files such as options.json.
export DATA_DIR="${DATA_DIR:-/data/sampolio}"
mkdir -p "$DATA_DIR"

# One-shot maintenance, so a forgotten password never again means
# uninstalling the add-on with "delete app data".
#
# Both are guarded by a marker kept OUTSIDE $DATA_DIR (the wipe deletes that
# whole tree), so leaving the switch on cannot repeat the action on every
# restart — a wipe that re-ran on each boot would destroy the data the user
# just restored. Turning the option off clears the marker and re-arms it.
WIPE_MARKER="$(dirname "$DATA_DIR")/.sampolio-wipe-done"
if [ "${WIPE_DATA:-}" = "true" ]; then
  if [ -e "$WIPE_MARKER" ]; then
    echo "Sampolio: wipe_data is still switched on, but the wipe has already been performed." >&2
    echo "Sampolio: set wipe_data back to false in the Configuration tab; it will not run again until you do." >&2
  else
    echo "Sampolio: wipe_data is set — DELETING ALL APP DATA in $DATA_DIR." >&2
    rm -rf "${DATA_DIR:?refusing to wipe an empty path}"
    mkdir -p "$DATA_DIR"
    : > "$WIPE_MARKER"
    echo "Sampolio: data wiped. Sign up at /auth/signup to create a new first account (it becomes admin)." >&2
    echo "Sampolio: set wipe_data back to false now." >&2
  fi
else
  rm -f "$WIPE_MARKER"
fi

# Read by the app at startup (src/lib/addon-maintenance.ts), which has the
# encryption and password hashing this cannot do from the shell.
if [ "${RESET_ADMIN_PASSWORD:-}" = "true" ]; then
  export SAMPOLIO_RESET_ADMIN_PASSWORD=true
else
  export SAMPOLIO_RESET_ADMIN_PASSWORD=false
fi

# The Enable Banking signing key is referenced by PATH, never pasted into an
# add-on option. An option's value is stored in plain text in
# /data/options.json, is shown in the Configuration tab, and ends up in any
# Home Assistant backup or screenshot of that page — for the private half of
# a bank credential that is the wrong place. Put the PEM in /ssl (mapped
# read-only below) and point this at it.
if [ -n "${ENABLE_BANKING_APP_ID:-}" ] && [ -n "${ENABLE_BANKING_REDIRECT_URL:-}" ] && [ -n "${ENABLE_BANKING_PRIVATE_KEY_FILE:-}" ]; then
  if [ ! -f "$ENABLE_BANKING_PRIVATE_KEY_FILE" ]; then
    # Loud, and not fatal: the app hard-disables bank sync without the key, so
    # the rest of Sampolio should still start.
    echo "Sampolio: enable_banking_private_key_file is set to '$ENABLE_BANKING_PRIVATE_KEY_FILE' but no such file exists." >&2
    echo "Sampolio: bank sync stays disabled. Copy the PEM into /ssl and check the path." >&2
  elif [ ! -r "$ENABLE_BANKING_PRIVATE_KEY_FILE" ]; then
    echo "Sampolio: '$ENABLE_BANKING_PRIVATE_KEY_FILE' exists but is not readable by the add-on. Bank sync stays disabled." >&2
  else
    export ENABLE_BANKING_APP_ID
    export ENABLE_BANKING_REDIRECT_URL
    export ENABLE_BANKING_PRIVATE_KEY_FILE
  fi
fi

# A key pasted into the old inline option would still be sitting in
# options.json. Say so — it needs rotating, not just removing.
if [ -n "${ENABLE_BANKING_PRIVATE_KEY:-}" ]; then
  echo "Sampolio: the enable_banking_private_key option is no longer used." >&2
  echo "Sampolio: that key was stored in plain text in options.json — treat it as exposed, issue a new one at" >&2
  echo "Sampolio: enablebanking.com, put the PEM in /ssl, and set enable_banking_private_key_file instead." >&2
fi

# Remove a PEM written to the data directory by an earlier version, so the
# key does not linger in Home Assistant backups after the switch to /ssl.
if [ -f "$DATA_DIR/enable_banking_private_key.pem" ]; then
  rm -f "$DATA_DIR/enable_banking_private_key.pem"
  echo "Sampolio: removed the private key an earlier version had copied into the data directory." >&2
fi

if [ -n "${HA_WEBHOOK_URL:-}" ]; then
  export HA_WEBHOOK_URL
fi

PORT="${PORT:-3999}"
NEXT_INTERNAL_PORT="${NEXT_INTERNAL_PORT:-3998}"

# Optional embedded Tailscale — only runs when tailscale_auth_key is set.
# Joins this container as its own tailnet device (separate from any
# standalone Tailscale add-on and its "svc:sampolio" Service — hostname is
# deliberately distinct below to avoid colliding with that name). State is
# persisted under /data so it doesn't need re-approval on every restart.
# Clear tailscale_auth_key entirely to disable this whole block and fall
# back to whatever Tailscale connectivity is set up separately.
#
# --tun=userspace-networking is load-bearing for security, not a detail. In
# normal TUN mode tailscaled gives the container a tailnet IP and hands
# inbound tailnet packets to its kernel stack, which makes EVERY port bound
# in this container reachable by every device on the tailnet — with no Home
# Assistant login in front of it. That would silently reopen exactly the
# bypass `ingress: true` exists to close, just from setting an auth key.
# Userspace mode terminates inbound traffic inside tailscaled instead, so
# only what `tailscale serve`/`funnel` explicitly publishes is reachable.
# It also means no TUN device and no NET_ADMIN are needed at all (see
# config.yaml, which requests neither).
#
# The state/socket paths below are overridable for the same reason as
# OPTIONS_FILE — so src/test/run-sh.test.ts can run this block against stubs
# without needing /data and /var/run. In the container they are the defaults.
TAILSCALE_STATE_DIR="${TAILSCALE_STATE_DIR:-/data/tailscale}"
TAILSCALE_SOCKET="${TAILSCALE_SOCKET:-/var/run/tailscale/tailscaled.sock}"

if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  mkdir -p "$TAILSCALE_STATE_DIR" "$(dirname "$TAILSCALE_SOCKET")"
  tailscaled \
    --tun=userspace-networking \
    --state="$TAILSCALE_STATE_DIR/tailscaled.state" \
    --socket="$TAILSCALE_SOCKET" \
    >"$TAILSCALE_STATE_DIR/tailscaled.log" 2>&1 &

  for i in $(seq 1 30); do
    [ -S "$TAILSCALE_SOCKET" ] && break
    sleep 1
  done

  tailscale --socket="$TAILSCALE_SOCKET" up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --hostname=sampolio-callback \
    --accept-dns=false

  # Serve and Funnel are configured from scratch on every start. Both persist
  # in tailscaled's state file, and that state lives under /data so it
  # survives restarts — so "stop setting it" is not the same as "turn it off",
  # and an older or wider mount left by a previous version would otherwise
  # survive underneath whatever is set below.
  tailscale --socket="$TAILSCALE_SOCKET" serve reset 2>/dev/null || true
  tailscale --socket="$TAILSCALE_SOCKET" funnel 443 off 2>/dev/null || true

  # tailscale_serve: the whole app on :8443, reachable from your tailnet only.
  # This is the recommended way in, and it is what makes the published port
  # unnecessary. It is HTTPS with a real certificate, which also means the
  # session cookie keeps its Secure attribute — over plain http:// on a LAN
  # address the browser discards it and sign-in silently never sticks.
  if [ "${TAILSCALE_SERVE:-true}" = "true" ]; then
    tailscale --socket="$TAILSCALE_SOCKET" serve --bg --https=8443 \
      "http://127.0.0.1:$PORT"
  fi

  # tailscale_funnel: ONE path on :443, reachable from the public internet —
  # the bank's PSD2 consent redirect, which has to land from outside the
  # tailnet. Funnel makes the whole PORT public (Tailscale cannot mix
  # tailnet-only Serve and public Funnel on one port), so the scoping comes
  # from this being the only path with a backend behind it. AllowFunnel is
  # keyed per host AND port, so the :8443 mount above is not promoted.
  #
  # Serving the app on :8443 is load-bearing for this flow, not a
  # convenience: the callback needs an authenticated session, and the session
  # cookie is host-only, so it reaches the callback only if it was set on this
  # same hostname. Cookies ignore the port (RFC 6265 §5.1.3), so a session
  # established on :8443 is sent with the bank's redirect to :443.
  if [ "${TAILSCALE_FUNNEL:-}" = "true" ]; then
    if [ "${TAILSCALE_SERVE:-true}" != "true" ]; then
      echo "Sampolio: tailscale_funnel is on but tailscale_serve is off." >&2
      echo "Sampolio: the bank callback needs a session cookie set on the same hostname, so link your bank with both on." >&2
    fi
    tailscale --socket="$TAILSCALE_SOCKET" funnel --bg \
      --set-path=/api/bank/callback "http://127.0.0.1:$PORT/api/bank/callback"
  fi
fi

# Next.js listens on loopback only; the Home Assistant Ingress rewriting
# proxy (ha-ingress-proxy.mjs) takes the actual $PORT Supervisor and
# Tailscale Funnel connect to. See that file for why the proxy is needed —
# short version: Next.js's root-absolute asset/link paths don't survive
# being served under Ingress's per-restart-rotating path prefix without it.
# 127.0.0.1, not 0.0.0.0: nothing but the proxy in this same container ever
# talks to Next.js directly, so binding it wider would only expose an
# unrewritten, unproxied copy of the app to the add-on network.
node node_modules/next/dist/bin/next start -p "$NEXT_INTERNAL_PORT" -H 127.0.0.1 &

node -e "
  const net = require('net');
  const port = process.argv[1];
  const tryConnect = (attempt) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => {
      if (attempt >= 30) process.exit(1);
      setTimeout(() => tryConnect(attempt + 1), 1000);
    });
  };
  tryConnect(0);
" "$NEXT_INTERNAL_PORT"

export PROXY_PORT="$PORT"
export NEXT_INTERNAL_PORT
exec node /ha-ingress-proxy.mjs
