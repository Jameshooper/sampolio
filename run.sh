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

OPTIONS_FILE="/data/options.json"

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
  ENABLE_BANKING_PRIVATE_KEY="${ENABLE_BANKING_PRIVATE_KEY:-$(get_option enable_banking_private_key)}"
  HA_WEBHOOK_URL="${HA_WEBHOOK_URL:-$(get_option ha_webhook_url)}"
  TAILSCALE_AUTHKEY="${TAILSCALE_AUTHKEY:-$(get_option tailscale_auth_key)}"
  TAILSCALE_FUNNEL="${TAILSCALE_FUNNEL:-$(get_option tailscale_funnel)}"
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

if [ -n "${ENABLE_BANKING_APP_ID:-}" ] && [ -n "${ENABLE_BANKING_REDIRECT_URL:-}" ] && [ -n "${ENABLE_BANKING_PRIVATE_KEY:-}" ]; then
  export ENABLE_BANKING_APP_ID
  export ENABLE_BANKING_REDIRECT_URL
  KEY_FILE="/data/enable_banking_private_key.pem"
  printf '%s' "$ENABLE_BANKING_PRIVATE_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  export ENABLE_BANKING_PRIVATE_KEY_FILE="$KEY_FILE"
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
if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled \
    --tun=userspace-networking \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    >/data/tailscale/tailscaled.log 2>&1 &

  for i in $(seq 1 30); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done

  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --hostname=sampolio-callback \
    --accept-dns=false

  # tailscale_funnel exposes ONLY /api/bank/callback to the public internet
  # — never the whole app. `serve --set-path` maps just that one route on
  # port 443; `funnel 443 on` then promotes whatever `serve` already exposes
  # on that port, so anything not explicitly mapped (the login page, every
  # other route) stays unreachable from outside the tailnet. Off by default.
  # Targets $PORT (the ingress-proxy below), not Next.js directly — the
  # proxy passes non-ingress requests straight through unmodified, so this
  # behaves identically to hitting Next.js itself.
  if [ "${TAILSCALE_FUNNEL:-}" = "true" ]; then
    tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg \
      --set-path=/api/bank/callback "http://127.0.0.1:$PORT/api/bank/callback"
    tailscale --socket=/var/run/tailscale/tailscaled.sock funnel --bg 443 on
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
