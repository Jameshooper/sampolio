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

# Optional embedded Tailscale — only runs when tailscale_auth_key is set.
# Joins this container as its own tailnet device (separate from any
# standalone Tailscale add-on), state persisted under /data so it doesn't
# need re-approval on every restart. tailscale_funnel additionally exposes
# $PORT to the public internet via Tailscale Funnel — off by default; clear
# tailscale_auth_key entirely to disable this whole block and fall back to
# whatever Tailscale connectivity is set up separately (e.g. a standalone
# Tailscale add-on's Services config).
if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    >/data/tailscale/tailscaled.log 2>&1 &

  for i in $(seq 1 30); do
    [ -S /var/run/tailscale/tailscaled.sock ] && break
    sleep 1
  done

  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="$TAILSCALE_AUTHKEY" \
    --hostname=sampolio \
    --accept-dns=false

  if [ "${TAILSCALE_FUNNEL:-}" = "true" ]; then
    tailscale --socket=/var/run/tailscale/tailscaled.sock funnel --bg "$PORT"
  fi
fi

exec node node_modules/next/dist/bin/next start -p "$PORT" -H 0.0.0.0
