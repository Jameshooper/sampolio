#!/bin/bash

# Sampolio Run Script
# Starts the app in the foreground from a git clone built in place.
# Build first with ./scripts/server-deploy.sh, then run this.

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# Configuration
PORT="${SAMPOLIO_PORT:-3999}"
HOST="${SAMPOLIO_HOST:-0.0.0.0}"
DATA_DIR="${SAMPOLIO_DATA_DIR:-$HOME/.sampolio/data}"
# Serve the prod-isolated build dir (matches the launchd plist + server-deploy.sh)
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}"

# --- Node.js version (from .nvmrc) -------------------------------------------
# shellcheck source=lib-node.sh
. "$SCRIPT_DIR/lib-node.sh"
sampolio_activate_node "$REPO_ROOT"

# Make sure the app is installed and built
if [ ! -f "$REPO_ROOT/node_modules/next/dist/bin/next" ]; then
    echo -e "${RED}Error: Next.js isn't installed. Run ./scripts/server-deploy.sh first.${NC}"
    exit 1
fi
if [ ! -f "$REPO_ROOT/$NEXT_DIST_DIR/BUILD_ID" ]; then
    echo -e "${RED}Error: no production build found ($NEXT_DIST_DIR/BUILD_ID missing). Run ./scripts/server-deploy.sh first.${NC}"
    exit 1
fi

# Create data directory if it doesn't exist
mkdir -p "$DATA_DIR"

# Load .env file if it exists
if [ -f "$REPO_ROOT/.env" ]; then
    echo -e "${GREEN}Loading environment variables from .env file...${NC}"
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# Generate a random AUTH_SECRET if not set
if [ -z "$AUTH_SECRET" ]; then
    CONFIG_FILE="$DATA_DIR/.auth_secret"
    if [ -f "$CONFIG_FILE" ]; then
        export AUTH_SECRET=$(cat "$CONFIG_FILE")
    else
        export AUTH_SECRET=$(openssl rand -base64 32)
        echo "$AUTH_SECRET" > "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
        echo -e "${YELLOW}Generated new AUTH_SECRET (saved for future runs)${NC}"
    fi
fi

# Generate a random ENCRYPTION_KEY if not set
if [ -z "$ENCRYPTION_KEY" ]; then
    ENCRYPTION_CONFIG_FILE="$DATA_DIR/.encryption_key"
    if [ -f "$ENCRYPTION_CONFIG_FILE" ]; then
        export ENCRYPTION_KEY=$(cat "$ENCRYPTION_CONFIG_FILE")
    else
        export ENCRYPTION_KEY=$(openssl rand -hex 32)
        echo "$ENCRYPTION_KEY" > "$ENCRYPTION_CONFIG_FILE"
        chmod 600 "$ENCRYPTION_CONFIG_FILE"
        echo -e "${YELLOW}Generated new ENCRYPTION_KEY (saved for future runs)${NC}"
    fi
fi

# Persist or restore AUTH_URL (needed for correct redirects behind a reverse proxy)
AUTH_URL_CONFIG_FILE="$DATA_DIR/.auth_url"
if [ -n "$AUTH_URL" ]; then
    echo "$AUTH_URL" > "$AUTH_URL_CONFIG_FILE"
    chmod 600 "$AUTH_URL_CONFIG_FILE"
elif [ -f "$AUTH_URL_CONFIG_FILE" ]; then
    export AUTH_URL=$(cat "$AUTH_URL_CONFIG_FILE")
fi

echo -e "${GREEN}=== Starting Sampolio ===${NC}"
echo ""
echo "  Node: $(node -v)"
echo "  Port: $PORT"
echo "  Data: $DATA_DIR"
echo ""
echo -e "${GREEN}Open your browser at: http://localhost:$PORT${NC}"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Set environment variables for the app
export PORT="$PORT"
export HOSTNAME="$HOST"
export DATA_DIR="$DATA_DIR"
export NODE_ENV="production"
export AUTH_TRUST_HOST="true"

# Set AUTH_URL if provided (needed for correct redirects behind a reverse proxy)
if [ -n "$AUTH_URL" ]; then
    export AUTH_URL
    echo "  URL:  $AUTH_URL"
fi

# Start the Next.js production server
exec node "$REPO_ROOT/node_modules/next/dist/bin/next" start -p "$PORT" -H "$HOST"
