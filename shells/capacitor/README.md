# Seance Capacitor shell

A [Capacitor](https://capacitorjs.com/) project that wraps the Seance web build as a native iOS / Android app. It is self-contained: its own `package.json`, `node_modules` and lockfile, nothing added to the root project. The web app is untouched; the shell just loads `../../public` in a WebView and the app connects to IRC over WebSocket exactly as it does in a browser (plan item E.4b in `docs/projects/initial_conversion.md`).

## Layout

| Path                  | What                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `capacitor.config.ts` | Capacitor config: `appId`, `appName` (from `public/config.json`), `webDir: ../../public`, scheme, StatusBar |
| `android/`            | Generated Android Studio project (`cap add android`). Committed; `app/src/main/assets/public/` is not.      |
| `ios/`                | Generated Xcode project (`cap add ios`, Swift Package Manager based). Committed; `App/App/public/` is not.  |
| `package.json`        | `seance-capacitor`: Capacitor 8 (`core`, `cli`, `android`, `ios`) plus the `app` and `status-bar` plugins   |

The web-side glue lives in the root app, not here. `client/js/helpers/capacitor.ts` is the bridge and nothing else — it feature-detects `window.Capacitor`, which the native WebView injects, and is a no-op in a browser; `nativeCall(plugin, method, options)` resolves to null instead of rejecting where there is nothing to call (a browser, an older shell, a method a platform does not implement), and `isIOSShell()` / `isAndroidShell()` are the platform questions. It imports nothing, so a leaf helper can use it without pulling in the store or the router; `client/js/native.ts` (called from `client/js/boot.ts`) is everything the page does _because_ it is in the shell. Talking to the bridge directly means `@capacitor/core` is never bundled by the root webpack; a plugin is reachable by its registered name (`"App"`, `"Keyboard"`, `"Badge"`, …) as long as it is installed here, which is what `cap sync` registers natively. What the page does with the bridge:

- **`App.appStateChange`** → when the app becomes active, `reconnectAll()` (`client/js/irc/manager.ts`) retries every network sitting in reconnect backoff and PINGs the open ones so a socket the OS killed surfaces its close and reconnects.
- **`App.backButton`** (Android) → an open image closes first; then a standalone page gives way to the conversation it came from, and with nothing left, `App.minimizeApp()`. Never `router.back()`: the history is kept one deep (`router.ts`).

## Prerequisites

- Node.js >= 22 and Yarn (the root uses `corepack yarn`).
- A root build: `NODE_ENV=production corepack yarn build` from the repository root produces `public/`. `cap sync` copies that directory; there is no dev-server / live-reload wiring here.
- Android: Android Studio (or the command-line SDK) with an SDK matching `android/variables.gradle` (`compileSdk 36`, `minSdk 24`), JDK 21. Export `ANDROID_HOME` or let Studio manage it.
- iOS: macOS with Xcode 15+ (Capacitor 8 targets iOS 15+). The generated project uses Swift Package Manager, so CocoaPods is not required.

## Workflow

```sh
cd shells/capacitor
corepack yarn install
corepack yarn sync            # cap sync: copies ../../public into both platforms and updates native plugin lists
corepack yarn open:android    # opens android/ in Android Studio -> Run
corepack yarn open:ios        # opens ios/App/App.xcodeproj in Xcode -> Run
```

Re-run `corepack yarn sync` after every root `yarn build` (web assets) and after adding or removing a Capacitor plugin (native plugin registration). `corepack yarn run:android` / `run:ios` build and deploy to a connected device or emulator from the command line once the SDK / Xcode are installed. `corepack yarn doctor` reports what is missing on the machine.

Both `android/` and `ios/` are committed (as Capacitor recommends) so native customisations survive; the synced web assets, Gradle caches and build outputs are ignored via the root `.gitignore`. The root ESLint ignores `shells/capacitor/` (it has its own `tsconfig.json`; run `corepack yarn typecheck` here); Prettier formats this directory except the generated `android/` and `ios/` trees.

### Verified on a machine without the Android SDK or Xcode

`yarn install`, `cap add android`, `cap add ios` and `cap sync` all work with only Node.js (the platform templates are plain file trees). `android/gradlew --version` runs with JDK 21 (Gradle wrapper resolves). Not verified here: any Gradle build, any Xcode build, running on a device or simulator, the StatusBar / back-button / app-state behaviour at runtime. Treat those as the first things to check on a machine with the toolchains.

## Rebranding

Everything an IRC network needs to change:

1. **`appId`** in `capacitor.config.ts` (placeholder `chat.seance.app`). It is baked into the generated projects (`android/app/build.gradle` `applicationId` + `namespace`, the Kotlin/Java package directory under `android/app/src/main/java/`, and `PRODUCT_BUNDLE_IDENTIFIER` in `ios/App/App.xcodeproj/project.pbxproj`). Easiest is to set it before the first `cap add`; otherwise edit those files or delete `android/` and `ios/` and re-add them.
2. **`appName`** comes from `public/config.json` `appName` when the CLI evaluates `capacitor.config.ts` (fallback `Seance`), so the same file that brands the web app (`docs/resources/branding.md`) names the native app. `cap sync` does not rewrite the display name in the already-generated projects, though: after changing it, update `android/app/src/main/res/values/strings.xml` (`app_name`, `title_activity_main`) and `CFBundleDisplayName` in `ios/App/App/Info.plist`, or re-add the platforms. The StatusBar background colour is taken from `themeColor` the same way.
3. **Icons and splash screens**: use [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets). Put `icon.png` (1024x1024), `splash.png` and `splash-dark.png` (2732x2732) in `shells/capacitor/assets/` and run `npx @capacitor/assets generate --android --ios` from this directory; it writes every density into `android/app/src/main/res/` and `ios/App/App/Assets.xcassets/`. Not run in this checkout; the projects still carry Capacitor's default icon.
4. **Web branding** (`public/config.json`, logos in `public/img/`) is picked up by `cap sync` like any other web asset. Native shells could also call `setBranding()` (`client/js/branding.ts`) instead of fetching `config.json`, if a network prefers to bake it in.
5. Signing: Android keystore / Play App Signing and the iOS team + provisioning profile are configured in Android Studio / Xcode as usual and are out of scope here.

## Platform caveats (WebSocket, background, TLS)

**Background connections do not survive.** There is no bouncer in this architecture; the WebSocket to the ircd lives in the WebView, and both platforms stop it when the app leaves the foreground:

- **iOS** suspends the process (and with it every WebSocket) within roughly 30 seconds of backgrounding, and any timer-based reconnect in JS is frozen too. There is no supported way to keep a socket open in the background short of a VoIP / audio entitlement, which App Review rejects for chat apps. The app reconnects on foreground (`appStateChange` -> `reconnectAll()`), with the ircd's `resume`/history capabilities filling the gap where the network supports them. Offline notifications need push: iOS 16.4+ supports Web Push for home-screen web apps, and Seance's `draft/webpush` client work is the intended path (the ircd pushes through APNs/FCM); a native push plugin is the alternative if that lands first.
- **Android** is friendlier but Doze and per-app battery optimisation still close idle sockets after a few minutes in the background, and the WebView itself can be paused. A **foreground service** (persistent notification) is the only reliable keep-alive; it is out of scope for this shell and worth weighing against battery cost and the "always running" notification. Same foreground reconnect story applies, same push story for notifications.
- Because the JS runtime is frozen while suspended, the transport's own reconnect backoff may still be counting when the app resumes; `reconnectAll()` skips the remaining wait. Networks the user disconnected on purpose are not reconnected.

**Cleartext.** `server.androidScheme` is `https` (and iOS uses `capacitor://`), so the page is a secure context: the service worker registers and secure-context-only APIs work just as on the web. The flip side is that `ws://` to an IRC server is mixed content and is blocked. Use `wss://` only. If a network truly needs plain `ws://` (dev only), set `android.allowMixedContent: true` in `capacitor.config.ts` and `android:usesCleartextTraffic="true"` on `<application>` in `android/app/src/main/AndroidManifest.xml`; on iOS that additionally needs an `NSAppTransportSecurity` exception in `Info.plist`. None of that is recommended for a shipped app.

**Certificates.** The WebView trusts the system store, so a self-signed development ircd is rejected on device with no browser-style "proceed anyway". Options: use a real certificate (Let's Encrypt) even on the dev host; install the CA as a user certificate on Android (user CAs are only trusted by apps that opt in via `res/xml/network_security_config.xml` in debug builds) or as a trusted profile on iOS (Settings > General > About > Certificate Trust Settings); or point the dev device at a `wss://` reverse proxy with a valid certificate. STS (`client/js/irc/sts.ts`) applies inside the app as well.

**Other**: `ios.contentInset: "always"` keeps the WebView below the notch / status bar; on Android 15+ edge-to-edge is on by default and the StatusBar plugin config (`overlaysWebView: false`, `backgroundColor` from `themeColor`) keeps the app below the system bars. The keyboard pushes the view up on both platforms by default; if the input gets hidden behind it, add `@capacitor/keyboard` and set `resize: "body"`.

## Follow-ups

- Bundle `@capacitor/core` + `@capacitor/push-notifications` (or wire `draft/webpush` to a native token) for offline notifications.
- Decide on an Android foreground service for "stay connected" (opt-in setting).
- Generate real icons/splash with `@capacitor/assets` once the branding assets exist.
- CI: a GitHub Actions job on `macos-latest` / `ubuntu-latest` with the Android SDK to at least `assembleDebug` / `xcodebuild -scheme App` after `cap sync`.
- Rename the `thelounge.*` localStorage keys before shipping so a future migration does not have to run inside the native app.
