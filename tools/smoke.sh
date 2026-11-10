#!/bin/sh
# The smoke check CI runs (.github/workflows/ci.yml, "Smoke"), runnable
# locally: serve the built public/ on a port of its own, wait for it, run
# tools/scenarios/smoke.mjs in a real Chromium, stop the server.
#
#   NODE_ENV=production pnpm build && tools/smoke.sh     # or: make web-test
#
# PORT (default 8790) is not 8000 so that a server you already have running
# for another checkout is never the one tested. The browser is $CHROME_BIN,
# else Chromium or Chrome from PATH or /Applications, else Playwright's
# Chromium if it is installed.
set -eu
cd "$(dirname "$0")/.."
PORT="${PORT:-8790}"

if [ ! -f public/index.html ]; then
	echo "smoke: public/ is not built; run NODE_ENV=production pnpm build first" >&2
	exit 1
fi

if [ -z "${CHROME_BIN:-}" ]; then
	for bin in chromium chromium-browser google-chrome \
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
		"/Applications/Chromium.app/Contents/MacOS/Chromium"; do
		if command -v "$bin" >/dev/null 2>&1 || [ -x "$bin" ]; then
			CHROME_BIN="$bin"
			break
		fi
	done
fi
if [ -z "${CHROME_BIN:-}" ]; then
	CHROME_BIN="$(node -e 'console.log(require("@playwright/test").chromium.executablePath())' 2>/dev/null || true)"
	[ -x "$CHROME_BIN" ] || CHROME_BIN=""
fi
if [ -z "$CHROME_BIN" ]; then
	echo "smoke: no Chromium found; set CHROME_BIN" >&2
	exit 1
fi
if ! command -v "$CHROME_BIN" >/dev/null 2>&1 && [ ! -x "$CHROME_BIN" ]; then
	echo "smoke: CHROME_BIN=$CHROME_BIN is not an executable" >&2
	exit 1
fi
export CHROME_BIN

python3 -m http.server -d public --bind 127.0.0.1 "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT INT TERM

# Ready when it answers; give up after ten seconds (the port may be taken).
i=0
until node -e 'fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' \
	"http://127.0.0.1:$PORT/" 2>/dev/null; do
	i=$((i + 1))
	if [ "$i" -ge 50 ] || ! kill -0 "$SERVER" 2>/dev/null; then
		echo "smoke: the server on port $PORT did not start (is the port in use? set PORT=)" >&2
		exit 1
	fi
	sleep 0.2
done
# Answered, but by us? A port someone else holds makes ours exit at bind.
sleep 0.3
if ! kill -0 "$SERVER" 2>/dev/null; then
	echo "smoke: port $PORT is in use by another server; set PORT=" >&2
	exit 1
fi

SEANCE_HTTP="http://127.0.0.1:$PORT/" node tools/browser-drive.mjs tools/scenarios/smoke.mjs --no-ws
