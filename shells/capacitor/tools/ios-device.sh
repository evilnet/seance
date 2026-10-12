#!/bin/sh
# Builds the web app, syncs it into the iOS shell, and installs and launches
# a Debug build on a connected iPhone.
#
#   tools/ios-device.sh [udid]   (default: the first paired physical iPhone)
#
# Needs an Apple ID signed into Xcode (Settings → Accounts) for the team in
# ios/signing.xcconfig. A development profile lasts 7 days on a free team;
# once it lapses the phone says "Seance is no longer available" and this
# script is the fix. A new signing certificate also makes the first launch
# fail as "not explicitly trusted": trust it on the phone under Settings →
# General → VPN & Device Management, then open the app. Installing over the
# app keeps its data.

set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)

udid=${1:-}
if [ -z "$udid" ]; then
	json=$(mktemp)
	xcrun devicectl list devices --json-output "$json" >/dev/null
	udid=$(node -e '
		const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const phone = (d.result.devices || []).find((x) =>
			x.hardwareProperties?.reality === "physical" &&
			x.hardwareProperties?.platform === "iOS" &&
			x.connectionProperties?.pairingState === "paired");
		if (phone) console.log(phone.hardwareProperties.udid);
	' "$json")
	rm -f "$json"
	if [ -z "$udid" ]; then
		echo "No paired iPhone found (xcrun devicectl list devices)." >&2
		exit 1
	fi
fi

(cd "$root" && NODE_ENV=production pnpm build)
(cd "$here" && pnpm sync)

derived="$root/tmp/ios-device-build"
xcodebuild -project "$here/ios/App/App.xcodeproj" -scheme App \
	-configuration Debug -destination "id=$udid" \
	-derivedDataPath "$derived" -allowProvisioningUpdates -quiet build

app="$derived/Build/Products/Debug-iphoneos/App.app"
xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" chat.seance.app ||
	echo "Installed but not launched: unlock the phone, or trust the developer certificate (Settings → General → VPN & Device Management)." >&2
