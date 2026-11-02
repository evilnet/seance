# Seance Tauri shell

The desktop app for Windows, macOS and Linux (`docs/projects/desktop-shells.md`).
A Tauri v2 window around the built SPA: the page speaks IRC over WebSocket
itself, and the shell adds the window, `web+irc:` links, the badge and the
platform's close behaviour. Each OS's own web view draws it — WebView2 on
Windows, WKWebView on macOS, WebKitGTK on Linux. A release `.app` is about
10 MB.

This package is self-contained (`seance-tauri`, private): the Tauri CLI is its
only npm dependency and nothing is added to the repository root.

**Status: a spike.** It loads, connects, takes links and badges on macOS and
Linux; Windows has not been run. Signing, the updater and installers are
gate 4 of the plan.

## Run from source

```sh
# 1. Build the SPA at the repository root (once, or after client changes)
NODE_ENV=production pnpm build

# 2. Install the CLI and run the shell
cd shells/tauri
pnpm install
pnpm start      # tauri dev: a debug build, public/ compiled in
```

`public/` is compiled into the binary (`frontendDist`), so a client change
needs a rebuild of both. Rust 1.80 or newer; on Linux, WebKitGTK 4.1 and its
build dependencies (see `tools/linux/Dockerfile` for Debian's list).

`pnpm icons` regenerates `src-tauri/icons/` from
`public/img/icon-512.png` (the deploy's icon, so a rebrand carries over); the
other scripts run it first. On a Mac the `.icns` is made from the logo cut to
the Mac's rounded square (`tools/macos-icon.swift`), since macOS draws an icon
as it is and a square logo would show as a square in the Dock.

## Checks

- **Smoke**: `pnpm smoke` (a debug build with `--smoke`) loads the
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

| Plugin               | Methods / events                                                                                                               | Notes                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `App`                | `getLaunchUrl`, `requestAttention`; event `appUrlOpen`                                                                         | `web+irc:` links; an alert while the window is not in front bounces the Dock icon, flashes the taskbar button or marks the window urgent                                                                                  |
| `Badge`              | `checkPermissions`, `requestPermissions`, `set`, `clear`                                                                       | the count on the Dock (macOS) and launchers (Linux); a red dot over the taskbar button on Windows, which shows no number. Not yet run on Windows                                                                          |
| `LocalNotifications` | `checkPermissions`, `requestPermissions`, `schedule`, `removeDeliveredNotifications`; event `localNotificationActionPerformed` | Windows, Linux (`src/alerts.rs`); macOS answers from the Apple plugins. A click opens the conversation (on Windows only while the toast is on screen); reading it removes the alert on Linux only. Not yet run on Windows |

- **CSP** (`tauri.conf.json`): `'self'` scripts only, plus
  `'wasm-unsafe-eval'` and `blob:` workers as the Electron shell allowed
  for the in-page translation engines (Tauri sends the policy with HTML
  only, so the worker most likely runs without it; see
  `test/tests/tauriShell.ts`), and the hash of every bundled script Tauri
  adds at build, inline styles (the
  user's CSS, Vue's), images and media from `https:`/`data:`/`blob:`,
  `connect-src` `ws: wss: https:` (the user picks the IRC host; uploads),
  no objects, frames, base-tag or form targets. `style-src` is left
  unmodified by Tauri, whose nonces would void `'unsafe-inline'`.
- **Navigation**: inside the app only; other http(s) links,
  `target="_blank"` and `window.open()` open in the user's browser.
- **Links**: `deep-link` claims `web+irc:`; the launch link comes from
  `App.getLaunchUrl`, later ones as `App.appUrlOpen` — no reload, so no
  connection is dropped. A second launch hands its argv over
  (`single-instance`). A build run from source registers nothing with the
  OS; an installed one declares the scheme in its bundle.
- **Closing the window** follows the platform: macOS keeps the app in the
  Dock (⌘Q quits, the Dock icon reopens), Windows keeps it in the
  notification area (the tray menu has Quit), Linux quits — a tray may not be
  shown there at all.
- **macOS titlebar**: the web view runs under the titlebar and WebKit lays
  the page out below it (a 32 pt obscured inset on macOS 27); the page sees
  the visible height and never scrolls under the bar.

## Rebranding

Follow `docs/resources/branding.md` first (`config.json`, icons in
`public/img/`). Then `src-tauri/tauri.conf.json`: `productName`, and
`identifier` (`chat.seance.desktop`), which a rebrand **must** change — it
is the macOS bundle identifier and the key the app's data is stored under,
so two apps sharing it collide. Taking both from `config.json` at build time
is a gate 4 item.
