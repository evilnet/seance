#!/bin/sh
# Run soju in Docker for Seance's soju.im/bouncer-networks work.
#
#   tools/soju-dev/run.sh       # foreground
#   tools/soju-dev/run.sh -d    # detached (docker logs -f soju-dev)
#
# Build the image once (soju from source, master; SOJU_REF=<tag> to pin):
#   docker build -t soju:dev tools/soju-dev
#
# Shares the host's network, so soju listens on 127.0.0.1 directly and its
# upstreams can be the dev nefarious2 (tools/nefarious-dev/run.sh) at
# irc+insecure://127.0.0.1:6667.
# On Docker Desktop that needs its host networking setting turned on;
# otherwise publish 8090 instead (-p 127.0.0.1:8090:8090, soju listening on
# 0.0.0.0) and give soju's networks the host host.docker.internal
# (the scenario's SEANCE_SOJU_UPSTREAM).
#
# Ports: 8090 ws:// (point Seance at host 127.0.0.1, port 8090, no TLS),
# 6668 plain IRC. User seance / password seance (SASL PLAIN), an admin.
# State in tmp/soju-dev; delete it to start over.
set -e
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
STATE="$ROOT/tmp/soju-dev"
IMAGE="${SOJU_IMAGE:-soju:dev}"
mkdir -p "$STATE"

run() {
	docker run --rm --user "$(id -u):$(id -g)" --network host \
		-v "$ROOT/tools/soju-dev/soju.conf:/etc/soju.conf:ro" \
		-v "$STATE:/data" "$@"
}

if [ ! -f "$STATE/soju.db" ]; then
	printf 'seance\n' | run -i --entrypoint sojudb "$IMAGE" -config /etc/soju.conf \
		create-user seance -admin 2>/dev/null
fi

DETACH=""
[ "$1" = "-d" ] && DETACH="-d"

docker rm -f soju-dev >/dev/null 2>&1 || true
run $DETACH --name soju-dev "$IMAGE" -config /etc/soju.conf
