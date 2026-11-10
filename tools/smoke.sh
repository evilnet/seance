#!/bin/sh
# CI's smoke check, runnable locally (make web-test): serve the built public/
# on a port of its own (SMOKE_PORT, default 8790), run tools/scenarios/smoke.mjs in
# Chromium ($CHROME_BIN, else one found on PATH, in /Applications or from
# Playwright), stop the server.
set -eu
cd "$(dirname "$0")/.."
SMOKE_PORT="${SMOKE_PORT:-8790}"
URL="http://127.0.0.1:$SMOKE_PORT/"
answers() { node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' "$URL"; }

[ -f public/index.html ] || { echo "smoke: public/ is not built (make web-build)" >&2; exit 1; }

if [ -z "${CHROME_BIN:-}" ]; then
	for bin in chromium google-chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
		if command -v "$bin" >/dev/null 2>&1; then CHROME_BIN="$bin"; break; fi
	done
fi
: "${CHROME_BIN:=$(node -e 'console.log(require("@playwright/test").chromium.executablePath())')}"
export CHROME_BIN

# Something already on the port would be the one tested.
if answers; then echo "smoke: port $SMOKE_PORT is in use; set SMOKE_PORT=" >&2; exit 1; fi
PORT="$SMOKE_PORT" tools/serve.sh >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM
i=0
until answers; do
	i=$((i + 1))
	[ "$i" -lt 50 ] && kill -0 "$SERVER" 2>/dev/null || { echo "smoke: the server did not start" >&2; exit 1; }
	sleep 0.2
done

SEANCE_HTTP="$URL" node tools/browser-drive.mjs tools/scenarios/smoke.mjs --no-ws
