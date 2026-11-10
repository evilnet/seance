# One command per target to build, test and run Seance; each recipe calls the
# repository's own scripts. Toolchains: shells/tauri/README.md.
#
# Optional settings go in local.mk (gitignored), e.g.:
#
#   export JAVA_HOME := $(shell /usr/libexec/java_home)
#   export ANDROID_HOME := $(HOME)/Library/Android/sdk
#   export NDK_HOME := $(ANDROID_HOME)/ndk/29.0.14206865
#   export RUSTUP_TOOLCHAIN := 1.99.1
#
# and, for the install targets, the devices and Apple team they use:
#
#   IOS_DEVICE := <udid>          # xcrun devicectl list devices
#   export APPLE_DEVELOPMENT_TEAM := <team id>
#   ANDROID_DEVICE := <serial>    # adb devices
#
# Written for the make macOS ships (GNU Make 3.81) as well as newer.

-include local.mk

TAURI := shells/tauri
ANDROID := $(TAURI)/src-tauri/gen/android
# One of the files a tauri android build writes (gitignored) and Gradle applies.
ANDROID_GENERATED := $(ANDROID)/tauri.settings.gradle
MAC_APP := $(TAURI)/src-tauri/target/release/bundle/macos/Seance.app
IOS_APP := $(TAURI)/src-tauri/gen/apple/build/arm64/Seance.ipa
IOS_TRACKED := $(TAURI)/src-tauri/gen/apple/seance-tauri.xcodeproj/project.pbxproj \
	$(TAURI)/src-tauri/gen/apple/seance-tauri_iOS/Info.plist

# The web and shell builds all write public/; the shell builds the icons too.
.NOTPARALLEL:

.PHONY: help deps tauri-deps web-build web-test web-lint web-typecheck web-mocha \
	web-smoke web-run mac-build mac-test android-build android-test android-release \
	ios-sim-build ios-device-build ios-install ios-run mac-install android-install \
	ircd e2e

help: ## this list
	@awk -F ':.*## ' '/^[a-z0-9-]+:.*## /{printf "  %-17s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# pnpm skips an install that is already current. Each checkout installs its
# own: pnpm links from one shared store, so that is quick and small.
deps:
	@if [ -L node_modules ]; then echo "deps: node_modules is a symlink; remove it and run make again" >&2; exit 1; fi
	pnpm install --frozen-lockfile

tauri-deps: deps
	@if [ -L $(TAURI)/node_modules ]; then echo "tauri-deps: $(TAURI)/node_modules is a symlink; remove it and run make again" >&2; exit 1; fi
	cd $(TAURI) && pnpm install --frozen-lockfile

web-build: deps ## production build of the SPA into public/
	NODE_ENV=production pnpm build

# One production build for mocha and the smoke check, as in ci.yml (pnpm
# test:mocha would rebuild in development mode).
web-test: web-build web-lint web-typecheck web-mocha web-smoke ## lint, typecheck, mocha, smoke

web-lint: deps
	pnpm lint

web-typecheck: deps
	pnpm typecheck

web-mocha: deps
	pnpm test:mocha:built

web-smoke: deps
	tools/smoke.sh

web-run: web-build ## build, then serve public/ on :8765 (tools/serve.sh)
	tools/serve.sh

# tauri build makes a fresh production public/ and the icons first. The .app
# lands in $(TAURI)/src-tauri/target/release/bundle/macos/.
mac-build: tauri-deps ## the desktop app (release .app, no DMG)
	cd $(TAURI) && pnpm tauri build --bundles app

# Opens a real window, so it needs a GUI session. Under an identifier of its
# own, so single-instance never hands the run to a Seance you have open, and
# the run never touches that app's data.
mac-test: tauri-deps ## the desktop shell's smoke run
	cd $(TAURI) && TAURI_CONFIG='{"identifier":"chat.seance.desktop.maketest"}' pnpm smoke

# The APK lands in $(ANDROID)/app/build/outputs/apk/universal/debug/.
android-build: tauri-deps ## debug APK (aarch64)
	cd $(TAURI) && pnpm tauri android build --debug --apk --target aarch64

$(ANDROID_GENERATED):
	$(MAKE) android-build

# gen/android itself is Seance's code: never regenerated.
android-test: tauri-deps $(ANDROID_GENERATED) ## the push code's JVM unit tests
	cd $(ANDROID) && ./gradlew :app:testUniversalDebugUnitTest

# Signed with the key keystore.properties names (shells/tauri/README.md
# § Phones). The APK and AAB land under $(ANDROID)/app/build/outputs/.
# RELEASE_VERSION=X.Y.Z overrides tauri.conf.json's version, and so the
# versionCode; the CLI does not read TAURI_CONFIG for these.
android-release: tauri-deps ## signed release APK and AAB (aarch64)
	@if [ ! -f $(ANDROID)/keystore.properties ]; then echo "android-release: $(ANDROID)/keystore.properties is missing (shells/tauri/README.md § Phones)" >&2; exit 1; fi
	cd $(TAURI) && pnpm tauri android build $(if $(RELEASE_VERSION),--config '{"version":"$(RELEASE_VERSION)"}') --apk --aab --target aarch64

# Needs the Simulator runtime matching Xcode's SDK (README § Phones).
ios-sim-build: tauri-deps ## unsigned iOS Simulator build: compiles, runs nothing
	cd $(TAURI) && pnpm tauri ios build --debug --target aarch64-sim

# Signed with APPLE_DEVELOPMENT_TEAM's development profile. The build writes
# the team into the tracked Xcode project and edits Info.plist; both go back
# afterwards if they were clean before, so the team is never committed.
ios-device-build: tauri-deps ## iPhone debug build, signed with your team (local.mk)
	@test -n "$(APPLE_DEVELOPMENT_TEAM)" || { echo "ios-device-build: set APPLE_DEVELOPMENT_TEAM in local.mk" >&2; exit 1; }
	@dirty="$$(git status --porcelain -- $(IOS_TRACKED))"; \
	(cd $(TAURI) && pnpm tauri ios build --debug --target aarch64); status=$$?; \
	if [ -z "$$dirty" ]; then git checkout -- $(IOS_TRACKED); fi; \
	exit $$status

ios-install: ios-device-build ## ... then install it on IOS_DEVICE
	@test -n "$(IOS_DEVICE)" || { echo "ios-install: set IOS_DEVICE in local.mk (xcrun devicectl list devices)" >&2; exit 1; }
	xcrun devicectl device install app --device $(IOS_DEVICE) $(IOS_APP)

ios-run: ios-install ## ... then launch it
	xcrun devicectl device process launch --device $(IOS_DEVICE) chat.seance.app

# Tauri leaves the bundle with only the linker's ad-hoc signature on the
# binary, which codesign --verify rejects inside a bundle; signing the whole
# bundle ad hoc seals its resources. Checks and copies the new .app beside the
# installed one before touching it (a failed copy leaves the old app), then
# quits Seance, swaps it in and opens it.
mac-install: mac-build ## build, then replace /Applications/Seance.app and open it
	codesign --force --deep --sign - $(MAC_APP)
	codesign --verify --deep --strict $(MAC_APP)
	rm -rf /Applications/Seance.app.new
	ditto $(MAC_APP) /Applications/Seance.app.new
	osascript -e 'tell application id "chat.seance.desktop" to quit' 2>/dev/null || true
	rm -rf /Applications/Seance.app
	mv /Applications/Seance.app.new /Applications/Seance.app
	open /Applications/Seance.app

# adb refuses an APK signed with another key than the installed app's; this
# stops there and never uninstalls (that would delete the app's data).
android-install: android-build ## debug APK onto ANDROID_DEVICE (adb install -r)
	@test -n "$(ANDROID_DEVICE)" || { echo "android-install: set ANDROID_DEVICE in local.mk (adb devices)" >&2; exit 1; }
	adb -s $(ANDROID_DEVICE) install -r $(ANDROID)/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Replaces any running nefarious-dev container, whichever checkout started it.
ircd: ## the dev ircd in Docker
	tools/nefarious-dev/run.sh -d

# Without SEANCE_E2E_IRC_URL the live test skips itself; fail instead, so a
# green run means it ran. Playwright would test a server already on port 8000
# (another checkout's) rather than start its own, so that port must be free.
e2e: web-build ## Playwright e2e against SEANCE_E2E_IRC_URL
	@test -n "$$SEANCE_E2E_IRC_URL" || { echo "e2e: set SEANCE_E2E_IRC_URL (e.g. wss://irc.example.org:9998/)" >&2; exit 1; }
	@python3 -c 'import socket; socket.socket().bind(("127.0.0.1", 8000))' 2>/dev/null || { echo "e2e: port 8000 is in use; stop that server first" >&2; exit 1; }
	pnpm exec playwright test
