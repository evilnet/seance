# Seance Electron shell

A thin desktop wrapper around the built Seance SPA. It contains no application
logic: the window loads the same `public/` directory a web deploy serves, the
SPA connects to IRC over WebSocket itself, and the shell only adds a window,
a menu, `web+irc://` link handling and packaging.

This package is self-contained (`seance-electron`, private) with its own
`node_modules`; nothing is added to the repository root `package.json`.

## Run from source

```sh
# 1. Build the SPA at the repository root (once, or after client changes)
NODE_ENV=production corepack yarn build

# 2. Install and start the shell
cd shells/electron
corepack yarn install
corepack yarn start
```

`corepack yarn start` loads `../../public` directly, so rebuilding the SPA and
pressing Reload (View menu, Ctrl/Cmd+R) picks up client changes.

`corepack yarn smoke` (or `electron . --smoke`) opens the window hidden, waits
for the SPA to load, prints the loaded URL, document title, the
`window.seanceShell` bridge, secure-context status and a service-worker
register/unregister probe, and exits non-zero on any error-level renderer
console message or load failure. It needs a display; there is no headless mode
in Electron (use `xvfb-run -a corepack yarn smoke` on CI).

## Package

```sh
corepack yarn run pack   # unpacked app in dist/<platform>-unpacked/
corepack yarn dist       # installers: Linux AppImage + deb, macOS dmg, Windows nsis
```

`pack` must be run as `yarn run pack`: plain `yarn pack` is Yarn's tarball
command and shadows the script. Both scripts pass `-c electron-builder.cjs`,
which re-exports the `build` section of `package.json` and sets `productName`
(and the Linux executable name) from `public/config.json`'s `appName`.

The packaged layout is:

- `resources/app.asar` — `main.js`, `preload.js`, `package.json`
- `resources/public/` — a verbatim copy of `../../public` (`extraResources`)

`public/` must exist before packaging; nothing here builds it.

## How the SPA is served: `app://seance/`

`file://` cannot host a service worker, `fetch("./config.json")` or a proper
origin, so `main.js` registers a privileged custom scheme
(`protocol.registerSchemesAsPrivileged` with `standard`, `secure`,
`supportFetchAPI`, `allowServiceWorkers`, `corsEnabled`, `stream`) and answers
`app://seance/<path>` from `public/` via `protocol.handle`. Paths are resolved
inside `public/` only (traversal is refused), directories and extensionless
paths fall back to `index.html`, and every response carries an explicit
`Content-Type` plus this `Content-Security-Policy`:

| Directive                    | Value                       | Why                                               |
| ---------------------------- | --------------------------- | ------------------------------------------------- |
| `default-src`, `script-src`  | `'self'`                    | Only the bundled SPA runs                         |
| `style-src`                  | `'self' 'unsafe-inline'`    | `#user-specified-css` and Vue-injected styles     |
| `img-src`, `media-src`       | `'self' data: blob: https:` | Link previews, avatars, uploaded media            |
| `font-src`                   | `'self' data:`              | Bundled fonts                                     |
| `connect-src`                | `'self' ws: wss: https:`    | The user picks the IRC host; `https:` for uploads |
| `worker-src`, `manifest-src` | `'self'`                    | Service worker and web manifest                   |
| `object-src`, `frame-src`    | `'none'`                    | No plugins, no frames                             |
| `base-uri`, `form-action`    | `'self'` / `'none'`         | No base-tag or form exfiltration                  |

The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`; `webSecurity` stays on. `preload.js` exposes only
`window.seanceShell = {platform, version}`. Navigation outside
`app://seance/`, `target="_blank"` links and `window.open()` are denied and,
for `http(s)` URLs, handed to the OS browser via `shell.openExternal`.

Window bounds (and maximized state) are remembered in
`<userData>/window-state.json` and only restored when they still intersect a
connected display. A single-instance lock keeps one window per user; a second
launch focuses it.

## `web+irc://` links

The shell registers itself as the handler for `web+irc:` with
`app.setAsDefaultProtocolClient` (from source it registers
`electron <this dir>`; the packaged app relies on the `protocols` entry in the
build config so installers/`Info.plist` declare the scheme). `irc:`/`ircs:`
are deliberately not claimed — they name a TCP port the SPA cannot dial; see
`docs/resources/irc-links.md`. Links arrive via
`open-url` on macOS or on the command line of the second instance on
Windows/Linux, and are forwarded to the SPA as
`app://seance/index.html?uri=<encoded link>`. `client/js/boot.ts` parses
`?uri=` on boot and pushes the host/port/TLS/channel onto the Connect route.
Because the SPA only reads `?uri=` at boot, opening a link while connected
reloads the document (and drops the session); a warm hand-off over IPC is a
follow-up.

## Rebranding

Everything visible comes from the SPA build, so follow `docs/resources/branding.md`
first (`config.json`, icons in `public/img/`). Then, in this directory:

- `package.json` `build.appId` is the placeholder `chat.seance.app`. A rebrand
  **must** change it: it is the macOS bundle identifier, the Windows
  `AppUserModelID` and the key under which user data and protocol registrations
  are stored, so two apps sharing it collide.
- `productName` (window title, installer names, `.app` name) comes from
  `public/config.json` `appName` through `electron-builder.cjs`; the static
  value in `package.json` is the fallback. `app.setName()` in `main.js` uses
  the same field at runtime, which also decides the `userData` directory name.
- Icons: `build.icon` points at `public/img/logo-grey-bg-512x512px.png` and
  electron-builder derives the platform icon sets from it; replace that file
  (or point `icon` elsewhere). The runtime Linux window icon uses the same file.
- `package.json` `name`, `description`, `linux.maintainer`, `mac.category`
  are worth updating too.

## Not done

- Auto-update (no `electron-updater`, no update feed).
- Code signing and notarization (macOS, Windows): `yarn dist` output is
  unsigned. Configure `mac.identity`/notarize and `win.certificate*` in the
  build config when a signing identity exists.
- The SPA skips service-worker registration on `app://` because
  `client/js/webpush.ts` only registers on `https:`/localhost; the scheme
  itself supports workers (the smoke probe registers one). Relaxing that check
  to `window.isSecureContext` is a client change.
- Warm `web+irc://` hand-off without reloading (see above), native notifications
  badge/dock counts, tray icon, and a "start minimized" option.
- CI packaging for macOS/Windows (only Linux has been exercised here).
