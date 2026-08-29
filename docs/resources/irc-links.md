# `web+irc:` links

Seance speaks IRC over a WebSocket. A classic `irc://host:6667/#chan` link
names a **TCP** endpoint, and a browser cannot open a TCP socket — feeding
that port to `buildUrl()` would dial `ws://host:6667/`, which is not where a
WebSocket listener lives. So we do not claim `irc:`/`ircs:` anywhere; we
define our own scheme instead.

    web+irc://host[:port][/#channel[,#channel…]]

- Always `wss://`. A page served over https cannot open a plain `ws://` socket
  anyway, so a link never means cleartext; plain `ws://` stays a dev case you
  type into the connect form.
- No port means **443** — `wss://host/`, what a public deploy should serve.
- Channels may sit in the path or the fragment, comma-separated, with or
  without a leading `#` (`client/components/Windows/Connect.vue` normalises).
- A link only ever **pre-fills the connect form**. Nothing connects, and
  nothing is saved, until the user clicks.

`irc:`/`ircs:` links are still parsed if one reaches us by hand (`?uri=`), for
their host and channels; their port is dropped and 443 assumed.

## Why `web+irc:` and not `wirc:`

A web app may only register a handler for a scheme on the HTML spec's fixed
safelist (`irc`, `ircs`, `matrix`, `mailto`, …) **or** for one prefixed
`web+` followed by ASCII lowercase letters. That rule governs both
`navigator.registerProtocolHandler()` and the manifest's `protocol_handlers`,
so a made-up `wirc:` would be rejected by every browser while `web+irc:` works
today with nobody's permission. The `web+` space is reserved by the spec for
exactly this and needs no registration.

If a bare scheme were ever wanted for native shells, IANA's URI scheme
registry (RFC 7595) has a _provisional_ tree that only needs a template and
expert review on `uri-review@ietf.org` — no RFC. `irc:` and `ircs:` are
themselves only provisional registrations, from the never-finished
[`draft-butcher-irc-url`](https://tools.ietf.org/html/draft-butcher-irc-url-04).
Registering is the easy part; getting other clients and websites to _emit_ the
scheme is the whole cost, which is why nothing here depends on it.

## Where it is wired

| Place                                      | What it does                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `client/manifest.webmanifest`              | `protocol_handlers`: the installed PWA claims `web+irc` → `./?uri=%s`      |
| `client/components/Settings/General.vue`   | pre-install equivalent, `registerProtocolHandler("web+irc", …)`, in a tab  |
| `client/js/helpers/parseIrcUri.ts`         | `?uri=` → `{name, host, port, join, tls}`                                  |
| `client/js/boot.ts`                        | `handleQueryParams()` pushes those onto the `Connect` route                |
| `client/js/pwa.ts`                         | `launchQueue`: a link with the app already open does not reload it         |
| `shells/electron/main.js` + `package.json` | `setAsDefaultProtocolClient("web+irc")`, argv/`open-url`, electron-builder |
| `test/tests/build.ts`                      | asserts the built manifest still carries the handler                       |

Not wired yet: the Capacitor shells (an Android `intent-filter` and iOS
`CFBundleURLTypes` entry would do it), and matching a link against saved
networks instead of always opening the connect form — see
`docs/projects/irc-link-new-server-dialog.md`.
