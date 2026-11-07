#!/usr/bin/env bash
# Regenerate handshake.traces.json (what Seance must do) from the model.
# Needs java and tla2tools.jar 1.8+ (TLA2TOOLS=/path/to/tla2tools.jar).
# Also writes handshake.raw.jsonl, the input of live_server.py.
set -eo pipefail
cd "$(dirname "$0")"
JAR=${TLA2TOOLS:-tla2tools.jar}
java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -workers 1 -config MBT.cfg MC.tla \
  | grep '^"{' > handshake.raw.jsonl
python3 dedupe.py handshake.raw.jsonl > handshake.traces.json
