# Branding a deploy

Seance is a static SPA: `yarn build` writes everything to `public/`, and an IRC network ships that directory as its own client. Two layers of branding exist:

| Layer          | Source                                 | Applied when    | Covers                                                                                                              |
| -------------- | -------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Runtime**    | `public/config.json` (fetched)         | Every page load | Everything the Vue app renders: title, connect-form defaults, help links, UI strings, feature flags, default theme  |
| **Build-time** | `client/config.json` (read by webpack) | `yarn build`    | `index.html` `<title>`, `application-name`, `theme-color`, the loading splash text, and the web app manifest fields |

Both read the **same file**: `client/config.json` is copied to `public/config.json` unchanged. A deploy that only edits `public/config.json` gets full runtime branding without rebuilding; the pre-JavaScript bits (browser tab title before boot, PWA manifest name, splash text) keep whatever was in `client/config.json` at build time. Rebuild (or overwrite those files, see below) to change them.

`client/js/branding.ts` owns the schema, defaults and loader. `boot.ts` awaits `loadBranding()` before anything renders, commits the result to `store.state.branding`, sets `document.title`, and folds `theme` / `themeColor` / `uploads` into the configuration.

## `config.json` schema

```json
{
  "appName": "TestNet IRC",
  "shortName": "TestNet",
  "description": "Chat on TestNet from your browser",
  "defaultNetwork": {
    "name": "TestNet",
    "host": "irc.testnet.example",
    "port": 8443,
    "tls": true,
    "channels": ["#lobby", "#help"],
    "nick": "guest????",
    "lockHost": true
  },
  "theme": "morning",
  "themeColor": "#1d3557",
  "links": {
    "website": "https://testnet.example/",
    "help": "https://testnet.example/help",
    "privacy": "https://testnet.example/privacy"
  },
  "features": {
    "multiNetwork": false,
    "saveNetworks": true,
    "allowCustomServer": false
  },
  "strings": {
    "connect.title": "Join TestNet",
    "connect.submit": "Join"
  },
  "uploads": {
    "endpoint": "https://files.testnet.example/upload",
    "maxSizeBytes": 10485760
  }
}
```

Every field is optional; `{"appName": "Seance"}` (the shipped default) is a complete file. Unknown or malformed fields are dropped one by one and the rest still applies. A missing file, a 404 or invalid JSON falls back to the defaults with a single `console.warn`.

| Field                                  | Type                    | Default                            | Notes                                                                                                                                                               |
| -------------------------------------- | ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appName`                              | string                  | `"Seance"`                         | Document title, About heading, "Add … to Home screen", notification/protocol-handler name, `<title>` at build time.                                                 |
| `shortName`                            | string                  | `appName`                          | Build time only: manifest `short_name`.                                                                                                                             |
| `description`                          | string                  | `"IRC client"`                     | Build time only: manifest `description`.                                                                                                                            |
| `defaultNetwork.name`                  | string                  | host                               | Label shown on the connect form when the host is locked.                                                                                                            |
| `defaultNetwork.host`                  | string                  | —                                  | Required for `defaultNetwork` to count; otherwise the whole object is ignored.                                                                                      |
| `defaultNetwork.port`                  | integer                 | 8443 / 8067 by `tls`               | 1–65535; strings are accepted.                                                                                                                                      |
| `defaultNetwork.tls`                   | boolean                 | `true`                             |                                                                                                                                                                     |
| `defaultNetwork.channels`              | string[]                | none                               | A comma-separated string also works. Names without a prefix get `#`.                                                                                                |
| `defaultNetwork.nick`                  | string                  | empty                              | Every `?` (or `%`, TheLounge style) becomes a random digit: `"guest????"` → `guest4821`.                                                                            |
| `defaultNetwork.lockHost`              | boolean                 | `false`                            | Hide the host/port/TLS fields; the form always connects to `defaultNetwork`.                                                                                        |
| `theme`                                | string                  | `"default"`                        | Must be a theme in the build (`default`, `morning`). Applies until the user picks a theme in Settings.                                                              |
| `themeColor`                           | `#rgb(a)`/`#rrggbb(aa)` | `#415364`                          | `<meta name="theme-color">`; build time also fills the manifest `theme_color` / `background_color`.                                                                 |
| `links.website` / `.help` / `.privacy` | `http(s)` URL           | the Seance repo, its `docs/`, none | Links in the Help window. Set `privacy` to add a "Privacy policy" link.                                                                                             |
| `features.multiNetwork`                | boolean                 | `true`                             | `false` hides the sidebar "connect" button once one network exists.                                                                                                 |
| `features.saveNetworks`                | boolean                 | `true`                             | `false` hides the saved-networks picker, "remember password" and "connect automatically" on the connect form (see follow-ups).                                      |
| `features.allowCustomServer`           | boolean                 | `true`                             | `false` behaves like `lockHost` and also ignores hosts from saved networks and `?host=` URL parameters. Requires `defaultNetwork`.                                  |
| `strings.<key>`                        | string                  | built-in copy                      | Keys: `connect.title`, `connect.savedNetworks`, `connect.savedNetworksEmpty`, `connect.submit`, `help.about`, `help.website`, `help.documentation`, `help.privacy`. |
| `uploads`                              | object                  | none (uploads off)                 | Network-provided file uploader; see [Uploads](#uploads). Dropped unless `endpoint` is an `https:` URL.                                                              |
| `uploads.endpoint`                     | `https` URL             | —                                  | Receives a multipart `POST` per file.                                                                                                                               |
| `uploads.maxSizeBytes`                 | integer                 | 10485760 (10 MiB)                  | Client-side limit; larger files are refused with "File … is over the maximum allowed size".                                                                         |
| `uploads.fieldName`                    | string                  | `"file"`                           | Multipart form field carrying the file.                                                                                                                             |
| `uploads.responseUrlKey`               | string                  | `"url"`                            | JSON key holding the public URL in the response.                                                                                                                    |
| `uploads.withCredentials`              | boolean                 | `false`                            | Send cookies with the request (`credentials: "include"`).                                                                                                           |
| `uploads.headers`                      | object of strings       | none                               | Extra request headers, e.g. `{"X-Api-Key": "…"}`. `Content-Type` is ignored: the browser sets the multipart boundary.                                               |

URL parameters (`?host=…&port=…&nick=…&join=…&autoconnect=1`, `?uri=web+irc://…`) still pre-fill the form and beat `defaultNetwork`, except for host/port/TLS when the host is locked.

## Uploads

Seance has no server of its own, so the file goes straight from the browser to an uploader the network runs. Running that service is the network's responsibility; Seance only needs it to honour this contract:

- **Request**: `POST` to `uploads.endpoint` with a `multipart/form-data` body whose `uploads.fieldName` field (default `file`) holds the file, filename included. Any `uploads.headers` are sent along; cookies only when `uploads.withCredentials` is `true`.
- **CORS**: the endpoint is on another origin, so it must answer the preflight and the `POST` with `Access-Control-Allow-Origin` for the app's origin (plus `Access-Control-Allow-Headers` for any custom headers, and `Access-Control-Allow-Credentials: true` when cookies are used).
- **Response**: `2xx` with either a JSON object `{"url": "https://…"}` (the key is `uploads.responseUrlKey`) or a plain-text body that is the URL. Relative URLs resolve against the endpoint. On failure, a non-`2xx` status; a JSON `{"error": "…"}` body is shown to the user verbatim, otherwise "Upload failed: HTTP _status_".

The client checks `uploads.maxSizeBytes` before sending; the uploader should enforce its own limit, authentication and retention rules, since anyone with the app can call it. With `uploads` absent the upload button is hidden and dropped or pasted files are ignored after a single "File uploads are not configured in this client." notice.

A minimal uploader is a few dozen lines (an nginx `client_body` handler script, or a small web function that writes to object storage and returns its URL); those recipes are out of scope here.

## Files a rebranded deploy overwrites in `public/`

`config.json` covers the app itself. Icons and the manifest are static files; replace them with your own after building (or before, in `client/`, so the build copies them):

- `manifest.webmanifest` — the build already fills `name`, `short_name`, `description`, `theme_color`, `background_color` from `client/config.json`. Overwrite it to change the icon list; keep `start_url`/`scope` (`./`), `launch_handler`, `protocol_handlers` and the separate `any`/`maskable` icon entries, which the installed-app behaviour depends on (see `pwa.md`). Keep the filename: `client/service-worker.js` precaches it by name and `index.html` links it.
- `favicon.ico` and `img/favicon-alerted.ico` — browser tab, normal and the "unread highlight" variant (`client/js/vue.ts` swaps between them).
- `img/icon-192.png`, `img/icon-512.png` — manifest `purpose: any`, and the notification icon.
- `img/icon-maskable-192.png`, `img/icon-maskable-512.png` — manifest `purpose: maskable`. Keep the artwork inside the central 80% and the background full-bleed, so Android/ChromeOS can round or circle-crop them.
- `img/apple-touch-icon-120.png`, `-152.png`, `-167.png`, `-180.png` — iOS home screen, and the two Windows `msapplication-square*logo` tiles. These must be opaque; iOS ignores transparency and composites on black.
- `img/logo-tile.png` — the sidebar logo (45px tall) and the loading splash. One image serves both light and dark themes, so it needs its own background rather than relying on the page behind it.
- `img/logo-art.png`, `img/logo-art-wide.png` — the bare artwork, transparent. Not referenced by the shipped markup; available for docs, README headers and native-shell assets.

There is no Safari pinned-tab icon. `mask-icon` needs a single-colour SVG silhouette, which the raster artwork cannot supply, so the `<link>` was removed and Safari falls back to the favicon. Add one if your mark is vector.

Notifications set `icon` but no `badge`. A badge must be a monochrome silhouette; supply one and add `badge:` in `client/service-worker.js` and `client/js/socket-events/msg.ts` if you have artwork that suits it.

`index.html` hard-codes `msapplication-TileColor` (`#0D0E14`, matching the icon tiles); `theme-color` and the manifest's `theme_color`/`background_color` come from `themeColor` in `config.json`, defaulting to `#415364`.

## Subpath deploys

`config.json` is resolved relative to the document (`new URL("config.json", document.baseURI)`), so serving from `https://host/chat/` or through a `<base href>` works as long as the file sits next to `index.html`. The service worker treats it like any other same-origin asset (network first, cache fallback), so the last fetched copy is still used offline.

## Follow-ups

- **localStorage keys** still use the `thelounge.*` prefix (`thelounge.networks`, `thelounge.mentions`, `thelounge.sort.*`, `thelounge.state.*`, `thelounge.ignore.*`, `thelounge.muted`, `thelounge.networks.collapsed`, and `settings`). They are deliberately untouched: renaming them would drop every user's saved networks and settings. A rename needs a one-off migration.
- `features.saveNetworks: false` hides the saved-network UI, but `client/js/irc/manager.ts` still records the last-used network in localStorage. Make persistence conditional there.
- The Changelog window still says "based on The Lounge x.y.z" on purpose (upstream attribution); the "Report an issue" link in Help still points at the upstream tracker.
- Native shells (E.4) can call `setBranding()` from `client/js/branding.ts` instead of fetching, if they bundle the config.
