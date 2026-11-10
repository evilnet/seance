# Short commands for building, testing and running each of Seance's targets.
# Every recipe calls the repository's own scripts; the toolchains each native
# target needs are in shells/tauri/README.md.
#
#   make help
#
# Targets are <platform>-<action>. Each fails when its toolchain is missing:
# CI should call the platform targets it means to gate on, by name.
#
# Optional settings go in local.mk (gitignored), e.g. for the Android SDK:
#
#   export JAVA_HOME := $(shell /usr/libexec/java_home)
#   export ANDROID_HOME := $(HOME)/Library/Android/sdk
#   export NDK_HOME := $(ANDROID_HOME)/ndk/29.0.14206865
#
# Written for the make that ships with macOS (GNU Make 3.81) as well as newer.

-include local.mk

SHELL := /bin/sh
PNPM ?= pnpm
TAURI := shells/tauri
ANDROID_PROJECT := $(TAURI)/src-tauri/gen/android
# web-run's port; the smoke check takes its own (tools/smoke.sh).
PORT ?= 8000
ANDROID_TARGET ?= aarch64
IOS_SIM_TARGET ?= aarch64-sim
# The longest mac-test may run before it counts as hung, in seconds.
MAC_TEST_TIMEOUT ?= 600

# Outputs are copied to dist/<platform>-<variant>-<commit>/ once a build has
# succeeded, so a failed build never leaves an older artifact looking current.
COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)$(shell git diff --quiet HEAD -- 2>/dev/null || echo -dirty)
# publish,<variant>,<path>: copy a finished output into dist/.
publish = rm -rf "dist/$(1)-$(COMMIT)" && mkdir -p "dist/$(1)-$(COMMIT)" && cp -R "$(2)" "dist/$(1)-$(COMMIT)/" && echo "built: dist/$(1)-$(COMMIT)/$(notdir $(2))"

# The web and shell builds all write public/ and the native icons, so two of
# them must never run at once, even under make -j.
.NOTPARALLEL:

.PHONY: help deps tauri-deps \
	web-build web-test web-lint web-typecheck web-mocha web-smoke web-run \
	mac-build mac-test android-build android-test ios-sim-build \
	ircd e2e

help:
	@echo "Seance: make <target>"
	@echo ""
	@echo "  web-build       production build of the SPA into public/"
	@echo "  web-test        what CI runs: lint, typecheck, mocha, smoke (builds first)"
	@echo "  web-run         build, then serve public/ on http://127.0.0.1:$(PORT)/"
	@echo "  mac-build       the desktop app (release Seance.app, no installers)"
	@echo "  mac-test        the desktop shell's smoke run (pnpm smoke; needs a GUI session)"
	@echo "  android-build   debug APK ($(ANDROID_TARGET))"
	@echo "  android-test    the Android push code's unit tests (JVM only)"
	@echo "  ios-sim-build   unsigned iOS Simulator build: proves it compiles, runs nothing"
	@echo "  ircd            start the dev ircd in Docker (tools/nefarious-dev/run.sh -d)"
	@echo "  e2e             Playwright e2e; needs SEANCE_E2E_IRC_URL"
	@echo ""
	@echo "Outputs land in dist/<target>-<commit>/. Settings: local.mk (see the top of this file)."

# Install when the installed tree does not match the lockfile (the same test
# shells/tauri/tools/prepare.mjs makes), not merely when node_modules exists.
deps:
	@cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml 2>/dev/null || $(PNPM) install --frozen-lockfile

tauri-deps: deps
	@cmp -s $(TAURI)/pnpm-lock.yaml $(TAURI)/node_modules/.pnpm/lock.yaml 2>/dev/null || (cd $(TAURI) && $(PNPM) install --frozen-lockfile)

## Web

web-build: deps
	NODE_ENV=production $(PNPM) build

# The same checks and order as .github/workflows/ci.yml, against one
# production build (pnpm test:mocha would rebuild in development mode).
web-test: web-build web-lint web-typecheck web-mocha web-smoke

web-lint: deps
	$(PNPM) lint

web-typecheck: deps
	$(PNPM) typecheck

web-mocha: deps
	$(PNPM) test:mocha:built

web-smoke: deps
	tools/smoke.sh

web-run: web-build
	python3 -m http.server -d public --bind 127.0.0.1 $(PORT)

## Desktop (macOS)

# tauri build runs prepare-app first (a fresh production public/ and the
# icons). --bundles app: the .app only, not the DMG.
mac-build: tauri-deps
	cd $(TAURI) && $(PNPM) tauri build --bundles app
	@$(call publish,mac-release,$(TAURI)/src-tauri/target/release/bundle/macos/Seance.app)

# A debug build that loads the page and checks the bridge; it opens a real
# window, so it needs a logged-in GUI session. perl's alarm stands in for
# timeout(1), which macOS does not ship.
mac-test: tauri-deps
	cd $(TAURI) && perl -e 'alarm shift; exec @ARGV or die "$$!\n"' $(MAC_TEST_TIMEOUT) $(PNPM) smoke

## Android

# The README's debug APK. Needs the SDK, NDK, JDK and the Rust target; see
# shells/tauri/README.md § Phones and the local.mk example above.
android-build: tauri-deps
	cd $(TAURI) && $(PNPM) tauri android build --debug --apk --target $(ANDROID_TARGET)
	@$(call publish,android-debug-$(ANDROID_TARGET),$(ANDROID_PROJECT)/app/build/outputs/apk/universal/debug/app-universal-debug.apk)

# Gradle applies tauri.settings.gradle and app/tauri.build.gradle.kts, which
# are gitignored and written by a tauri android build, so one runs first when
# they are missing. gen/android itself is Seance's code: never regenerated.
android-test: tauri-deps
	@if [ ! -f $(ANDROID_PROJECT)/tauri.settings.gradle ] || [ ! -f $(ANDROID_PROJECT)/app/tauri.build.gradle.kts ]; then \
	  echo "android-test: Tauri's generated Gradle files are missing; building once to write them"; \
	  $(MAKE) android-build; \
	fi
	cd $(ANDROID_PROJECT) && ./gradlew :app:testUniversalDebugUnitTest

## iOS

# A Simulator build, unsigned: it compiles the app and the Swift plugins and
# proves nothing about running. Needs Xcode and the Simulator runtime that
# matches Xcode's SDK (shells/tauri/README.md § Phones).
ios-sim-build: tauri-deps
	cd $(TAURI) && $(PNPM) tauri ios build --debug --target $(IOS_SIM_TARGET)

## Live IRC

# Replaces any running nefarious-dev container, whichever checkout started it.
ircd:
	tools/nefarious-dev/run.sh -d

# The live Markdown test sends messages to a real channel, so it never picks a
# server for you. Playwright serves public/ on 8000 and reuses a server
# already there: stop one from another checkout first.
e2e: web-build
	@if [ -z "$$SEANCE_E2E_IRC_URL" ]; then echo "e2e: set SEANCE_E2E_IRC_URL (e.g. wss://irc.example.org:9998/)" >&2; exit 1; fi
	$(PNPM) exec playwright test
