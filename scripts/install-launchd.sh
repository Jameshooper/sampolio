#!/bin/bash

# Sampolio launchd Installation Script
# Runs the app automatically on macOS login, via `next start` from this git clone.
# Build first with ./scripts/server-deploy.sh, then run this.
#
# The Node.js binary path is resolved at install time (honoring .nvmrc) and baked
# into the plist, so launchd uses the intended version without depending on an
# interactive shell or version manager at boot.

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
PLIST_NAME="com.sampolio.app"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$HOME/.sampolio/logs"
DATA_DIR="$HOME/.sampolio/data"
PORT="${SAMPOLIO_PORT:-3999}"
HOST="${SAMPOLIO_HOST:-0.0.0.0}"
# Build dir prod serves — isolated from dev's `.next` (see next.config.ts). Baked
# into the plist below so `next start` reads the same dir server-deploy.sh built.
NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}"

echo -e "${YELLOW}=== Sampolio Auto-Start Installation ===${NC}"
echo ""

# --- Resolve the Node.js binary to bake into the plist -----------------------
# shellcheck source=lib-node.sh
. "$SCRIPT_DIR/lib-node.sh"
sampolio_activate_node "$REPO_ROOT"

# process.execPath is the real, stable install path (not an ephemeral shell shim)
NODE_PATH="$(node -e 'process.stdout.write(process.execPath)')"
if [ -z "$NODE_PATH" ] || [ ! -x "$NODE_PATH" ]; then
    echo -e "${RED}Error: could not resolve a usable Node.js binary path.${NC}"
    exit 1
fi
NODE_BIN_DIR="$(dirname "$NODE_PATH")"

echo "Node.js:                $($NODE_PATH -v) ($NODE_PATH)"
echo "Installation directory: $REPO_ROOT"
echo ""

# Make sure the app is installed and built
if [ ! -f "$REPO_ROOT/node_modules/next/dist/bin/next" ] || [ ! -f "$REPO_ROOT/$NEXT_DIST_DIR/BUILD_ID" ]; then
    echo -e "${RED}Error: app isn't installed/built. Run ./scripts/server-deploy.sh first.${NC}"
    exit 1
fi

# Create log and data directories
mkdir -p "$LOG_DIR"
mkdir -p "$DATA_DIR"

# Check if already installed
if [ -f "$PLIST_FILE" ]; then
    echo -e "${YELLOW}Existing installation found. Updating...${NC}"
    launchctl unload "$PLIST_FILE" 2>/dev/null || true
fi

# Load .env file if it exists
if [ -f "$REPO_ROOT/.env" ]; then
    echo -e "${GREEN}Loading environment variables from .env file...${NC}"
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
fi

# Read or generate AUTH_SECRET
if [ -z "$AUTH_SECRET" ]; then
    CONFIG_FILE="$DATA_DIR/.auth_secret"
    if [ -f "$CONFIG_FILE" ]; then
        AUTH_SECRET=$(cat "$CONFIG_FILE")
    else
        AUTH_SECRET=$(openssl rand -base64 32)
        echo "$AUTH_SECRET" > "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
    fi
fi

# Read or generate ENCRYPTION_KEY
if [ -z "$ENCRYPTION_KEY" ]; then
    ENCRYPTION_CONFIG_FILE="$DATA_DIR/.encryption_key"
    if [ -f "$ENCRYPTION_CONFIG_FILE" ]; then
        ENCRYPTION_KEY=$(cat "$ENCRYPTION_CONFIG_FILE")
    else
        ENCRYPTION_KEY=$(openssl rand -hex 32)
        echo "$ENCRYPTION_KEY" > "$ENCRYPTION_CONFIG_FILE"
        chmod 600 "$ENCRYPTION_CONFIG_FILE"
    fi
fi

# Persist or restore AUTH_URL
AUTH_URL_CONFIG_FILE="$DATA_DIR/.auth_url"
if [ -n "$AUTH_URL" ]; then
    echo "$AUTH_URL" > "$AUTH_URL_CONFIG_FILE"
    chmod 600 "$AUTH_URL_CONFIG_FILE"
elif [ -f "$AUTH_URL_CONFIG_FILE" ]; then
    AUTH_URL=$(cat "$AUTH_URL_CONFIG_FILE")
fi

# Create the LaunchAgents directory if it doesn't exist
mkdir -p "$HOME/Library/LaunchAgents"

# Create the plist file
cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${REPO_ROOT}/node_modules/next/dist/bin/next</string>
        <string>start</string>
        <string>-p</string>
        <string>${PORT}</string>
        <string>-H</string>
        <string>${HOST}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${NODE_BIN_DIR}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>PORT</key>
        <string>${PORT}</string>
        <key>HOSTNAME</key>
        <string>${HOST}</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>DATA_DIR</key>
        <string>${DATA_DIR}</string>
        <key>NEXT_DIST_DIR</key>
        <string>${NEXT_DIST_DIR}</string>
        <key>AUTH_SECRET</key>
        <string>${AUTH_SECRET}</string>
        <key>ENCRYPTION_KEY</key>
        <string>${ENCRYPTION_KEY}</string>
        <key>AUTH_TRUST_HOST</key>
        <string>true</string>${ENABLE_BANKING_APP_ID:+
        <key>ENABLE_BANKING_APP_ID</key>
        <string>${ENABLE_BANKING_APP_ID}</string>}${ENABLE_BANKING_REDIRECT_URL:+
        <key>ENABLE_BANKING_REDIRECT_URL</key>
        <string>${ENABLE_BANKING_REDIRECT_URL}</string>}${ENABLE_BANKING_PRIVATE_KEY_FILE:+
        <key>ENABLE_BANKING_PRIVATE_KEY_FILE</key>
        <string>${ENABLE_BANKING_PRIVATE_KEY_FILE}</string>}${ENABLE_BANKING_BASE_URL:+
        <key>ENABLE_BANKING_BASE_URL</key>
        <string>${ENABLE_BANKING_BASE_URL}</string>}${HA_WEBHOOK_URL:+
        <key>HA_WEBHOOK_URL</key>
        <string>${HA_WEBHOOK_URL}</string>}${AUTH_URL:+
        <key>AUTH_URL</key>
        <string>${AUTH_URL}</string>}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/sampolio.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/sampolio-error.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

# Set proper permissions
chmod 644 "$PLIST_FILE"

# Load the launch agent
launchctl load "$PLIST_FILE"

echo -e "${GREEN}=== Installation Complete! ===${NC}"
echo ""
echo "Sampolio has been installed and is now running!"
echo ""
echo "  Web Interface: http://localhost:${PORT}"
echo "  Logs:          $LOG_DIR/sampolio.log"
echo "  Data:          $DATA_DIR"
echo ""
echo "The app will automatically start when you log in."
echo ""
echo "To check status:   launchctl list | grep sampolio"
echo "To stop:           launchctl unload $PLIST_FILE"
echo "To start:          launchctl load $PLIST_FILE"
echo "To uninstall:      ./scripts/uninstall-launchd.sh"
