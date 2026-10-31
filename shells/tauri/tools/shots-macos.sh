#!/bin/sh
# The walk-through on macOS, with WKWebView's own snapshots (no screen
# needed, so it works on a locked machine too). Needs the dev ircd
# (tools/nefarious-dev/run.sh -d) and a built public/. Writes PNGs to
# $1 (default: tmp/tauri-shots at the repository root).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/tmp/tauri-shots}" && cd "${1:-$ROOT/tmp/tauri-shots}" && pwd)
BIN="$HERE/../src-tauri/target/debug/seance-tauri"

(cd "$HERE/../src-tauri" && cargo build --features snapshot)
sed -e "s#__HOST__#localhost#" -e "s#__OUT__#$OUT#" "$HERE/walkthrough.js" > "$OUT/walkthrough.js"
rm -f "$OUT"/*.tiff "$OUT/run.log"

node "$HERE/guest.mjs" & GUEST=$!
sleep 2
"$BIN" --drive="$OUT/walkthrough.js" > "$OUT/run.log" 2>&1 & APP=$!

for _ in $(seq 1 160); do
	if grep -q "ready-for-link" "$OUT/run.log" && [ ! -f "$OUT/linked" ]; then
		touch "$OUT/linked"
		"$BIN" "web+irc://irc.libera.chat:6697/%23help" >> "$OUT/run.log" 2>&1
	fi

	grep -q "smoke: done" "$OUT/run.log" && break
	sleep 0.5
done

kill "$APP" "$GUEST" 2>/dev/null || true
rm -f "$OUT/linked"
grep "smoke: done" "$OUT/run.log"

for tiff in "$OUT"/*.tiff; do
	sips -s format png "$tiff" --out "${tiff%.tiff}.png" > /dev/null && rm "$tiff"
done
