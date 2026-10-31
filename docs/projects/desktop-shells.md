# Desktop shells: Windows, macOS and Linux

_Written 2026-10-30. Step 1, the bridge (§ 3), is built; the Tauri shell
(`shells/tauri/`) has passed its spike on macOS and Linux (§ 6, gate 2).
The Electron wrapper phase E.4a left in `shells/electron/` was never used
and is removed, nothing taken from it._

## 1. Goal and decisions

A native desktop app on the major three, Windows, macOS and Linux, as small
and as close to the platform as the Capacitor shells are on the phones: the
same `public/` tree, the same bridge, and on macOS the Apple frameworks the
phones already reach (Translation first).

Decided (rdrake, 2026-10-30):

- **Tauri v2 on all three**, the web view each OS ships (WebView2 on
  Windows, WKWebView on macOS, WebKitGTK on Linux), with the macOS-only
  plugins written in Swift and called from the shell's Rust. One shell, one
  packaging and signing pipeline, installers of a few MB. No separate
  SwiftUI Mac shell.
- **Linux steps down** where WebKitGTK cannot carry a feature: it gets a
  lighter tier there (§ 6, gate 3), never a second shell.
- **Closing the window follows each platform's convention** (§ 5.2).
- **We distribute ourselves**: signed direct downloads with Tauri's updater,
  no Mac App Store or Microsoft Store (§ 4.4).

## 2. Where things stood

- `shells/capacitor/` (iOS, Android) talked to the page through
  `window.Capacitor`, read only in `client/js/helpers/capacitor.ts`.
- There was no desktop shell the page knew about.
- The client's whole native surface is about 30 calls on ten plugins:

| Plugin                                                                        | Methods / events                                                                     | Desktop                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `App`                                                                         | `appUrlOpen`, `appStateChange`, `backButton`; `minimizeApp`                          | **needed**: `appUrlOpen` is the warm `web+irc:` hand-off    |
| `LocalNotifications`                                                          | `checkPermissions`, `requestPermissions`, `schedule`, `removeDeliveredNotifications` | **needed**                                                  |
| `Badge`                                                                       | `checkPermissions`, `requestPermissions`, `set`, `clear`                             | **needed**: dock / taskbar overlay / launcher count         |
| `SystemAccessibility`                                                         | `status`, `changed`                                                                  | probably not: the media queries are live on desktop engines |
| `NativePush`                                                                  | `status`, `subscribe`, `unsubscribe`, `show`, `seen`, `clear`, `tap`, `endpoint`     | later, macOS only (APNs); see § 5.2                         |
| `Keyboard`, `StatusBar`, `SystemBars`, `SplashScreen`, `KeepAlive`, `Haptics` | —                                                                                    | mobile only; null is the right answer                       |
| `AppleTranslate` (phone build)                                                | `availability`, `translate`, `prepare`, `languages`                                  | macOS                                                       |

New on desktop: a tray / menu-bar icon and close-to-tray, open-external,
the shell's version, and the updater.

## 3. Step 1 — a shell-neutral bridge

`helpers/capacitor.ts` becomes `helpers/shell.ts`: the same
`nativeCall` / `nativeInvoke` / `nativeListen` and `null` for anything
missing, but over a small interface any shell can provide.

- **Contract**: `window.seanceShell = {platform, version, call(plugin, method, options): Promise, listen(plugin, event, cb)}`.
  The Capacitor shells get it from a few lines of glue over
  `window.Capacitor` in the client; a desktop shell injects it from an
  init script. Shimming `window.Capacitor` from the desktop shell instead
  is rejected: it would make every phone check true on desktop and borrow a
  contract we do not own.
- **Platform values**: `ios`, `android`, `web`, plus `macos`, `windows`,
  `linux`, and `isDesktopShell()` beside `isIOSShell()` /
  `isAndroidShell()`. Every caller of the old `isNativeShell()` /
  `nativePlatform()` was read for what it does with a value it has never
  seen: `pwa.ts`, `webpush.ts`, `native.ts`, `helpers/{appBadge, platformDefaults, systemAccessibility, viewport, keepAlive, nativeAlerts, haptics, nativePush}.ts`, `Settings/{Appearance,Notifications}.vue`. Many
  of those meant "a phone shell", not "any shell", and now say so.

Tests: the bridge is Vue-free and DOM-free, so mocha covers it with a fake
`window.seanceShell` (`test/helpers/shell.ts`).

**Built (2026-10-30).** `helpers/capacitor.ts` is `helpers/shell.ts` with
`isShell()` / `isMobileShell()` / `isDesktopShell()`; haptics, the status
bar, the splash, the system text size and the back button are phone-only,
links and the badge are every shell's; a desktop shell sets
`<html data-shell="desktop" data-platform=…>` (never `native`, which is the
phones' safe-area and keyboard CSS); `platformDefaults.ts` follows the
system's appearance in every shell and its text size on the phones only;
no service worker is registered in a desktop shell (`pwa.ts` and the early
registration in `loading-error-handlers.js`). Two finds on the way:

- **Connect read its query once.** A link handed to a running page that
  was already on Connect left the form as it was, and Cancel on a link
  back to the plain form stayed the link dialog. `App.vue` now keys the
  Connect route on its full path, so a new query mounts a new form; this
  was true of a PWA's warm launch too.
- **`tools/scenarios/link-approval.mjs` raced.** It took the `#seance`
  sidebar row as proof of a dial, but an autojoin channel is a placeholder
  before the socket opens; it waits for the socket now.

Not done in step 1: web push in a desktop shell. `webpush.ts` still offers
the push prompt and registers a `push/<uuid>/` worker when a server
announces its key, and the subscribe fails there. § 5.2 turns that off and
says so in Settings → Notifications.

## 4. The shell (`shells/tauri/`)

### 4.1 Serving `public/`

- **Assets**: `frontendDist` compiles `public/` into the binary; the page
  is the app's own origin, never the network.
- **CSP**: `app.security.csp` — `'self'` scripts only, inline styles (the
  user's CSS, Vue's), images and media from `https:`/`data:`/`blob:`,
  `connect-src` `ws: wss: https:` (the user picks the IRC host; uploads),
  no objects, frames, base-tag or form targets. Tauri adds nonces to the
  directives it modifies, which would void `'unsafe-inline'`, so
  `style-src` is left unmodified.
- **Navigation**: the window navigates inside the app alone; any other
  http(s) link, `target="_blank"` and `window.open()` go to the user's
  browser (`opener`), anything else nowhere.
- **Window**: `window-state` remembers size and place; `single-instance`
  keeps one app, a second launch hands over its argv.
- **Links**: `deep-link` claims `web+irc:`; the page gets the launch link
  from `App.getLaunchUrl` and later ones as `App.appUrlOpen`, no reload.
- **Bridge**: one `seance_call` command; no Tauri plugin API is exposed to
  the page (`capabilities/default.json`).
- **Smoke**: a debug build's `--smoke` checks the bridge and the warm link
  from inside the page and exits non-zero on anything wrong.

Measured in the spike (macOS 27, Debian bookworm's WebKitGTK 4.1): the
origin is `tauri://localhost` on both, a secure context; `config.json`, the
hash router and the dev ircd's WebSocket all work from it (the dev rig's
`WEBSOCKET_ORIGIN` is open; a network that pins it must allow the app's
origin). Still open: Windows (`http://tauri.localhost` per Tauri's
documentation), and whether `localStorage` survives an update — a debug
build keeps WebKit's data under the binary's name, an installed one under
the identifier, so the two do not share it.

### 4.2 Things the web view does not do

- **The service worker is absent on desktop, on purpose.** WKWebView runs
  none on a custom scheme. What the client uses it for, and the desktop's
  answer: the offline shell (moot, the files are local), web push (§ 5.2),
  the new-build notice (`build.ts` / `checkForUpdate`: Tauri's updater
  instead). `pwa.ts` skips registration and the install guide in any shell.
- **Notifications go through `LocalNotifications`, never the web
  `Notification` API**, which WKWebView does not implement and the other two
  need host-side permission handling for.

### 4.3 macOS plugins in Swift

The phone build's `AppleTranslatePlugin.swift` translates with
`TranslationSession(installedSource:target:)`, which needs no view, but
`prepare` (downloading a language pair) uses `.translationTask`, which needs
a hosted SwiftUI view. On desktop: a Swift package built as a static
library and called from the shell's Rust (swift-rs or a C ABI), with an
off-screen `NSHostingView` for `prepare`. Plumbing to write once; the Swift
logic is shared with the iOS plugin by moving it out of the Capacitor class
into a plain Swift type both wrap.

### 4.4 Distribution

Direct downloads only, no app stores. macOS: Developer ID signing and
notarisation (DMG). Windows: an installer (NSIS or MSI), Authenticode
signing, and the WebView2 runtime (preinstalled on Windows 11; the
bootstrapper for 10). Linux: AppImage and `.deb`, `.rpm` if asked; the
WebKitGTK version is the distro's, so pick a floor. Updates through Tauri's
updater with signed manifests, published as release assets. The product
name and the bundle identifier should come from `config.json` (`appName`)
at build time, as the web build's do; a rebrand must change the identifier.

## 5. What the desktop does about the server-side features

### 5.1 Settings defaults

`platformDefaults.ts` and the settings backup's restoring-platform rule have
entries for the desktop platforms. Follow the system wherever the system has
a say (appearance, contrast, motion); text size stays the web's default, the
desktop has no system body size worth reading.

### 5.2 Notifications while closed

Desktop IRC clients stay open, and closing the window does what each
platform's own apps do:

- **macOS**: closing the window keeps the app running in the Dock, as every
  Mac app does; ⌘Q quits. Clicking the Dock icon reopens the window. A
  menu-bar extra is not needed for this.
- **Windows**: closing the window keeps the app in the notification area,
  as chat apps there do (Discord, Teams, Slack); the tray icon's menu has
  Quit.
- **Linux**: the same as Windows where the desktop shows tray icons
  (StatusNotifierItem: KDE, Cinnamon, XFCE, GNOME with the AppIndicator
  extension). Where none is shown, closing the window quits, since a
  window-less app there could not be reached. The spike quits on close
  everywhere on Linux until it can tell the two apart.

A setting can override this later if anyone asks; the default is the
platform's. While the app runs, the connection and the notifications need
no push. Web push stays a browser feature. Native push is a later,
macOS-only item (APNs needs the signed app and a server path the Android
shell's push work already sketches); Windows (WNS) wants a packaged
identity, and Linux has no system push. Settings → Notifications says which
applies instead of offering push that cannot work.

## 6. Gates, in order

1. **Bridge** (§ 3) lands with its tests. _Done._
2. **Spike**: a bare Tauri shell loading `public/` on all three, connected
   to the dev ircd, with the § 4.1 checks. _Passed on macOS and Linux
   2026-10-30, Windows not run:_ the smoke (`corepack yarn smoke`) and the
   walk-through (`tools/shots-macos.sh`, `tools/shots-linux.sh`: connect,
   join, send, Settings, a second launch's `web+irc:` link with no reload)
   pass on both; a release `.app` is 10 MB. Found on the way: the dev ircd's
   self-signed `wss://` is refused by WKWebView (the walk-through uses
   `ws://`), and on macOS 27 the web view runs under the titlebar with a
   32 pt obscured inset that WebKit handles itself — the page sees the
   visible height and never scrolls under the bar. The connect form's
   "Browser notifications for this network" says browser in a shell and
   does nothing yet there (gate 4).
3. **Linux engine gate.** WebKitGTK is the risk: the ps theme's glass
   `backdrop-filter`, the scene, and the translation fallback (no Apple
   engine there, so our own models; check whether they need WebGPU or run on
   WASM/CPU). Measured with the `perf-measure` method on a real Linux
   desktop, against Chrome on the same machine. Whatever fails steps down on
   Linux, feature by feature: ps NG's calm or still tier as the Linux
   default, the glass solid (the reduced-transparency look), translation on
   CPU or off. Each step-down is written down here, not discovered by users.
4. **Shippable**: notifications and the badge through the bridge, signing,
   the updater, installers on all three; `initial_conversion.md` E.4a
   ticked.

## 7. Testing cost

Three engines, three debugging paths: WebView2 speaks the DevTools protocol,
so `tools/browser-drive.mjs` can drive it as it drives Chromium; WKWebView
goes through Safari's Web Inspector; WebKitGTK through its own inspector, not
CDP. The scenarios that matter on desktop (connect, notifications, link
hand-off, theme rendering) get a manual checklist per OS until a driver
exists for the two WebKits. That is the real price of the system web view
and the reason the Linux gate exists.

## 8. Open questions

None from the first round (§ 1). The spike will raise its own.
