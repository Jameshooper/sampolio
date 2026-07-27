#!/bin/bash

# Sampolio launchd Uninstallation Script
# Removes Sampolio from macOS auto-start

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
PLIST_NAME="com.sampolio.app"
PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo -e "${YELLOW}=== Sampolio Auto-Start Uninstallation ===${NC}"
echo ""

# Check if installed
if [ ! -f "$PLIST_FILE" ]; then
    echo -e "${YELLOW}Sampolio is not installed as a launch agent.${NC}"
    exit 0
fi

# Stop the service
echo "Stopping Sampolio service..."
launchctl unload "$PLIST_FILE" 2>/dev/null || true

# Remove the plist file
echo "Removing launch agent configuration..."
rm -f "$PLIST_FILE"

echo ""
echo -e "${GREEN}=== Uninstallation Complete! ===${NC}"
echo ""
echo "Sampolio has been removed from auto-start."
echo ""
echo "Note: Your data is preserved at: ~/.sampolio/data/"
echo "      Logs are preserved at: ~/.sampolio/logs/"
echo ""
echo "To remove all data, run: rm -rf ~/.sampolio"
