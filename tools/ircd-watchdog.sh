#!/bin/sh
# Keep the native nefarious2 ircd alive (SASL via tools/iauth-agent.py,
# WebSocket on 8067 behind tools/serve.py's TLS proxy). One instance only.
#
# Every path is an environment variable with this rig's value as its default
# (docs/resources/nefarious2-dev.md § The watchdogs):
#   IRCD_PID           pidfile guarding the single instance
#   NEFARIOUS_DIR      the built ircd (the directory holding the `ircd` binary)
#   NEFARIOUS_CONF_DIR the run directory: ircd.conf, state, the agent's socket
#   IRCD_LOG           where stdout and stderr go
IRCD_PID=${IRCD_PID:-/tmp/ircd-6667.pid}
NEFARIOUS_DIR=${NEFARIOUS_DIR:-/seance/tmp/nefarious2/ircd}
NEFARIOUS_CONF_DIR=${NEFARIOUS_CONF_DIR:-/seance/tmp/nefarious-dev}
IRCD_LOG=${IRCD_LOG:-/tmp/ircd.log}

if [ -f "$IRCD_PID" ] && kill -0 "$(cat "$IRCD_PID")" 2>/dev/null; then
	exit 0
fi
echo $$ > "$IRCD_PID"
while true; do
	cd "$NEFARIOUS_DIR" || exit 1
	./ircd -n -x 5 -f "$NEFARIOUS_CONF_DIR/ircd.conf" -d "$NEFARIOUS_CONF_DIR" >> "$IRCD_LOG" 2>&1
	echo "$(date -u +%H:%M:%S) ircd exited rc=$? — restarting" >> "$IRCD_LOG"
	sleep 1
done
