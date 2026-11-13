# Seance Tauri shell

Seance's app on every platform: Windows, macOS and Linux
(`docs/projects/desktop-shells.md`), and iOS and Android (§ Phones). A
Tauri v2 window around the built SPA: the page speaks IRC over WebSocket
itself, and the shell adds the window, links, the badge, alerts and the
platform's behaviour. Each OS's own web view draws it — WebView2 on
Windows, WKWebView on macOS and iOS, WebKitGTK on Linux, the system WebView
on Android. A release `.app` is about 10 MB.

This package is self-contained (`seance-tauri`, private): the Tauri CLI is its
only npm dependency and nothing is added to the repository root.

**Status: a spike.** It loads, connects, takes links and badges on macOS and
Linux; Windows has not been run. Signing, the updater and installers are
gate 4 of the plan.

## Run from source

```sh
# With the repository root's dependencies installed (pnpm install there):
cd shells/tauri
pnpm install
pnpm start      # tauri dev: a debug build, public/ compiled in
pnpm build      # tauri build: the release app and installers
```

`public/` is compiled into the binary (`frontendDist`), so each of these
first runs `pnpm prepare-app` (`tools/prepare.mjs`, Tauri's
`beforeDevCommand`/`beforeBuildCommand`): the production SPA at the root, then
the icons. A client change needs a fresh `start` or `build`, never a hand
build. The screenshot scripts call cargo directly and take `public/` as it is.
Rust 1.80 or newer; on Linux, WebKitGTK 4.1 and its build dependencies (see
`tools/linux/Dockerfile` for Debian's list).

There is no Vite dev server or hot reload, unlike Tauri's Vite guide: the
SPA's `index.html`, service worker and static files are made by `vite build`
only (`vite.config.mts`), and a dev server would move the page off
`tauri://localhost`. One `public/` serves the web and every shell, so the
build reads no `TAURI_ENV_*`.

`pnpm icons` regenerates `src-tauri/icons/` from
`public/img/icon-512.png` (the deploy's icon, so a rebrand carries over).
On a Mac the `.icns` is made from the logo cut to
the Mac's rounded square (`tools/macos-icon.swift`), since macOS draws an icon
as it is and a square logo would show as a square in the Dock.

**macOS 26 and iOS 26 or newer** (`bundle.macOS.minimumSystemVersion`,
`tauri.ios.conf.json`, and the Swift packages' platforms): the current
systems' APIs with no availability checks, and a WebKit far past the
bundle's Safari 16.4 floor (Vite's default `build.target`).

### Linux from a Mac

`make linux-build` builds the release `.deb` and AppImage in Docker
(`tools/build-linux.sh`, the image in `tools/linux`) for the machine's own
architecture, so arm64 on Apple silicon, into `tmp/linux-app/`. To click
around in it, an Ubuntu Desktop arm64 VM in UTM is enough: share the
checkout's `tmp/linux-app` with the VM (UTM's VirtFS directory share, mounted
in the guest with `sudo mount -t 9p -o trans=virtio share /mnt`) and
`sudo apt install /mnt/seance_*.deb`. A VM's virtual GPU says nothing about
WebKitGTK's speed, so the Linux engine gate (`desktop-shells.md` § 6) is
measured on real hardware, not there.

## Checks

- **Smoke**: `pnpm smoke` (`prepare-app`, then a debug build with `--smoke`) loads the
  app, checks from inside the page that the bridge answers, that a plugin the
  shell does not have rejects `unimplemented`, that `<html data-shell>` is
  `desktop`, that no service worker is registered, then hands the running
  page a `web+irc:` link and checks the connect form filled in without a
  reload. It prints what it saw and exits non-zero on anything wrong.
- **Walk-through and screenshots**: `tools/shots-macos.sh` (WKWebView's own
  snapshots, so it works on a locked screen) and `tools/shots-linux.sh`
  (Docker, Xvfb, WebKitGTK) connect to the dev ircd
  (`tools/nefarious-dev/run.sh -d`), join `#seance` with a guest
  (`tools/guest.mjs`), send a line, open Settings, then launch the app a
  second time with a `web+irc:` link. PNGs land in `tmp/tauri-shots` and
  `tmp/tauri-linux`. The dev ircd's `wss://` certificate is self-signed,
  which WKWebView refuses, so the walk-through uses `ws://` on 8067.

The debug-only hooks behind these (`--smoke`, `--drive=<file.js>`, the
`Smoke` plugin, and `Smoke.snapshot` under `--features snapshot`) are
compiled out of a release build.

## How it fits together

- **The page**: `public/`, served as the app's own origin —
  `tauri://localhost` on macOS and Linux (measured), `http://tauri.localhost`
  on Windows (Tauri's documentation; not yet run). A secure context, so the
  page behaves as on an https deploy, minus the service worker
  (`desktop-shells.md` § 4.2).
- **The bridge**: an init script defines a frozen `window.seanceShell`
  (`{platform, version, call, listen}`), the contract
  `client/js/helpers/shell.ts` reads in every shell. `call` is one
  `seance_call` command; `listen` hears what the shell evaluates in the
  page. No Tauri plugin API is exposed to the page
  (`capabilities/default.json`).

| Plugin               | Methods / events                                                                                                               | Notes                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App`                | `getLaunchUrl`, `requestAttention`, `ircLinks`; event `appUrlOpen`                                                             | IRC links (`ircLinks`: Windows and Linux, below); an alert while the window is not in front bounces the Dock icon, flashes the taskbar button or marks the window urgent                                                      |
| `Badge`              | `checkPermissions`, `requestPermissions`, `set`, `clear`                                                                       | the count on the Dock (macOS) and launchers (Linux); a red dot over the taskbar button on Windows, which shows no number. Not yet run on Windows                                                                              |
| `LocalNotifications` | `checkPermissions`, `requestPermissions`, `schedule`, `removeDeliveredNotifications`; event `localNotificationActionPerformed` | Windows, Linux (`src/alerts.rs`); macOS answers from the Apple plugins. A click opens the conversation (on Windows only while the toast is on screen); reading it removes the alert on Linux only. Not yet run on Windows     |
| `AppleTranslate`     | `availability`, `translate`, `prepare`, `languages`                                                                            | macOS only: Apple's Translation framework (`swift/` SeanceTranslate, shared with the iOS shell; `prepare`'s download sheet hangs off the key window). Windows and Linux answer `unimplemented`, and the page never asks there |

- **CSP** (`tauri.conf.json`): `'self'` scripts only, plus
  `'wasm-unsafe-eval'` and `blob:` workers for the in-page translation
  engines (Tauri sends the policy with HTML
  only, so the worker most likely runs without it; see
  `test/tests/tauriShell.ts`), and the hash of every bundled script Tauri
  adds at build, inline styles (the
  user's CSS, Vue's), images and media from `https:`/`data:`/`blob:`,
  `connect-src` `ws: wss: https:` (the user picks the IRC host; uploads),
  no objects, frames, base-tag or form targets. `style-src` is left
  unmodified by Tauri, whose nonces would void `'unsafe-inline'`.
- **Navigation**: inside the app only; other http(s) links,
  `target="_blank"` and `window.open()` open in the user's browser.
- **Links**: `deep-link` claims `web+irc:` and `web+ircs:`; the launch link comes from
  `App.getLaunchUrl`, later ones as `App.appUrlOpen` — no reload, so no
  connection is dropped. A second launch hands its argv over
  (`single-instance`). A build run from source registers nothing with the
  OS; an installed one declares the scheme in its bundle. `irc:` and
  `ircs:` (TCP) are claimed only where the system or the user picks the
  default: the phones' manifests, macOS's `Info.macos.plist`, and on
  Windows and Linux the Settings → General switch (`App.ircLinks`
  `{enable}`, answers `{enabled}`). Why, and what "off" gives back:
  `TCP_SCHEMES` and `release_link` in `src/lib.rs`. A Windows Default apps
  choice still wins over the switch. The NSIS uninstaller removes the claim
  (`windows/hooks.nsh`); on Linux, turn the switch off before removing the
  package.
- **Closing the window** follows the platform: macOS keeps the app in the
  Dock (⌘Q quits, the Dock icon reopens), Windows keeps it in the
  notification area (the tray menu has Quit), Linux quits — a tray may not be
  shown there at all.
- **macOS titlebar**: the web view runs under the titlebar and WebKit lays
  the page out below it (a 32 pt obscured inset on macOS 27); the page sees
  the visible height and never scrolls under the bar.

## Phones

The same shell builds for Android and iOS as `chat.seance.app`
(`tauri.android.conf.json`, `tauri.ios.conf.json`); the desktop is
`chat.seance.desktop`. The page sees `window.seanceShell` with platform
`android` or `ios`; `seance_call` hands what Rust does not answer to one
native plugin, `SeancePlugin` (`src/mobile.rs`), and its events come back
through one channel to `emit()`. Haptics is Tauri's own plugin, through its
Rust API; its notification plugin is not used, as it injects a
`window.Notification` shim into the page. `gen/android` and `gen/apple` are
the Tauri CLI's projects, committed with the shell's own files in them.

| Plugin                | Android (`gen/android/…/SeancePlugin.kt`)            | iOS (`ios/Sources/SeanceIOS/SeancePlugin.swift`)                   |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| `App`                 | `backButton`, `appStateChange`, `minimizeApp`, links | `appStateChange`, links                                            |
| `KeepAlive`           | `ConnectionService`, a foreground service            | —                                                                  |
| `NativePush`          | UnifiedPush with its embedded FCM distributor        | —                                                                  |
| `SystemAccessibility` | contrast, animation scale, font scale, battery saver | —                                                                  |
| `LocalNotifications`  | — (alerts go through `NativePush` `show`)            | `swift/` SeanceNotifications, the macOS shell's code               |
| `Power`               | —                                                    | Low Power Mode                                                     |
| `Keyboard`            | —                                                    | `keyboardWillShow`/`Hide`, accessory bar hidden, `reset`           |
| `StatusBar`           | both bars' style                                     | style (wry's view controller's `preferredStatusBarStyle`, swapped) |
| `Badge`               | answered, nothing to set                             | the app icon's count                                               |
| `Haptics`             | `tauri-plugin-haptics`                               | `tauri-plugin-haptics`                                             |
| `AppleTranslate`      | —                                                    | `swift/` SeanceTranslate, shared with the macOS shell              |

Links (`web+irc:`, `web+ircs:`, `irc:`, `ircs:`) are declared to the deep-link plugin
(`tauri.conf.json` `plugins.deep-link.mobile`), which writes the Android
intent filter and the iOS URL types. The paperclip offers the camera on
Android (`UploadChooserClient.kt`, in front of wry's chrome client); what a
picker app answers is taken only as another app's `content:` URI. The app's
data stays out of Android's backup and device transfers.

**Android** (SDK, NDK 29, JDK 21, which a release build's lint needs; the emulator or a phone over adb):

```sh
NODE_ENV=production pnpm build          # at the root: public/ is compiled in
cd shells/tauri
export JAVA_HOME=$(/usr/libexec/java_home) ANDROID_HOME=~/Library/Android/sdk
export NDK_HOME=$ANDROID_HOME/ndk/29.0.14206865
pnpm tauri android build --debug --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A release build (`make android-release`: a signed APK and AAB) reads the key
from `src-tauri/gen/android/keystore.properties`, which is gitignored and
never committed:

```properties
storeFile=/Users/you/.android/seance-release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

Without the file, Gradle builds the release unsigned. A debug APK is signed
with the machine's own debug key, so an APK from another machine (CI's
included) only installs after uninstalling the app. CI's signed build
(Actions > Android > Run workflow, with "release" ticked) writes the file
from four repository secrets: `ANDROID_KEYSTORE_BASE64` (`base64 -i` of the
keystore), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`.

The push code's unit tests: `./gradlew :app:testUniversalDebugUnitTest` in
`src-tauri/gen/android`. A debug build's WebView is debuggable
(`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`).

**iOS** (Xcode, iOS 26): `tauri ios build` wants the Simulator runtime
matching Xcode's SDK. Without it, keep `pnpm tauri ios dev "iPhone 17 Pro" --no-watch` running (it opens Xcode and serves the build options the Rust
step reads), then build against any installed iOS 26 Simulator:

```sh
cd src-tauri/gen/apple
xcodebuild -project seance-tauri.xcodeproj -scheme seance-tauri_iOS -configuration debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build/dd \
  CODE_SIGNING_ALLOWED=NO build
xcrun simctl install booted build/dd/Build/Products/debug-iphonesimulator/Seance.app
```

For a phone over USB, the same with `-destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM=<team>` and no
`CODE_SIGNING_ALLOWED`, then `xcrun devicectl device install app --device <udid> build/dd/Build/Products/debug-iphoneos/Seance.app`.

`build.rs` copies Tauri's Swift API into `ios/.tauri/` and links the
package. A change to `Info.ios.plist` or the link schemes reaches the app at
the next `tauri ios dev` or `build`.

## Rebranding

Follow `docs/resources/branding.md` first (`config.json`, icons in
`public/img/`). Then `src-tauri/tauri.conf.json`: `productName`, and
`identifier` (`chat.seance.desktop`), which a rebrand **must** change — it
is the macOS bundle identifier and the key the app's data is stored under,
so two apps sharing it collide. Taking both from `config.json` at build time
is a gate 4 item.
