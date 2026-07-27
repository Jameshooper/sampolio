#!/usr/bin/env bash
# Shared helper: activate the Node.js version pinned in the repo's .nvmrc.
#
# Usage:
#   source "<repo>/scripts/lib-node.sh"
#   sampolio_activate_node "<repo_root>"
#
# Best-effort: tries fnm, nvm, mise, then asdf to install/select the version.
# Whatever happens, it ENDS by verifying that the active `node` matches the
# major version in .nvmrc, and returns non-zero (with guidance) if it doesn't.
# This is intentionally strict: the app is built and tested against one Node
# major, and silently running a different one is how subtle breakage sneaks in.

sampolio__read_nvmrc() {
  local f="$1/.nvmrc"
  [ -f "$f" ] || return 1
  # Strip whitespace/newlines; accepts "v24", "24", "24.14.0", "lts/*", etc.
  tr -d ' \t\r\n' < "$f"
}

sampolio_activate_node() {
  local repo_root="$1"
  local desired desired_major current_major had_e had_u

  # Version managers (esp. nvm) misbehave under `set -e`/`set -u`; relax while
  # we poke at them, then restore the caller's shell options before verifying.
  case "$-" in *e*) had_e=1 ;; *) had_e=0 ;; esac
  case "$-" in *u*) had_u=1 ;; *) had_u=0 ;; esac
  set +eu

  desired="$(sampolio__read_nvmrc "$repo_root" 2>/dev/null || true)"
  if [ -z "$desired" ]; then
    echo "lib-node: no .nvmrc in $repo_root — leaving the current node as-is." >&2
    if [ "$had_u" = 1 ]; then set -u; fi
    if [ "$had_e" = 1 ]; then set -e; fi
    command -v node >/dev/null 2>&1
    return $?
  fi
  desired_major="${desired#v}"
  desired_major="${desired_major%%.*}"

  if command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env 2>/dev/null)" || true
    fnm install "$desired" >/dev/null 2>&1 || true
    fnm use "$desired" >/dev/null 2>&1 || true
  elif [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    nvm install "$desired" >/dev/null 2>&1 || true
    nvm use "$desired" >/dev/null 2>&1 || true
  elif command -v mise >/dev/null 2>&1; then
    ( cd "$repo_root" && mise install "node@${desired_major}" ) >/dev/null 2>&1 || true
    eval "$(mise env -s bash 2>/dev/null)" || true
  elif command -v asdf >/dev/null 2>&1; then
    asdf install nodejs "latest:${desired_major}" >/dev/null 2>&1 || true
  fi

  if [ "$had_u" = 1 ]; then set -u; fi
  if [ "$had_e" = 1 ]; then set -e; fi

  if ! command -v node >/dev/null 2>&1; then
    echo "lib-node: ERROR — no 'node' on PATH after activation attempt." >&2
    return 1
  fi

  current_major="$(node -v | sed 's/^v//; s/\..*//')"
  if [ "$current_major" != "$desired_major" ]; then
    echo "lib-node: ERROR — .nvmrc requires Node ${desired_major}.x (\"${desired}\") but the active node is $(node -v)." >&2
    echo "          No version manager picked it up automatically. Install/activate it, e.g.:" >&2
    echo "            fnm install ${desired} && fnm use ${desired}" >&2
    echo "            nvm install ${desired} && nvm use ${desired}" >&2
    return 1
  fi
  return 0
}
