#!/bin/sh
# Inside the container (shots-linux.sh): build, smoke, then the walk-through
# under Xvfb, screenshotting the root window whenever the page asks for a
# snapshot (the Linux build only prints a marker for it).
set -e
cd /src/shells/tauri/src-tauri
cargo build --features snapshot --target-dir /target
BIN=/target/debug/seance-tauri
export WEBKIT_DISABLE_DMABUF_RENDERER=1
sed -e "s#__HOST__#host.docker.internal#" -e "s#__OUT__#/out#" /src/shells/tauri/tools/walkthrough.js > /out/walkthrough.js
rm -f /out/*.png /out/run.log /out/linked

xvfb-run -a -s "-screen 0 1100x760x24" dbus-run-session -- sh -c "
	timeout 60 $BIN --smoke 2>&1 | grep '^smoke'
	$BIN --drive=/out/walkthrough.js > /out/run.log 2>&1 &
	APP=\$!
	for _ in \$(seq 1 200); do
		for p in \$(grep -o 'snapshot: [^ ]* unsupported' /out/run.log | cut -d' ' -f2); do
			n=\$(basename \$p .tiff)
			[ -f /out/\$n.png ] || { sleep 0.3; import -window root /out/\$n.png; }
		done
		if grep -q ready-for-link /out/run.log && [ ! -f /out/linked ]; then
			touch /out/linked
			$BIN 'web+irc://irc.libera.chat:6697/%23help' >> /out/run.log 2>&1 || true
		fi
		grep -q 'smoke: done' /out/run.log && break
		sleep 0.5
	done
	kill \$APP 2>/dev/null || true
	rm -f /out/linked
	grep 'smoke: done' /out/run.log"
