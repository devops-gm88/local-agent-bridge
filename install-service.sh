#!/usr/bin/env bash
# Install the agent as a macOS LaunchAgent: starts at login, restarts if it dies,
# survives closing the terminal, and keeps a stable token so the Home Screen link works.
set -euo pipefail
BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="ca.localagent.bridge"
PLIST_DIR="${PLIST_DIR:-$HOME/Library/LaunchAgents}"
PLIST="$PLIST_DIR/$LABEL.plist"
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH"; exit 1; }

mkdir -p "$BRIDGE/state" "$PLIST_DIR"
# Stable token: reused every launch, so the phone URL does not change.
[ -s "$BRIDGE/state/token" ] || { openssl rand -hex 16 > "$BRIDGE/state/token"; chmod 600 "$BRIDGE/state/token"; }
TOKEN="$(cat "$BRIDGE/state/token")"
NAME="$(cat "$BRIDGE/state/name" 2>/dev/null || echo 'Agent')"
# The address that works off-LAN. The phone page shows it when an old origin goes stale.
TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
TAILNET_URL="http://${TAILNET_IP:-127.0.0.1}:8787"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$BRIDGE/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE</string>
  <key>EnvironmentVariables</key><dict>
    <key>BRIDGE_TOKEN</key><string>$TOKEN</string>
    <key>AGENT_NAME</key><string>$NAME</string>
    <key>HOST</key><string>0.0.0.0</string>
    <key>PORT</key><string>8787</string>
    <key>TAILNET_URL</key><string>$TAILNET_URL</string>
    <key>EOD_SUMMARY_HOUR</key><string>18</string>
    <key>MAX_TOOL_STEPS</key><string>6</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/local-agent.log</string>
  <key>StandardErrorPath</key><string>/tmp/local-agent.log</string>
</dict></plist>
EOF

# Free the port from any manual run, then (re)start the service.
lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
sleep 0.5
if [ -z "${DRY_RUN:-}" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
printf '\n  %s installed%s\n' "$LABEL" "${DRY_RUN:+ (dry run — plist written, not loaded)}"
printf '  phone:  http://%s:8787   (same Wi-Fi)\n' "$IP"
printf '  tailnet: %s   (use this one off-network)\n' "$TAILNET_URL"
printf '  token:  %s\n' "$TOKEN"
printf '  name:   %s   (change: echo Scout > state/name, then reinstall)\n' "$NAME"
printf '  log:    /tmp/local-agent.log\n'
printf '  stop:   launchctl bootout gui/%s/%s\n' "$(id -u)" "$LABEL"
printf '  remove: ./uninstall-service.sh\n\n'
