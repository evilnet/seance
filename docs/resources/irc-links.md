# `web+irc:` links

Seance speaks IRC over a WebSocket. A classic `irc://host:6667/#chan` link
names a **TCP** endpoint, and a browser cannot open a TCP socket — feeding
that port to `buildUrl()` would dial `ws://host:6667/`, which is not where a
WebSocket listener lives. So the web app does not claim `irc:`/`ircs:`; we
define our own scheme instead.

    web+irc://host[:port][/#channel[,#channel…]]

`web+ircs://` is the same scheme under the name people expect from `ircs:`, and
means exactly the same thing: both always dial `wss://`.

- Always `wss://`. A page served over https cannot open a plain `ws://` socket
  anyway, so a link never means cleartext; plain `ws://` stays a dev case you
  type into the connect form.
- No port means the **saved TLS network on that host**, whatever port it uses
  (a network's direct servers rarely sit on 443; a saved cleartext entry never
  matches); with none saved, **443** —
  `wss://host/`, what a public deploy should serve.
- Channels may sit in the path or the fragment, comma-separated, with or
  without a leading `#` (`client/components/Windows/Connect.vue` normalises).
- A link is a **suggestion**. If its host + port match a saved network, that
  server was approved before: Seance connects to (or focuses) it and joins
  the channels. Anything else opens the connect form pre-filled, with a
  banner naming what the link asked for — nothing connects and nothing is
  saved until the user clicks. Locked deploys (`lockHost` /
  `allowCustomServer: false`) refuse links to other hosts with a message.
  A URL can never supply a password, and `?autoconnect=1` is not honoured
  from URLs (`client/js/helpers/linkTarget.ts` decides, `boot.ts` applies).

In a browser, `irc:`/`ircs:` links are still parsed if one reaches us by hand
(`?uri=`), for their host and channels; their port is dropped and 443 assumed.

## `irc:` and `ircs:` in the app

The app shell can dial IRC over TCP (`shells/tauri/src-tauri/src/socket.rs`),
so there an `irc:`/`ircs:` link means what
[`draft-butcher-irc-url`](https://tools.ietf.org/html/draft-butcher-irc-url-04)
says: TCP, cleartext on 6667 for `irc://`, TLS on 6697 for `ircs://`, or the
port the link names. `web+irc(s):` keep meaning `wss://` everywhere. The same
rules hold, plus:

- The match is **transport-aware**: a TCP link prefers a saved TCP network,
  and falls back to the same host saved over WebSocket (and the other way
  round) before offering the form, since the user approved that server
  already and chose how to reach it.
- **Upgrade, never downgrade**: an `ircs://` (or `web+irc:`) link never
  matches a cleartext network. A plain `irc://` link prefers a saved TLS
  network on its host, over either transport and whatever port it names.
- A plain `irc://` link to a new server says in the form that the
  connection would not be encrypted; nothing tries TLS behind the user's
  back (some networks have none).
- Only the host, port, path and fragment are read: userinfo
  (`irc://user:pass@host`) and the query never reach the form.
- The shell's socket limits (bad ports, the first-line IRC check, the open
  rate) apply behind the form as they do to a typed server.

Who receives them: the phones claim all four schemes in their manifests,
macOS declares `irc`/`ircs` in its bundle, and Windows and Linux take them
only from Settings → General → "Open irc:// and ircs:// links", because
claiming a scheme there takes it from HexChat or Konversation
(`shells/tauri/README.md` § Links).

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

| Place                                    | What it does                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `client/manifest.webmanifest`            | `protocol_handlers`: the installed PWA claims `web+irc`, `web+ircs` → `./?uri=%s`                           |
| `client/components/Settings/General.vue` | pre-install equivalent, `registerProtocolHandler` for both, in a tab                                        |
| `client/js/helpers/parseIrcUri.ts`       | `?uri=` → `{name, host, port, join, tls, transport}`                                                        |
| `client/js/helpers/linkTarget.ts`        | matches the link against saved networks / deploy policy; strips secrets                                     |
| `client/js/boot.ts`                      | `handleQueryParams()` pushes those onto the `Connect` route                                                 |
| `client/js/pwa.ts`                       | `launchQueue`: a link with the app already open does not reload it                                          |
| `shells/tauri/src-tauri/src/lib.rs`      | deep-link plugin (`web+irc(s)`; `irc`, `ircs` on the phones, macOS, or on request), argv → `App.appUrlOpen` |
| `test/tests/build.ts`                    | asserts the built manifest still carries the handler                                                        |

Matching a link against saved networks
landed 2026-09-05 — see `docs/projects/irc-link-new-server-dialog.md`.
