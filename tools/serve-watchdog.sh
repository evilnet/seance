#!/bin/sh
# Keep the HTTPS+WSS host (tools/serve.py) alive. One instance only: the
# pidfile guard makes a second launch a no-op, which matters because the
# container's process hygiene has repeatedly respawned or reaped these.
#
# Every path and address is an environment variable with this rig's value as
# its default (docs/resources/nefarious2-dev.md § The watchdogs):
#   SERVE_PID   pidfile guarding the single instance
#   SERVE_PORT  port to listen on
#   SERVE_SAN   IP or hostname the self-signed certificate is issued for
#   SERVE_LOG   where stdout and stderr go
#   SEANCE_DIR  the checkout tools/serve.py lives in
SERVE_PID=${SERVE_PID:-/tmp/serve-8000.pid}
SERVE_PORT=${SERVE_PORT:-8000}
SERVE_SAN=${SERVE_SAN:-10.0.0.41}
SERVE_LOG=${SERVE_LOG:-/tmp/serve-8000.log}
SEANCE_DIR=${SEANCE_DIR:-/seance}

if [ -f "$SERVE_PID" ] && kill -0 "$(cat "$SERVE_PID")" 2>/dev/null; then
	exit 0
fi
echo $$ > "$SERVE_PID"
while true; do
	python3 -X faulthandler "$SEANCE_DIR/tools/serve.py" \
		--port "$SERVE_PORT" --san "$SERVE_SAN" --verbose >> "$SERVE_LOG" 2>&1
	echo "$(date -u +%H:%M:%S) server exited rc=$? — restarting" >> "$SERVE_LOG"
	sleep 1
done
