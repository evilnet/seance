#!/bin/sh
# The Linux app, a release .deb and AppImage, built in Docker (WebKitGTK,
# tools/linux) for this machine's architecture: arm64 on Apple silicon.
# Takes public/ and the icons as they are, so run `pnpm prepare-app` first
# (make linux-build does). Writes the packages to $1 (default: tmp/linux-app
# at the repository root).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/tmp/linux-app}" && cd "${1:-$ROOT/tmp/linux-app}" && pwd)
CLI=$(node -p 'require(process.argv[1]).devDependencies["@tauri-apps/cli"]' "$HERE/../package.json")

docker build -q --build-arg "TAURI_CLI=$CLI" -t seance-tauri-linux "$HERE/linux" > /dev/null
docker run --rm -e CARGO_TARGET_DIR=/target \
	-v "$ROOT:/src" -v "$OUT:/out" \
	-v seance-tauri-target:/target -v seance-cargo-registry:/usr/local/cargo/registry \
	seance-tauri-linux /src/shells/tauri/tools/linux/bundle.sh
