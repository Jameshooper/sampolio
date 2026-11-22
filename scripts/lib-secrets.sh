#!/usr/bin/env bash
# Shared helper: resolve AUTH_SECRET and ENCRYPTION_KEY for the launch scripts.
#
# Usage:
#   source "<repo>/scripts/lib-secrets.sh"
#   sampolio_load_secrets "<data_dir>" || exit 1
#
# Precedence for each secret: the environment (e.g. from .env), then the
# secrets directory (SAMPOLIO_SECRETS_DIR, default ~/.sampolio/secrets), then
# the legacy location inside the data directory (<data_dir>/.auth_secret,
# <data_dir>/.encryption_key) so existing installs keep working unchanged.
#
# New secrets are written to the secrets directory, which is deliberately
# OUTSIDE the data directory: copying or backing up the data directory then no
# longer copies the key that decrypts it. Back the key up separately.
#
# ENCRYPTION_KEY is never generated when encrypted data already exists — a new
# key cannot read it. The script stops and explains instead.

sampolio__write_secret() {
  # umask in a subshell so the file is created 0600 (no world-readable window).
  ( umask 077 && printf '%s\n' "$2" > "$1" )
  chmod 600 "$1"
}

sampolio_load_secrets() {
  local data_dir="$1"
  local secrets_dir="${SAMPOLIO_SECRETS_DIR:-$HOME/.sampolio/secrets}"
  ( umask 077 && mkdir -p "$secrets_dir" )
  chmod 700 "$secrets_dir"

  if [ -z "${AUTH_SECRET:-}" ]; then
    if [ -f "$secrets_dir/auth_secret" ]; then
      AUTH_SECRET="$(cat "$secrets_dir/auth_secret")"
    elif [ -f "$data_dir/.auth_secret" ]; then
      AUTH_SECRET="$(cat "$data_dir/.auth_secret")"
    else
      AUTH_SECRET="$(openssl rand -base64 32)"
      sampolio__write_secret "$secrets_dir/auth_secret" "$AUTH_SECRET"
      echo "Generated new AUTH_SECRET in $secrets_dir/auth_secret"
    fi
  fi

  if [ -z "${ENCRYPTION_KEY:-}" ]; then
    if [ -f "$secrets_dir/encryption_key" ]; then
      ENCRYPTION_KEY="$(cat "$secrets_dir/encryption_key")"
    elif [ -f "$data_dir/.encryption_key" ]; then
      ENCRYPTION_KEY="$(cat "$data_dir/.encryption_key")"
      echo "Note: ENCRYPTION_KEY is read from $data_dir/.encryption_key (inside the data directory)."
      echo "      Move it to $secrets_dir/encryption_key so data backups don't carry the key (see docs/operations.md)."
    elif [ -n "$(find "$data_dir" -name '*.enc' -print -quit 2>/dev/null)" ]; then
      echo "Error: $data_dir contains encrypted data but no ENCRYPTION_KEY was found" >&2
      echo "       (env, $secrets_dir/encryption_key, or $data_dir/.encryption_key)." >&2
      echo "       Refusing to generate a new key — it could not decrypt the existing data." >&2
      echo "       Restore the original key file and run this again." >&2
      return 1
    else
      ENCRYPTION_KEY="$(openssl rand -hex 32)"
      sampolio__write_secret "$secrets_dir/encryption_key" "$ENCRYPTION_KEY"
      echo "Generated new ENCRYPTION_KEY in $secrets_dir/encryption_key — back this file up separately from the data."
    fi
  fi

  export AUTH_SECRET ENCRYPTION_KEY
}
