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
    "allowCustomServer": false,
    "signIn": true,
    "guestAccess": true
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

| Field                                  | Type                    | Default                             | Notes                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appName`                              | string                  | `"Seance"`                          | Document title, About heading, "Add … to Home screen", notification/protocol-handler name, `<title>` at build time.                                                                                                                                                                                          |
| `shortName`                            | string                  | `appName`                           | Build time only: manifest `short_name`.                                                                                                                                                                                                                                                                      |
| `description`                          | string                  | `"IRC client"`                      | Build time only: manifest `description`.                                                                                                                                                                                                                                                                     |
| `defaultNetwork.name`                  | string                  | host                                | Label shown on the connect form when the host is locked.                                                                                                                                                                                                                                                     |
| `defaultNetwork.host`                  | string                  | —                                   | Required for `defaultNetwork` to count; otherwise the whole object is ignored.                                                                                                                                                                                                                               |
| `defaultNetwork.port`                  | integer                 | 8443 / 8067 by `tls`                | 1–65535; strings are accepted.                                                                                                                                                                                                                                                                               |
| `defaultNetwork.tls`                   | boolean                 | `true`                              |                                                                                                                                                                                                                                                                                                              |
| `defaultNetwork.channels`              | string[]                | none                                | A comma-separated string also works. Names without a prefix get `#`.                                                                                                                                                                                                                                         |
| `defaultNetwork.nick`                  | string                  | empty                               | Every `?` (or `%`, TheLounge style) becomes a random digit: `"guest????"` → `guest4821`.                                                                                                                                                                                                                     |
| `defaultNetwork.lockHost`              | boolean                 | `false`                             | Hide the host/port/TLS fields; the form always connects to `defaultNetwork`.                                                                                                                                                                                                                                 |
| `theme`                                | string                  | `"coffee"`                          | Must be a theme in the build (`coffee`, `creama`, `cobalt`, `frost`, `day`, `morning`; `docs/resources/themes.md`). Applies until the user picks a theme in Settings.                                                                                                                                        |
| `themeColor`                           | `#rgb(a)`/`#rrggbb(aa)` | `#1a1816`                           | `<meta name="theme-color">`; build time also fills the manifest `theme_color` / `background_color`. `coffee`, `creama`, `cobalt` and `frost` set their own once picked.                                                                                                                                      |
| `links.website` / `.help` / `.privacy` | `http(s)` URL           | the Seance repo, its `docs/`, none  | Links in the Help window. Set `privacy` to add a "Privacy policy" link.                                                                                                                                                                                                                                      |
| `links.source`                         | `http(s)` URL           | `https://github.com/evilnet/seance` | The GitHub repository the build comes from: Help's release notes, commit and "Report an issue" links (`client/js/helpers/sourceLinks.ts`). A fork points it at itself.                                                                                                                                       |
| `features.multiNetwork`                | boolean                 | `true`                              | `false` hides Settings → Networks → Add network once one network exists.                                                                                                                                                                                                                                     |
| `features.saveNetworks`                | boolean                 | `true`                              | `false` hides Settings → Networks, "remember password" and "connect automatically" on the connect form.                                                                                                                                                                                                      |
| `features.allowCustomServer`           | boolean                 | `true`                              | `false` behaves like `lockHost` and also ignores hosts from saved networks and `?host=` URL parameters. Requires `defaultNetwork`.                                                                                                                                                                           |
| `features.saslDisconnectOnFail`        | boolean                 | `true`                              | Drop the connection when a network set to log in with SASL does not manage to; see [Failed SASL logins](#failed-sasl-logins).                                                                                                                                                                                |
| `features.signIn`                      | boolean                 | `false`                             | Replace the connect form with an account/password sign-in panel; see [The sign-in panel](#the-sign-in-panel). Needs `defaultNetwork`, and pins the server.                                                                                                                                                   |
| `features.guestAccess`                 | boolean                 | `true`                              | Offer "Connect as guest" on that panel. `false` leaves only the account form, for a network that requires an account.                                                                                                                                                                                        |
| `strings.<key>`                        | string                  | built-in copy                       | Keys: `connect.title`, `connect.savedNetworks`, `connect.savedNetworksEmpty`, `connect.submit`, `connect.signInTitle`, `connect.signInIntro`, `connect.signInSubmit`, `connect.rememberMe`, `connect.guestTitle`, `connect.guestSubmit`, `help.about`, `help.website`, `help.documentation`, `help.privacy`. |
| `uploads`                              | object                  | none (uploads off)                  | Network-provided file uploader; see [Uploads](#uploads). Dropped unless `endpoint` is an `https:` URL.                                                                                                                                                                                                       |
| `uploads.endpoint`                     | `https` URL             | —                                   | Receives a multipart `POST` per file.                                                                                                                                                                                                                                                                        |
| `uploads.maxSizeBytes`                 | integer                 | 10485760 (10 MiB)                   | Client-side limit; larger files are refused with "File … is over the maximum allowed size".                                                                                                                                                                                                                  |
| `uploads.fieldName`                    | string                  | `"file"`                            | Multipart form field carrying the file.                                                                                                                                                                                                                                                                      |
| `uploads.responseUrlKey`               | string                  | `"url"`                             | JSON key holding the public URL in the response.                                                                                                                                                                                                                                                             |
| `uploads.withCredentials`              | boolean                 | `false`                             | Send cookies with the request (`credentials: "include"`).                                                                                                                                                                                                                                                    |
| `uploads.progress`                     | boolean                 | `true`                              | The endpoint answers the CORS preflight (`OPTIONS`) that upload progress needs. `false` sends a plain `POST` from the start (indeterminate bar, no failed preflight).                                                                                                                                        |
| `uploads.headers`                      | object of strings       | none                                | Extra request headers, e.g. `{"X-Api-Key": "…"}`. `Content-Type` is ignored: the browser sets the multipart boundary.                                                                                                                                                                                        |

URL parameters (`?host=…&port=…&nick=…&join=…`, `?uri=web+irc://…`) still pre-fill the form and beat `defaultNetwork`, except for host/port/TLS when the host is locked; a locked deploy answers a link to any other host with a \"link was ignored\" notice instead of applying it. A URL can no longer supply `saslPassword` or `autoconnect`: connecting to a server that is not already saved always takes a click, while a link matching a saved network connects to it directly (see `docs/projects/irc-link-new-server-dialog.md`).

## The sign-in panel

`features.signIn: true` replaces the connect form with a sign-in panel. It is for a deploy that is one network's own client rather than a general IRC client: there is no server to choose, so the first screen asks **who you are**, not where to go.

```json
{
  "appName": "ExampleNet",
  "defaultNetwork": {
    "name": "ExampleNet",
    "host": "irc.example.net",
    "port": 443,
    "tls": true,
    "channels": ["#lobby"],
    "nick": "guest????"
  },
  "features": {"signIn": true, "multiNetwork": false},
  "strings": {
    "connect.signInTitle": "Sign in to ExampleNet",
    "connect.signInIntro": "Use your ExampleNet account, or pick a nick and come in as a guest."
  }
}
```

The panel has **no server fields at all** — it names the network instead — so `signIn` implies `allowCustomServer: false`: a `?host=` URL or a `web+irc://` link to anywhere else is refused the same way a locked deploy refuses it. `brandingFeatures()` resolves both, and turns `signIn` off again if the config has no `defaultNetwork`, since there would be nothing to sign in to.

It offers two ways in:

- **Account and password.** They go out as SASL PLAIN, and the account name becomes the nick, with anything a nick may not contain removed (`nickFromAccount`): services allow spaces and dots that IRC does not. The deploy's `defaultNetwork.channels` are joined either way.
- **Connect as guest**, unless `guestAccess: false`. One nick field, pre-filled from `defaultNetwork.nick` (`"guest????"` → `guest4821`) and editable, because people care what they are called. No SASL, and nothing is kept for next time.

"Stay signed in on this device" — shown only when `saveNetworks` is on — stores the password **and** sets the network to connect on its own, which is what makes the panel a first-run screen rather than a screen you meet every visit. A guest is never remembered, so a guest always sees it again.

A sign-in deploy keeps **one saved network**, whatever changes about the way in. Signing in as someone else, or coming back as a guest, replaces the entry rather than adding to it — `findMatching` keys on the nick, and a guest's nick differs every visit, so without that rule the list would fill up with near-identical entries nobody can see (`multiNetwork: false` hides the network UI).

A **refused login stands the entry down**: `saslDisconnectOnFail` drops the connection (see below), and the manager clears that network's `autoconnect`, so the next visit shows the panel again instead of retrying credentials the server has already refused at every page load, with no route back to the panel to fix them.

A refusal is reported in the network's lobby, and the view follows it there (`network:aborted`, bus-contract §1.2): the connect flow has opened an autojoin channel by then, and an empty channel with the explanation behind an unread badge is not a report.

Browser check: `tools/scenarios/sign-in.mjs` (the panel, a guest, a refused login, and the one-entry rule) — `yarn test` renders no component, so the panel is only ever verified there.

## Failed SASL logins

When a network is configured with "Username + password (SASL PLAIN)" and the login does not succeed, Seance reports why and **drops the connection** — it does not quietly register you as an unauthenticated stranger. `features.saslDisconnectOnFail: false` restores the old behaviour: the same report, but the connection carries on.

"Does not succeed" is deliberately wide, because every one of these leaves the user logged out when they asked to be logged in:

- no account name or password is configured (caught before `CAP LS`, so nothing is sent);
- the server does not offer the `sasl` capability, or offers it without `PLAIN` (the message names what it does offer);
- the server `NAK`s `sasl`;
- the server answers `902`, `904`, `905`, `906` or `907` — its text is quoted verbatim, so "invalid credentials", "service unavailable" or nefarious2's `FAIL AUTHENTICATE VERIFICATION_REQUIRED` reach the user;
- nothing arrives within 12 s, or the mechanism gets a challenge it cannot answer.

The lobby then shows the reason, `Not connecting to <host> without the login you asked for.` and what to try; the client sends `QUIT` and does not reconnect, so credentials can be fixed in the network's settings without a reconnect loop. Nothing about this reaches the wire beyond the `QUIT`: the ircd decides on its own whether an unauthenticated client may register at all.

Leave it on for a network whose users expect an account (channel access, host masks, a bouncer session keyed to the account); turn it off for a public deploy where connecting anyway is more useful than not connecting at all.

## Uploads

Seance has no server of its own, so the file goes straight from the browser to an uploader the network runs. Files reach it by drag & drop anywhere on the page, by pasting an image into the input, or from the paperclip button. Whichever way they arrive, the client first shows them in a confirmation dialog (`UploadPreview.vue`: the image itself, a muted video or an audio control, name, size and dimensions, and a note saying whether metadata will be removed) and sends only what the user keeps; while a file is going up, a progress strip above the message input shows its name, position in the batch and percentage, with a cancel button. Running that service is the network's responsibility; Seance only needs it to honour this contract:

- **Request**: `POST` to `uploads.endpoint` with a `multipart/form-data` body whose `uploads.fieldName` field (default `file`) holds the file, filename included. Any `uploads.fields` are sent as extra form fields and any `uploads.headers` as headers; cookies only when `uploads.withCredentials` is `true`.
- **CORS**: the endpoint is on another origin, so its `POST` response must carry `Access-Control-Allow-Origin` for the app's origin (plus `Access-Control-Allow-Headers` for any custom headers, `Access-Control-Allow-Credentials: true` when cookies are used, and an `OPTIONS` answer when either of those makes the request non-simple). Without that header the browser blocks the response even though the upload itself succeeded, so the user sees "Upload failed: Failed to fetch".
- **Progress needs a preflight.** Upload progress events come from `XMLHttpRequest`, and an XHR with an upload listener is never a "simple" request: the browser sends an `OPTIONS` preflight before the `POST`. An uploader that answers it with a 2xx and the CORS headers gets a live percentage; one that does not (litterbox answers 405) still works — the client notices the request died before any byte went out, retries it as a plain `POST` without the listener, and remembers for the rest of the page that this endpoint cannot report progress, so the strip shows an indeterminate bar instead of a percentage. Answering `OPTIONS` is the one thing an uploader can add to get the percentage back. A deploy that knows its uploader refuses `OPTIONS` sets `uploads.progress: false` and spares the console that one failed preflight per page; the `catbox-litterbox` preset does.
- **Response**: `2xx` with either a JSON body holding the URL at `uploads.responseUrlKey` (default `url`) or a plain-text body that is the URL. Relative URLs resolve against the endpoint. The key may be a dotted path into nested objects and arrays, e.g. `results.0.filePath`. On failure, a non-`2xx` status or an error message at `uploads.responseErrorKey` (default `error`), which is shown to the user verbatim; otherwise "Upload failed: HTTP _status_".

The client checks `uploads.maxSizeBytes` before sending and refuses types outside `uploads.accept` (exact MIME types or `type/*` wildcards) without contacting the endpoint. The uploader should enforce its own limit, authentication and retention rules, since anyone with the app can call it. With `uploads` absent the upload button is hidden and dropped or pasted files are ignored after a single "File uploads are not configured in this client." notice. **The stock `config.json` ships `catbox-litterbox` enabled**, so the reference deploy at [evilnet.github.io/seance](https://evilnet.github.io/seance/) can share files out of the box; a network that does not want a third-party host removes the `uploads` key. It lives in `config.json` rather than in the code defaults precisely so that deleting it works — a default in `DEFAULT_BRANDING` would be inherited by every deploy with no way to opt out.

`uploads.optionalFields` names fields that may be dropped for one retry when the uploader's error message blames them — the fallback that lets an upload through when the service cannot strip metadata off that particular file.

A minimal uploader is a few dozen lines (an nginx `client_body` handler script, or a small web function that writes to object storage and returns its URL); those recipes are out of scope here.

### The network's own upload host (`draft/FILEHOST`)

A network can skip all of the above by advertising an upload host itself. When the server's ISUPPORT carries `draft/FILEHOST=<url>` (or soju's `soju.im/FILEHOST`), Seance uses it **instead of** `uploads` for that network, no `config.json` entry needed — it is the network's service and the upload is attributed to the user's IRC account, with no credentials involved. The exchange is IRCv3 `draft/authtoken` ([PR #602](https://github.com/ircv3/ircv3-specifications/pull/602)) plus `draft/FILEHOST` ([PR #562](https://github.com/ircv3/ircv3-specifications/pull/562)): the client asks the ircd for a one-shot token (`TOKEN GENERATE FILEHOST #channel`, answered with `TOKEN GENERATE FILEHOST :<token>` or a `draft/authtoken` batch of chunks), POSTs the raw file to the URL with `Authorization: Bearer <token>`, `Content-Type` and `Content-Disposition`, and expects `201 Created` with a `Location` header (a JSON `url` is accepted too). The `Authorization` header makes the request preflighted, so the host must answer `OPTIONS` with CORS headers (the draft requires `OPTIONS`; `Access-Control-Allow-Headers` must list `Authorization`, and `Access-Control-Expose-Headers: Location` lets the client read the URL). A plain `http:` upload URL is refused over an encrypted IRC connection, as the draft says. `FAIL TOKEN …` from the server (no account, a channel the user is not in) is shown as the upload's error. nefarious2's `ircv3.2-upgrade` implements the server side (`Authtoken "FILEHOST" { … }`); the reference host is [PASTE](https://github.com/boxlabss/PASTE)'s `filehost.php`.

### Presets

`uploads.preset` fills in the wire details of a known service; anything given alongside it wins, so a deploy can point the same format at its own instance.

The binding constraint on a third-party uploader is not its feature list but **CORS**: the browser discards the response unless it carries `Access-Control-Allow-Origin`, however well the upload itself went. Most such services are built for curl and ShareX, which never have to meet that rule, so a preset is only worth adding for an endpoint checked against it. `docs/projects/boxlabs-paste-uploads.md` § Survey records what was tested and when.

| Preset             | Service                                                                                                                                                                                                                                 | Works from a browser                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `catbox-litterbox` | [Litterbox](https://litterbox.catbox.moe/), catbox's temporary sibling. Anonymous, no account or userhash; answers with the URL as plain text. Images **and video**, up to 1 GB. Uploads expire: `time` is `1h`, `12h`, `24h` or `72h`. | **Yes** — sends `Access-Control-Allow-Origin: *`; no `OPTIONS` (405), so the preset sets `progress: false`: indeterminate bar, no percentage |
| `boxlabs-paste`    | The anonymous image staging endpoint of [PASTE](https://github.com/boxlabss/PASTE), `https://paste.boxlabs.uk/img/` — the one poxchat uploads pasted images to. No API key. Images only, 10 MiB.                                        | **Not yet** — no CORS header, see below                                                                                                      |

```json
{
  "appName": "ExampleNet",
  "uploads": {"preset": "catbox-litterbox"}
}
```

`fields` merges with the preset's per key, so one can be changed on its own — a shorter retention, say, without restating `reqtype`:

```json
{"uploads": {"preset": "catbox-litterbox", "fields": {"time": "1h"}, "maxSizeBytes": 33554432}}
```

Capping `maxSizeBytes` below the service's own limit is still worth considering even where the progress strip shows real byte counts: a gigabyte over a phone connection is a long wait either way, and against litterbox the bar is indeterminate (see the preflight note above). Overriding `endpoint` is how a deploy aims a preset's wire format at its own instance.

`boxlabs-paste` expands to `images[]` as the file field, `strip_exif=1` as an extra field (dropped and retried once if the server says stripping is what failed), `results.0.filePath` / `results.0.error` as the response paths, a 10 MiB limit and PNG/JPEG/GIF/WebP as the accepted types. The endpoint is `/img/`: it takes images, not video, so a dropped video is refused with a message naming the types it does take.

> **`paste.boxlabs.uk/img/` does not send `Access-Control-Allow-Origin` today** (checked 2026-08-28: the `POST` response carries no CORS header and `OPTIONS` answers `405`). Until the operator adds it, uploads from a browser fail even though the file lands on the server. Nothing in the client can work around it — the response body is unreadable without it, and the URL is server-generated, so there is nothing to guess. An API key is _not_ a workaround: `api.php` on the same host does send CORS headers, but it only handles text pastes, and CORS is orthogonal to authentication. Self-hosted PASTE instances that add their own `/img/` need the same header in their nginx or Apache config.

Because that service strips EXIF itself, the "Attempt to remove metadata from images before uploading" setting (which re-encodes through a canvas) is belt-and-braces with `boxlabs-paste` rather than the only defence. With `catbox-litterbox` nothing strips metadata server-side, so the setting is the only thing removing EXIF from a pasted photo. The re-encode keeps a single frame, so it skips GIF and SVG and — after reading the container header (`client/js/helpers/animatedImage.ts`: the WebP `VP8X` animation flag, a PNG `acTL` chunk, an AVIF `avis` brand) — any animated WebP, APNG or AVIF sequence, which go up byte for byte with their metadata; the confirmation dialog says which it will be. A browser that cannot encode the source format (Safari for WebP, all of them for AVIF) answers with PNG, and the uploaded file then carries that type and a `.png` extension rather than claiming to be what it no longer is.

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

`index.html` hard-codes `msapplication-TileColor` (`#0D0E14`, matching the icon tiles); `theme-color` and the manifest's `theme_color`/`background_color` come from `themeColor` in `config.json`, defaulting to `#1a1816` (the `coffee` theme's chrome tone).

## Subpath deploys

`config.json` is resolved relative to the document (`new URL("config.json", document.baseURI)`), so serving from `https://host/chat/` or through a `<base href>` works as long as the file sits next to `index.html`. The service worker treats it like any other same-origin asset (network first, cache fallback), so the last fetched copy is still used offline.

## Follow-ups

- **localStorage keys** still use the `thelounge.*` prefix (`thelounge.networks`, `thelounge.mentions`, `thelounge.sort.*`, `thelounge.state.*`, `thelounge.ignore.*`, `thelounge.muted`, `thelounge.networks.collapsed`, `thelounge.media.trusted`, and `settings`). They are deliberately untouched: renaming them would drop every user's saved networks and settings. A rename needs a one-off migration.
- `features.saveNetworks: false` hides the saved-network UI, but `client/js/irc/manager.ts` still records the last-used network in localStorage. Make persistence conditional there.
- The Changelog window links to the release's notes on GitHub (`links.source`) rather than bundling them; a deploy that wants its own notes has nothing to hook into yet.
- Native shells (E.4) can call `setBranding()` from `client/js/branding.ts` instead of fetching, if they bundle the config.
