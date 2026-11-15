#!/usr/bin/env bash
# Print the phone link for Shotty using the stable token. Starts nothing, changes nothing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-8787}"
TOKEN="$(cat state/token 2>/dev/null || true)"
[ -n "$TOKEN" ] || { echo "No token at state/token — run ./install-service.sh first."; exit 1; }

TSIP="$(/usr/local/bin/tailscale ip -4 2>/dev/null || true)"
LANIP="$(ipconfig getifaddr en0 2>/dev/null || true)"
HOSTIP="${TSIP:-$LANIP}"
[ -n "$HOSTIP" ] || { echo "No Tailscale or Wi-Fi address found."; exit 1; }

CODEPATH="$(curl -s -o /dev/null -m 4 -w '%{http_code}' "http://$HOSTIP:$PORT/" || echo 000)"
if [ "$CODEPATH" = "000" ]; then
  echo "Shotty is not answering on $HOSTIP:$PORT."
  echo "Start it with:  launchctl kickstart -k gui/$(id -u)/ca.localagent.bridge"
  exit 1
fi

URL="http://$HOSTIP:$PORT/?t=$TOKEN"
printf '\n  Shotty\n  ──────\n'
printf '  Open on the phone:  http://%s:%s\n' "$HOSTIP" "$PORT"
printf '  Token:              %s\n' "$TOKEN"
printf '  Full link:          %s\n' "$URL"
[ -n "$TSIP" ] && printf '  Works:              anywhere (Tailscale)\n' || printf '  Works:              same Wi-Fi only\n'
printf '%s' "$URL" | pbcopy 2>/dev/null && printf '  (link copied to this Mac clipboard)\n'
if [ -x "$PWD/.qrenv/bin/python" ]; then
  printf '\n  or scan this with the phone camera:\n\n'
  "$PWD/.qrenv/bin/python" - "$URL" <<'PYQR'
import sys, segno
segno.make(sys.argv[1], error='m').terminal(compact=True)
PYQR
  printf '\n'
fi
