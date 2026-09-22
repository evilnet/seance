# Seance Capacitor shell

A [Capacitor](https://capacitorjs.com/) project that wraps the Seance web build as a native iOS / Android app. It is self-contained: its own `package.json`, `node_modules` and lockfile, nothing added to the root project. The web app is untouched; the shell just loads `../../public` in a WebView and the app connects to IRC over WebSocket exactly as it does in a browser (plan item E.4b in `docs/projects/initial_conversion.md`).

## Layout

| Path                      | What                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capacitor.config.ts`     | Capacitor config: `appId`, `appName` and `themeColor` (from `public/config.json`), `webDir: ../../public`, scheme, WebView background, StatusBar / Keyboard / SplashScreen / Badge plugin settings |
| `android/`                | Generated Android Studio project (`cap add android`). Committed; `app/src/main/assets/public/` is not.                                                                                             |
| `ios/`                    | Generated Xcode project (`cap add ios`, Swift Package Manager based). Committed; `App/App/public/` and SPM's `xcshareddata/swiftpm/` are not.                                                      |
| `assets/`                 | Source images for `@capacitor/assets`: `icon-only.png` (1024²), `splash.png` + `splash-dark.png` (2732²), built by `tools/make-assets.sh` from the web app's logo                                  |
| `tools/make-assets.sh`    | ImageMagick: the ghost artwork on its `#0D0E14` tile at 92% (like `client/img/icon-512.png`) and centred on the same tile for the splash                                                           |
| `tools/stamp-version.mjs` | Runs before every `cap sync` (`presync`): nearest git tag → `MARKETING_VERSION` / `versionName`, commit count → `CURRENT_PROJECT_VERSION` / `versionCode`                                          |
| `package.json`            | `seance-capacitor`: Capacitor 8 (`core`, `cli`, `android`, `ios`) plus the `app`, `haptics`, `keyboard`, `splash-screen`, `status-bar` and `@capawesome/capacitor-badge` plugins                   |

The web-side glue lives in the root app, not here: `client/js/native.ts` (called from `client/js/boot.ts`) feature-detects `window.Capacitor`, which the native WebView injects, and is a no-op in a browser. It talks to the bridge directly (`Capacitor.addListener` / `Capacitor.nativePromise`) so `@capacitor/core` is never bundled by the root webpack; a plugin is reachable by its registered name (`"App"`, `"Keyboard"`, `"Badge"`, …) as long as it is installed here, which is what `cap sync` registers natively. What the page does with the bridge:

- **`App.appStateChange`** → when the app becomes active, `reconnectAll()` (`client/js/irc/manager.ts`) retries every network sitting in reconnect backoff and PINGs the open ones so a socket the OS killed surfaces its close and reconnects.
- **`App.appUrlOpen` / `App.getLaunchUrl`** → an `irc:`, `ircs:` or `web+irc:` link the OS opened the app with (cold) or handed it while running is fed to the same path as a `?uri=` URL (`docs/resources/irc-links.md`: a saved server connects or is focused and joins the channels, an unknown one pre-fills the connect form). `native.ts` `onNativeUrl` holds a link that arrives before boot has subscribed, and drops the launch URL when iOS also reports it through `appUrlOpen`.
- **`App.backButton`** (Android) → close an open image, else leave a standalone page, else `App.minimizeApp()`. Never `router.back()`: the history is kept one deep (`router.ts`).
- **`StatusBar.setStyle`** → the bar's text colour follows the page's background luminance, at boot and on every theme change. The WebView fills the screen (`ios.contentInset: "never"`, `StatusBar.overlaysWebView: true`) and the page pads its own top by the safe area (`html[data-shell="native"]` in `style.css`, `viewport-fit=cover` added by `native.ts`): `env(safe-area-inset-*)` on iOS, and on Android the `--safe-area-inset-*` variables Capacitor's built-in SystemBars plugin injects, which win where they exist. SystemBars reads the viewport meta at `DOMContentLoaded`, before `native.ts` has added `viewport-fit=cover`, so `native.ts` calls its `onDOMReady()` again afterwards — otherwise it insets the WebView natively and the bands show the window's colour. A WebView older than Chromium 140 is always inset natively (Chromium's `env()` fix), which is what `MainActivity.java` paints the window in the deploy's `backgroundColor` for.
- **`Keyboard.keyboardWillShow` / `keyboardWillHide`** (iOS only) → the keyboard's height sizes the app (`helpers/viewport.ts`), the way the visual viewport does in a browser; `Keyboard.resize: "none"` keeps the WebView's frame. `setAccessoryBarVisible(false)` drops iOS's ˄ ˅ Done bar. Neither on Android: there Capacitor pads the WebView's parent by the IME inset, so the WebView shrinks like a browser's and the visual viewport is the whole story (the plugin's height on top took the keyboard off twice, a composer floating mid-screen), and the accessory-bar call is not implemented there and rejects.
- **`Haptics.impact`** → `helpers/haptics.ts`, when the long press opens the message toolbar.
- **`SplashScreen.hide`** → as soon as the theme stylesheet has loaded, so the page's own loading screen (the logo tile on the user's theme) takes over from the launch image, or from `nativeAppReady()` (`boot.ts`, once the page has dropped that loading screen) if the stylesheet was already in. `launchAutoHide: false` keeps the launch image up until one of them. The launch image itself is the logo on the icon's tile, not a theme colour: iOS draws it before any code runs and cannot know the theme.
- **`Badge.set` / `clear`** → `helpers/appBadge.ts` mirrors the store's highlight count onto the icon (the Badging API does the same for an installed PWA). iOS shows a badge only under the notification permission's badge grant, so the first highlight asks for it once, badge only.
- **No service worker.** `pwa.ts` skips registration inside the shell: the bundle is local, and a new build is a new app from the store, not a worker update (`checkForUpdate` is not called either).

## Prerequisites

- Node.js >= 22 and Yarn (the root uses `corepack yarn`).
- A root build: `NODE_ENV=production corepack yarn build` from the repository root produces `public/`. `cap sync` copies that directory; there is no dev-server / live-reload wiring here. **Rebuild before every sync** or the app ships whatever `public/` last held.
- Android: Android Studio (or the command-line SDK) with an SDK matching `android/variables.gradle` (`compileSdk 36`, `minSdk 24`), JDK 21. Export `ANDROID_HOME` or let Studio manage it.
- iOS: macOS with Xcode 15+ (Capacitor 8 targets iOS 15+). The generated project uses Swift Package Manager, so CocoaPods is not required.
- ImageMagick 7 (`magick`) only to regenerate `assets/` from new artwork.

## Workflow

```sh
cd shells/capacitor
corepack yarn install
corepack yarn sync            # stamp-version, then cap sync: copies ../../public into both platforms and updates native plugin lists
corepack yarn open:android    # opens android/ in Android Studio -> Run
corepack yarn open:ios        # opens ios/App/App.xcodeproj in Xcode -> Run
```

Re-run `corepack yarn sync` after every root `yarn build` (web assets) and after adding or removing a Capacitor plugin (native plugin registration). `corepack yarn run:android` / `run:ios` build and deploy to a connected device or emulator from the command line once the SDK / Xcode are installed. `corepack yarn doctor` reports what is missing on the machine.

Both `android/` and `ios/` are committed (as Capacitor recommends) so native customisations survive; the synced web assets, Gradle caches, SPM resolution state and build outputs are ignored via the root `.gitignore`. The root ESLint ignores `shells/capacitor/` (it has its own `tsconfig.json`; run `corepack yarn typecheck` here); Prettier formats this directory except the generated `android/` and `ios/` trees.

A simulator build from the command line, without signing:

```sh
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The Android debug build and an emulator run, from the command line (Gradle fetches the missing platform and build-tools itself once the SDK licences are accepted; `adb` is `$ANDROID_HOME/platform-tools/adb` — the Homebrew `adb` wrapper hangs):

```sh
export ANDROID_HOME=$HOME/Library/Android/sdk JAVA_HOME=/opt/homebrew/opt/openjdk@21
(cd android && ./gradlew assembleDebug)
$ANDROID_HOME/emulator/emulator -avd seance-android -gpu auto &   # `-gpu swiftshader_indirect` hangs the guest
$ANDROID_HOME/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
$ANDROID_HOME/platform-tools/adb shell am start -n chat.seance.app/.MainActivity
```

`adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof chat.seance.app)` exposes the WebView's DevTools protocol on `localhost:9222` (`/json` lists the page), which is how the viewport and safe-area numbers below were read. A link: `adb shell am start -a android.intent.action.VIEW -d 'web+irc://host:6697/#chan'`.

**Verified on the Android emulator** (Pixel 7 shape, Android 15, Chromium 151 WebView, 2026-09-21): the launch screen, the splash → themed loading screen → app handoff, the status-bar and navigation-bar bands in the page's colour, the keyboard (composer sits on the keyboard, `--viewport-height` = the shrunk window), `web+irc:` links cold and warm, back button, no unhandled rejections in logcat. Not verified on a real device or an older WebView.

## Rebranding

Everything an IRC network needs to change:

1. **`appId`** in `capacitor.config.ts` (placeholder `chat.seance.app`). It is baked into the generated projects (`android/app/build.gradle` `applicationId` + `namespace`, the Kotlin/Java package directory under `android/app/src/main/java/`, and `PRODUCT_BUNDLE_IDENTIFIER` in `ios/App/App.xcodeproj/project.pbxproj`). Easiest is to set it before the first `cap add`; otherwise edit those files or delete `android/` and `ios/` and re-add them.
2. **`appName`** comes from `public/config.json` `appName` when the CLI evaluates `capacitor.config.ts` (fallback `Seance`), so the same file that brands the web app (`docs/resources/branding.md`) names the native app. `cap sync` does not rewrite the display name in the already-generated projects, though: after changing it, update `android/app/src/main/res/values/strings.xml` (`app_name`, `title_activity_main`) and `CFBundleDisplayName` in `ios/App/App/Info.plist`, or re-add the platforms. **`themeColor`** is read the same way: it is the WebView's background (what shows before the page paints and under over-scroll) and the splash plugin's colour.
3. **Icons and splash screens**: replace the five files in `assets/` (`icon-only.png` for iOS, `icon-foreground.png` + `icon-background.png` for Android's adaptive icon — without those two the Android launcher, and the Android 12+ launch screen with it, keeps Capacitor's own icon whatever `ic_launcher.png` says — and the two splashes) — or run `tools/make-assets.sh your-art.png '#tile' '#splash'` to build them from a square PNG — then `corepack yarn assets`, which runs [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) for both platforms and writes every density into `android/app/src/main/res/` and `ios/App/App/Assets.xcassets/`. The colours in the `assets` script (`#0D0E14` for icon tile and splash) should match the artwork; `SplashScreen.backgroundColor` in `capacitor.config.ts` is the same tile.
4. **Web branding** (`public/config.json`, logos in `public/img/`) is picked up by `cap sync` like any other web asset. Native shells could also call `setBranding()` (`client/js/branding.ts`) instead of fetching `config.json`, if a network prefers to bake it in.
5. **Versions** come from git (`tools/stamp-version.mjs`): tag a release (`vX.Y.Z`) and sync. The stamped `project.pbxproj` and `build.gradle` show as modified after a sync whenever the commit count moved; commit them with a release or leave them. Note the checkout still carries TheLounge's upstream tags, so today that is `5.1.6`; the first Seance tag replaces it.
6. **Link schemes**: `ios/App/App/Info.plist` `CFBundleURLTypes` and the `VIEW` intent filter in `android/app/src/main/AndroidManifest.xml` claim `irc`, `ircs` and `web+irc` (the three the parser reads; `irc6`/`ircs6` from the old draft are not claimed). iOS gives a scheme to whichever installed app registered it last, so another IRC client on the phone can take `irc:` — universal links (`applinks:` + an `apple-app-site-association` on the deploy host) are the reliable form and belong to the network that ships this.
7. Signing: Android keystore / Play App Signing and the iOS team + provisioning profile are configured in Android Studio / Xcode as usual and are out of scope here. `ITSAppUsesNonExemptEncryption` is `false` in `Info.plist` (TLS only), so App Store Connect does not ask on every upload.

## Platform caveats (WebSocket, background, TLS)

**Background connections do not survive.** There is no bouncer in this architecture; the WebSocket to the ircd lives in the WebView, and both platforms stop it when the app leaves the foreground:

- **iOS** suspends the process (and with it every WebSocket) within roughly 30 seconds of backgrounding, and any timer-based reconnect in JS is frozen too. There is no supported way to keep a socket open in the background short of a VoIP / audio entitlement, which App Review rejects for chat apps. The app reconnects on foreground (`appStateChange` -> `reconnectAll()`), with the ircd's `resume`/history capabilities filling the gap where the network supports them. Offline notifications need push: iOS 16.4+ supports Web Push for home-screen web apps, and Seance's `draft/webpush` client work is the intended path (the ircd pushes through APNs/FCM); a native push plugin is the alternative if that lands first.
- **Android** is friendlier, but Doze and per-app battery optimisation still cut a cached process's network a few minutes after the screen goes off, and the low-memory killer takes it whenever it likes. **Settings → General → "Stay connected in the background"** (off by default) starts a foreground service — `ConnectionService.java`, driven by the `KeepAlive` plugin (`KeepAlivePlugin.java`, `client/js/helpers/keepAlive.ts`, the `keepConnected` setting) — which does no networking of its own: it changes the process's standing, so the WebView's sockets keep their network through Doze and the process is no longer a reclaim candidate. The price is Android's persistent notification (the app's name, "Staying connected in the background", a **Turn off** button that also flips the setting off) and battery: the socket itself is free, what wakes the phone is the ircd's PING every ~90 s per connection (the radio on cellular) and every line in a joined channel, which the WebView parses and renders off-screen; no wake lock is held. Not measured yet — a day on a real phone with the toggle on, then Settings → Battery, is the way to a number. The service stops itself when the task is swiped away or the activity is destroyed, so the notification never outlives the connections it names. On Android 13+ the first enable asks for the notification permission; denied, the service still runs but the notification is hidden (Settings says so). The type is `specialUse` — `dataSync` has a 6 h/day cap from Android 15 — which a **Play listing must declare** (Play Console → App content → Foreground service permissions; the subtype text is in the manifest's `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`); a sideloaded APK needs nothing. What it does not do: ask for the battery-optimisation exemption (Play restricts that intent), which some OEM kernels (Xiaomi, Huawei, Samsung's sleeping apps) need on top — those users toggle it in the system settings by hand. Same foreground reconnect story applies with it off, same push story for notifications.
- Because the JS runtime is frozen while suspended, the transport's own reconnect backoff may still be counting when the app resumes; `reconnectAll()` skips the remaining wait. Networks the user disconnected on purpose are not reconnected.

**Cleartext.** `server.androidScheme` is `https` (and iOS uses `capacitor://`), so the page is a secure context and secure-context-only APIs work just as on the web. The flip side is that `ws://` to an IRC server is mixed content and is blocked. Use `wss://` only. If a network truly needs plain `ws://` (dev only), set `android.allowMixedContent: true` in `capacitor.config.ts` and `android:usesCleartextTraffic="true"` on `<application>` in `android/app/src/main/AndroidManifest.xml`; on iOS that additionally needs an `NSAppTransportSecurity` exception in `Info.plist`. None of that is recommended for a shipped app.

**Certificates.** The WebView trusts the system store, so a self-signed development ircd is rejected on device with no browser-style "proceed anyway". Options: use a real certificate (Let's Encrypt) even on the dev host; install the CA as a user certificate on Android (user CAs are only trusted by apps that opt in via `res/xml/network_security_config.xml` in debug builds) or as a trusted profile on iOS (Settings > General > About > Certificate Trust Settings); or point the dev device at a `wss://` reverse proxy with a valid certificate. STS (`client/js/irc/sts.ts`) applies inside the app as well.

**External links.** Capacitor's WebView opens any navigation off the app's own origin (a `target="_blank"` message link, a same-frame `http(s)` URL) in the system browser and keeps the app where it is; nothing is configured for that. `ios.limitsNavigationsToAppBoundDomains` is left off — it exists to let a service worker run, and the shell registers none.

**File input.** The paperclip's `<input type="file">` brings up WKWebView's own sheet (Photo Library, Take Photo or Video, Choose File). `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` and `NSPhotoLibraryUsageDescription` are in `Info.plist` because iOS terminates an app that reaches for the camera without them.

## Follow-ups

- Bundle `@capacitor/core` + `@capacitor/push-notifications` (or wire `draft/webpush` to a native token) for offline notifications. Parked: needs the ircd side.
- Measure the "stay connected" service's battery cost on a real phone (Wi-Fi vs cellular, one busy channel vs quiet), and decide whether to offer the battery-optimisation exemption for OEMs that ignore foreground services.
- Universal links for the deploy host (needs the network's domain and Apple team).
- CI: a GitHub Actions job on `macos-latest` / `ubuntu-latest` with the Android SDK to at least `assembleDebug` / `xcodebuild -scheme App` after `cap sync`.
- Rename the `thelounge.*` localStorage keys before shipping so a future migration does not have to run inside the native app.
