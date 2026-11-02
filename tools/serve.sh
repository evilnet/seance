#!/bin/sh
# Serve the built SPA (public/) on http://127.0.0.1:8765 for local testing.
# Build first: NODE_ENV=production pnpm build
# Dev ircd:    tools/nefarious-dev/run.sh -d   (ws://localhost:8067, wss://localhost:8443)
#
#   tools/serve.sh        # foreground
#   tools/serve.sh -d     # detached
set -e
cd "$(dirname "$0")/../public"
PORT="${PORT:-8765}"
if [ "$1" = "-d" ]; then
	nohup setsid python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
	echo "serving public/ at http://127.0.0.1:$PORT/"
else
	exec python3 -m http.server "$PORT" --bind 127.0.0.1
fi
