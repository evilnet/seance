#!/bin/sh
# The smoke and the walk-through on Linux (WebKitGTK), in Docker under Xvfb.
# Needs Docker, the dev ircd and a built public/. Writes PNGs to $1 (default:
# tmp/tauri-linux at the repository root).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/tmp/tauri-linux}" && cd "${1:-$ROOT/tmp/tauri-linux}" && pwd)

docker build -q -t seance-tauri-linux "$HERE/linux" > /dev/null
node "$HERE/guest.mjs" & GUEST=$!
docker run --rm --add-host=host.docker.internal:host-gateway \
	-v "$ROOT:/src" -v "$OUT:/out" \
	-v seance-tauri-target:/target -v seance-cargo-registry:/usr/local/cargo/registry \
	seance-tauri-linux /src/shells/tauri/tools/linux/run.sh
kill "$GUEST" 2>/dev/null || true
