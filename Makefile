# One command per target to build, test and run Seance; each recipe calls the
# repository's own scripts. Toolchains: shells/tauri/README.md. Targets fail
# when their toolchain is missing, so CI calls the ones it gates on by name.
#
# Optional settings go in local.mk (gitignored), e.g.:
#
#   export JAVA_HOME := $(shell /usr/libexec/java_home)
#   export ANDROID_HOME := $(HOME)/Library/Android/sdk
#   export NDK_HOME := $(ANDROID_HOME)/ndk/29.0.14206865
#   export RUSTUP_TOOLCHAIN := 1.99.1
#
# Written for the make macOS ships (GNU Make 3.81) as well as newer.

-include local.mk

TAURI := shells/tauri
ANDROID := $(TAURI)/src-tauri/gen/android
# Written by a tauri android build, gitignored, and applied by Gradle.
ANDROID_GENERATED := $(ANDROID)/tauri.settings.gradle $(ANDROID)/app/tauri.build.gradle.kts

# The web and shell builds all write public/ and the icons.
.NOTPARALLEL:

.PHONY: help deps tauri-deps web-build web-test web-lint web-typecheck web-mocha \
	web-smoke web-run mac-build mac-test android-build android-test ios-sim-build ircd e2e

help: ## this list
	@awk -F ':.*## ' '/^[a-z0-9-]+:.*## /{printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# pnpm skips an install that is already current. Not into a node_modules that
# is a symlink into another checkout (prepare.mjs refuses those too).
deps:
	@[ -L node_modules ] || pnpm install --frozen-lockfile

tauri-deps: deps
	@[ -L $(TAURI)/node_modules ] || (cd $(TAURI) && pnpm install --frozen-lockfile)

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

web-run: web-build ## build, then serve public/ (tools/serve.sh)
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

# Needs the Simulator runtime matching Xcode's SDK (README § Phones).
ios-sim-build: tauri-deps ## unsigned iOS Simulator build: compiles, runs nothing
	cd $(TAURI) && pnpm tauri ios build --debug --target aarch64-sim

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
