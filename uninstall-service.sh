#!/usr/bin/env bash
set -euo pipefail
LABEL="ca.localagent.bridge"
PLIST_DIR="${PLIST_DIR:-$HOME/Library/LaunchAgents}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DIR/$LABEL.plist"
lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
echo "removed $LABEL"
