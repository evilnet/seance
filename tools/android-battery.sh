#!/bin/sh
# Measure what the Android shell costs in the background, with the
# "Stay connected in the background" toggle on or off, from Android's own
# battery accounting (dumpsys batterystats) on a phone or emulator over adb.
#
#   tools/android-battery.sh start          # reset the stats; now leave the phone alone
#   tools/android-battery.sh report [label] # the app's share since `start`
#
# Run it twice — toggle on, screen off, a few hours; then toggle off, same
# span — and compare the two reports. Unplug the phone after `start`:
# batterystats only accounts while on battery. An emulator answers the
# same commands but its numbers are synthetic (no radio, a 1000 mAh model
# battery); only a real phone gives a usable figure.
#
# What the report shows, all for the app's uid since the reset:
#   - estimated power (mAh) and its split (cpu, mobile radio, wifi, wakelock)
#   - time in foreground service / cached / background
#   - wakeups and wake lock time
#   - mobile and wifi bytes/packets, radio-active time
#   - cpu time
#
# APP=chat.seance.app  ADB=/path/to/adb  override the defaults.

set -e

APP=${APP:-chat.seance.app}
ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
ADB=${ADB:-$ANDROID_HOME/platform-tools/adb}

if [ ! -x "$ADB" ]; then
	ADB=$(command -v adb || true)
fi
if [ -z "$ADB" ]; then
	echo "adb not found; set ANDROID_HOME or ADB" >&2
	exit 1
fi

uid() {
	# "package:chat.seance.app uid:10123"; batterystats keys its blocks by "u0a123".
	id=$("$ADB" shell pm list packages -U "$APP" | tr -d '\r' | sed -n "s/^package:$APP uid:\([0-9]*\).*/\1/p" | head -1)
	[ -n "$id" ] || {
		echo "$APP is not installed" >&2
		exit 1
	}
	echo "u0a$((id - 10000))"
}

case "${1:-}" in
start)
	"$ADB" shell dumpsys batterystats --reset >/dev/null
	"$ADB" shell dumpsys batterystats --enable full-wake-history >/dev/null 2>&1 || true
	echo "batterystats reset at $(date '+%H:%M:%S') for $APP ($(uid))."
	echo "Unplug the phone, turn the screen off, come back in a few hours, then: $0 report"
	;;
report)
	label=${2:-}
	u=$(uid)
	dump=$("$ADB" shell dumpsys batterystats "$APP" | tr -d '\r')
	level=$("$ADB" shell dumpsys battery | tr -d '\r' | sed -n 's/.*level: //p')
	plugged=$("$ADB" shell dumpsys battery | tr -d '\r' | grep -c 'powered: true' || true)

	echo "== $APP ($u)${label:+ — $label} at $(date '+%H:%M:%S'); battery level $level%, powered sources: $plugged"
	echo "$dump" | grep -m1 'Estimated battery capacity' | sed 's/^ *//'
	echo "$dump" | grep -m1 -E 'Time on battery' | sed 's/^ *//'
	echo
	echo "-- estimated power (mAh), whole device then this uid"
	echo "$dump" | grep -A14 'Estimated power use' | grep -E "Capacity|UID $u|mobile_radio|wifi:|screen:|cpu:|idle:" | sed 's/^ *//' | head -8
	echo
	echo "-- this uid's block (network, radio, wake locks, cpu, process states)"
	# Every "  u0a123:" block — the dump has more than one (power model, cpu/proc state).
	echo "$dump" | awk -v u="  $u:" 'index($0,u)==1{f=1;next} f&&/^  [^ ]/{f=0} f' | grep -E \
		'Mobile network|Wifi network|Mobile radio active|WiFi Scan|Wake lock|Total cpu time:|Foreground services|Foreground activities|Total running|Cached|Background|Wakeup|wakeup alarm|Job|Sync' |
		sed 's/^ *//' | head -30
	echo
	echo "-- power breakdown line for this uid"
	echo "$dump" | grep -E "^ *(UID|Uid) $u" | sed 's/^ *//' | head -5
	;;
*)
	sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
	;;
esac
