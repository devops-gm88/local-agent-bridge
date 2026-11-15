#!/usr/bin/env bash
# One command for the phone. Stops any old server, mints a fresh token, binds to the
# Wi-Fi address, opens the Mac browser, and prints the URL for the phone.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${PORT:-8787}"
IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [ -z "$IP" ]; then
  echo "No Wi-Fi address found on en0. Connect to Wi-Fi, or use Tailscale: HOST=<ip> npm run serve"
  exit 1
fi

# A persistent token, so the Home Screen link survives restarts. `--rotate` makes a new one.
mkdir -p state
if [ "${1:-}" = "--rotate" ] || [ ! -s state/token ]; then
  openssl rand -hex 16 > state/token
  chmod 600 state/token
fi
export BRIDGE_TOKEN="$(cat state/token)"

# Stop whatever is holding the port, so `npm run phone` is always safe to re-run.
if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 0.5
fi

HOST="$IP" PORT="$PORT" nohup node server.js > /tmp/local-agent.log 2>&1 &
sleep 2

URL="http://$IP:$PORT/?t=$BRIDGE_TOKEN"
TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
printf '\n  open on the phone:  http://%s:%s\n' "$IP" "$PORT"
if [ -n "$TAILNET_IP" ]; then
  printf '  tailnet (works off-network): http://%s:%s/?t=%s\n' "$TAILNET_IP" "$PORT" "$BRIDGE_TOKEN"
  printf '  (the tailnet link needs the service bound to 0.0.0.0: run ./install-service.sh)\n'
fi
printf '  token:              %s\n' "$BRIDGE_TOKEN"
printf '  (type the short address, then paste the token — no 64-character URL needed)\n'
printf '  direct link:        %s\n' "$URL"
printf '  then: Share -> Add to Home Screen\n'

# Copy the full link, so Universal Clipboard can paste it on the phone.
printf '%s' "$URL" | pbcopy 2>/dev/null && printf "  full link copied to this Mac's clipboard - paste it on the phone\n"

# A QR is the fastest route: point the phone camera at it, tap the banner.
if [ -x "$PWD/.qrenv/bin/python" ]; then
  printf '  or scan this with the phone camera:\n\n'
  "$PWD/.qrenv/bin/python" - "$URL" <<'PYQR'
import sys, segno
segno.make(sys.argv[1], error='m').terminal(compact=True)
PYQR
  printf '\n'
fi
printf '  log: /tmp/local-agent.log   stop: lsof -tiTCP:%s | xargs kill\n\n' "$PORT"
[ -n "${NO_OPEN:-}" ] || open "$URL"
