#!/usr/bin/env bash
#
# Sampolio — deploy in place from a git clone.
#
# This replaces the build-package -> zip -> copy -> unzip -> install dance.
# Clone the repo on the server once, then run this after every `git pull`:
#
#   ./scripts/server-deploy.sh           # install deps + build the current checkout
#   ./scripts/server-deploy.sh --pull    # `git pull --ff-only` first, then install + build
#   ./scripts/server-deploy.sh --run      # also start the server (foreground) when done
#
# It pins the Node.js version from .nvmrc and runs the app with `next start`
# against the real node_modules, which avoids the standalone-bundle tracing
# issues that broke the packaged build.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# Build into the prod-isolated dir so a parallel `next dev` (which uses .next)
# can never clobber what `next start` serves. The launchd plist sets the same
# value at runtime; override by exporting NEXT_DIST_DIR before invoking.
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}"

DO_PULL=0
DO_RUN=0
for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=1 ;;
    --run)  DO_RUN=1 ;;
    -h|--help)
      sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo -e "${RED}Unknown option: $arg${NC}"; exit 2 ;;
  esac
done

echo -e "${YELLOW}=== Sampolio deploy (git, in place) ===${NC}"
echo "Repo: $REPO_ROOT"
echo ""

if [ "$DO_PULL" -eq 1 ]; then
  echo -e "${YELLOW}Pulling latest changes...${NC}"
  git pull --ff-only
  echo ""
fi

# --- Node.js version ---------------------------------------------------------
echo -e "${YELLOW}Activating Node.js from .nvmrc...${NC}"
# shellcheck source=lib-node.sh
. "$SCRIPT_DIR/lib-node.sh"
sampolio_activate_node "$REPO_ROOT"
echo -e "${GREEN}Node.js: $(node -v)${NC}"

# --- pnpm --------------------------------------------------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo -e "${YELLOW}pnpm not found — enabling it via corepack...${NC}"
    corepack enable pnpm >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo -e "${RED}Error: pnpm is not installed.${NC}"
  echo "Install it with one of:  corepack enable pnpm   |   npm i -g pnpm"
  exit 1
fi
echo -e "${GREEN}pnpm: $(pnpm -v)${NC}"
echo ""

# --- Install + build ---------------------------------------------------------
echo -e "${YELLOW}Step 1/2: Installing dependencies (frozen lockfile)...${NC}"
pnpm install --frozen-lockfile

echo -e "${YELLOW}Step 2/2: Building the application...${NC}"
pnpm build

echo ""
echo -e "${GREEN}=== Build complete ===${NC}"
echo ""
echo "Start it now (foreground):   ./scripts/run-sampolio.sh"
echo "Install auto-start (login):  ./scripts/install-launchd.sh"
echo ""

if [ "$DO_RUN" -eq 1 ]; then
  exec "$SCRIPT_DIR/run-sampolio.sh"
fi
