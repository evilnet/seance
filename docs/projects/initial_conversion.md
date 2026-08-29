# Initial Conversion: Socket.IO bouncer → direct IRCv3-over-WebSocket to nefarious2

## Goal

Replace TheLounge's Node/Socket.IO server with the browser talking IRCv3 directly to nefarious2 over a WebSocket (`text.ircv3.net` style framing — each WS message is one IRC protocol line). The Vue 3 client (`client/`) is kept; the Node server (`server/`) is moved aside. The deliverable is a static SPA that an IRC network can rebrand and ship as a native app (iOS, Android, Electron, PWA) without any bouncer infrastructure.

## Scope and assumptions

- **Single user, single device.** No multi-session sync, no user accounts on our side, no server-side state. SASL handles "auth" by going straight to NickServ/services on the IRC side.
- **Single network at a time** for v1. Multi-network can come back later; it's a UI/storage concern, not a protocol concern.
- **Target ircd is nefarious2's `ircv3.2-upgrade` branch** (`evilnet/nefarious2:ircv3.2-upgrade`, and its `ircv3.2-hardening` successor on MrLenin's fork), not `master`. Decided 2026-08-24. `master` has no WebSocket listener and none of the IRCv3.2 caps; see `docs/resources/nefarious2-websocket.md`. Local dev and the phase C prototype build from that branch.
- **No parallel transports.** Socket.IO is not kept alive next to the new IRC client. Once a network is connected via WebSocket, the Node server is out of the picture entirely — you can't half-translate events.

## Strategy

Move `server/` to `attic/` rather than deleting it — keep it as read-only reference for "how did this thing parse modes" or "what did the kick handler do" without polluting `server/` searches. Stub out everything in the client that used to depend on the server, so the SPA builds and renders even before IRC is wired. Then build the IRC client and turn the stubs into real translations one at a time, in priority order ("can I chat" first, polish later).

The client-side event bus keeps the `socket.on` / `socket.emit` shape so the ~50 call sites across `socket-events/*` and the Vue components don't all need to move on day one. This is a scaffold for the migration, not the end state — once it's all IRC, the bus contract can be reshaped around an IRC-native store and `socket-events/*` can be collapsed into `client/js/irc/`.

# TODO

## 0. Pre-flight discovery

(Independent of demolition — can happen in parallel with phase A or B; blocks phase C.)

1. [x] **Document the nefarious2 WebSocket binding** → `docs/resources/nefarious2-websocket.md`. **Headline:** `master` has no WebSocket or IRCv3.2 support at all; it all lives on the unmerged upstream branch `evilnet/nefarious2:ircv3.2-upgrade` (PR #84, closed unmerged 2026-01-21, still moving). Seance must target that branch.
   - [x] a. Confirm WS URL shape (path, subprotocol — `text.ircv3.net` vs custom), TLS expectations, framing rules.
   - [x] b. Capture the CAP set nefarious2 advertises and which ones we plan to require: `server-time`, `message-tags`, `account-tag`, `echo-message`, `away-notify`, `chghost`, `extended-join`, `multi-prefix`, `userhost-in-names`, `setname`, `cap-notify`, `batch`, `labeled-response`, `draft/chathistory`, `draft/event-playback`.
   - [x] c. Record nefarious2-specific quirks (custom numerics, ISUPPORT tokens, modes) the client must tolerate.
2. [x] **Pick an IRC parser/serializer for the browser** → `docs/resources/browser-irc-parser.md`. **Decision:** hand-roll a ~250-line typed parser in `client/js/irc/`; none of the npm options fit.
   - [x] a. Evaluate `irc-framework` (does it bundle clean for the browser?), `irc-parser-ts`, `@ircv3/parser`, or hand-rolled. Criteria: tag/CAP/batch support, ISUPPORT parsing, no Node built-ins, tree-shakeable.
   - [x] b. Prototype a ~50-line WS-to-parser-to-console loop against a real nefarious2 instance to confirm the choice. _Run 2026-08-24 against a local Docker build of `ircv3.2-upgrade`: `wss://` registers and advertises the full cap set. Two upstream bugs reproduced: plain `ws://` handshake is corrupted by pre-101 auth notices, and inbound frames ≥ 528 bytes disconnect. Transcript in `docs/resources/nefarious2-websocket.md`._
3. [x] **Document the local dev setup**
   - [x] a. Write `docs/resources/nefarious2-dev.md` _Written from source and the branch's Dockerfile; not yet executed._: how to run nefarious2 locally, the test user, the test channel, TLS expectations.

## A. Demolish — move the Node server aside

Goal: `yarn build` produces a static SPA from `client/` only. Nothing in `server/` is on the build path.

1. [x] **Relocate `server/`**
   - [x] a. `git mv server/ attic/server/`.
   - [x] b. Move root `index.ts` and any other server-only entry files (`scripts/generate-config-doc.js`, etc.) into `attic/` alongside it. _Also moved `defaults/config.js` and `.thelounge_home`._
   - [x] c. Add `attic/README.md` explaining: "Reference only. Not built, not tested, not imported. Kept so we can look up how the old server handled things during the IRC migration."
2. [x] **Trim build configuration**
   - [x] a. Remove `server/` from `tsconfig.base.json` references and any project-references graph.
   - [x] b. Exclude `attic/` from ESLint, Prettier, and Stylelint globs.
   - [x] c. Strip server-targeted `package.json` scripts: `build:server`, `start`, server-bound dev variants. Keep `build:client`, `watch`, `lint`, `format:prettier`. Add a `build` alias that just runs `build:client`.
   - [x] d. Leave server-only dependencies in `package.json` for now — cleanup happens in phase E.
3. [x] **Tests**
   - [x] a. Move `test/server.ts`, `test/models/`, `test/plugins/`, `test/commands/` to `attic/test/`. Keep `test/client.ts`, `test/shared/`, `test/tests/`. _Turned out `test/client.ts`, `test/util.ts`, `test/fixtures/`, `test/src/`, and all of `test/tests/` except `build.ts` import from `server/`; those went to `attic/test/` too._
   - [x] b. Update `test/.mocharc.yml` and `test/tsconfig.json` so the remaining client/shared tests still run.
4. [x] **Verification**
   - [x] a. `yarn build` succeeds and produces `public/`.
   - [x] b. `yarn lint` passes (no stray imports from `attic/`).
   - [x] c. Open `public/index.html` against a static file server; confirm the page renders (even if it just shows a loading splash). _`index.html` used to be rendered by the server from `client/index.html.tpl`; it is now a static `client/index.html` copied by webpack with only a `__HASH__` cache-bust substitution (theme fixed to `default`, no package stylesheets, no `public` mode)._

## B. Stub the bus — make the client compile against a no-op transport

Goal: app builds and renders the connect form. Nothing actually connects to anything. Everything that used to round-trip through the server now either returns local data or no-ops with a warning.

1. [x] **Replace `client/js/socket.ts` with a typed event bus**
   - [x] a. New module exporting an object with `on(event, cb)`, `off(event, cb)`, `emit(event, payload)`, `connect()`, `disconnect()` — typed against the current `ServerToClientEvents` / `ClientToServerEvents`.
   - [x] b. Internally just a `Map<event, Set<callback>>`. No transport.
   - [x] c. `emit` for unknown / unhandled events logs `console.warn("[bus] unhandled emit:", event, payload)` so we can spot regressions later.
   - [x] d. Remove `socket.io-client` from the import (leave in `package.json` for now).
2. [x] **Move localStorage-backed concepts off the bus**
   - [x] a. `setting:set` / `setting:get` / `setting:new` / `setting:all` — settings already have a localStorage store (`client/js/store-settings.ts`); make it the source of truth and stop emitting these.
   - [x] b. `sort:networks` / `sort:channels` / `sync_sort:*` — persist to localStorage; no server round-trip.
   - [x] c. `mute:change` / `mute:changed` — local channel state.
   - [x] d. `mentions:get` / `mentions:dismiss` / `mentions:dismiss_all` / `mentions:list` — back with localStorage (or IndexedDB if it grows).
   - [x] e. `history:clear` — local-only.
   - [x] f. `msg:preview:toggle` / `msg:preview` — local preview state, no server.
3. [x] **Stub the rest of the socket-events handlers**
   - [x] a. Leave the files in place; have them subscribe to the bus as before. Since the bus never fires server events yet, they're effectively dormant.
   - [x] b. Delete handlers that are 100% server-concept and won't come back: `sessions_list`, `changelog`, `sign_out`, `configuration` (replace with a static client-built configuration object). _Also deleted `auth`, `search`, `setting`, `sync_sort`, `mute_changed`, `mentions`, `history_clear`; `connection.ts` rewritten (its socket.io reconnect logic could not compile against the bus). Static config in `client/js/configuration.ts`; boot chain in `client/js/boot.ts`._
4. [x] **Stub server-only UI**
   - [x] a. `Settings/Account.vue` (change password, sessions) — replace body with a "Not applicable in client-only mode" note. Keep the route so links don't 404.
   - [x] b. `Windows/Changelog.vue` — pull from a static JSON shipped with the build, or stub.
   - [x] c. `Windows/SearchResults.vue` — render "Search is not available yet" placeholder.
   - [x] d. Upload UI (`upload.ts`, file picker in `ChatInput.vue`) — disable; surface "uploads not configured."
   - [x] e. Push subscription UI in settings — disable.
5. [x] **Repurpose the connect / sign-in screen**
   - [x] a. `Windows/SignIn.vue` and `Windows/Connect.vue`: collapse into a single "Connect to IRC" form — host, port, TLS toggle, nick, optional channel(s) to auto-join, optional SASL account+password (can stay hidden until phase D).
   - [x] b. On submit, the form will eventually call `IrcClient.connect(...)`. For now, just stash the form values in component state and log them.
6. [x] **Verification**
   - [x] a. `yarn build` and `yarn dev` both succeed. _(`yarn dev` no longer exists; verified with `yarn build` + static serve.)_
   - [x] b. Open the app, see the connect form. No console errors. Settings/sort/mute UI flows work entirely against localStorage. _Headless Chromium renders `#connect` with the splash removed and zero console output. Emits still routed through the bus and warning on use (the ones phase C must `handle()`): `input`, `open`, `names`, `more`, `network:get`, `network:edit`._

## C. Minimum IRC — make chatting work

Goal: connect to nefarious2, join one channel, send and receive messages, see joins/parts/quits/nicks/topics/names. Everything you'd expect from a basic IRC client. No SASL yet (unless trivial), no history, no multi-network UI.

1. [x] **`client/js/irc/` skeleton**
   - [x] a. `transport.ts` — open WebSocket _`client/js/irc/transport.ts`; PING/PONG inside; 500-byte guard (#98); live test `test/irc/transport.live.ts` gated on `SEANCE_IRC_URL`._, `send(line)`, `onLine(cb)`, reconnect with exponential backoff, surface open/close/error to the bus as `network:status` / `connecting` / `error`.
   - [x] b. `parser.ts` — wraps the chosen library _Hand-rolled as `message.ts` (+ `casemap.ts`), per §0.2._; produces `IrcMessage { tags, prefix: {nick, ident, host}, command, params }`.
   - [x] c. `cap.ts` — CAP LS 302 _`caps.ts`: pure negotiator, handles `*` continuation, NEW/DEL, `SEANCE_CAPS` list._, REQ for the set decided in §0.1b, CAP END. Track enabled caps. No SASL hookup in v1.
   - [x] d. `isupport.ts` — parse RPL*ISUPPORT \_Accepts both `EXTBAN`/`EXTBANS`.* (005) into `serverOptions` (PREFIX, CHANTYPES, STATUSMSG, CASEMAPPING, NETWORK, CHANMODES).
   - [x] e. `client.ts` — `IrcClient` orchestrating transport+parser+cap+state, emitting bus events.
2. [x] **Connection lifecycle**
   - [x] a. Form submit → `IrcClient.connect({host, port, tls, nick, channels})`.
   - [x] b. After CAP negotiation, send `NICK` and `USER`, wait for `001` (welcome). On `001`, fire synthetic `auth:success`. _No `auth:success` — nothing listens any more; `network` is dispatched at connect for immediate UI feedback._
   - [x] c. After `376`/`422` (end of MOTD), fire synthetic `init` with one `SharedNetwork` containing the configured channels as placeholder `SharedNetworkChan`s. Allocate ids from a monotonic counter owned by `IrcClient`.
   - [x] d. Auto-`JOIN` the configured channels. The JOIN handler (3.a) fills the rest in.
3. [x] **Inbound event translation**
   - [x] a. `PRIVMSG` / `NOTICE` / CTCP `ACTION` → bus `msg`. Time from `@time` tag or now. `msgid` from `@msgid`. `self` true if echo-message tags it as ours. Resolve `chan` id by channel name (or open a query on first PM from a new nick).
   - [x] b. `JOIN` — if self, allocate channel id (if not already) and emit `join`; otherwise push a JOIN message and add user to `chan.users`. Honor `extended-join`'s account+gecos.
   - [x] c. `PART` — if self, emit `part`; otherwise push PART message and remove user.
   - [x] d. `QUIT` — walk every channel that contains the user, push QUIT message and drop them.
   - [x] e. `KICK` — like PART but for the target nick.
   - [x] f. `NICK` — update `network.nick` if self; rename across all channels' user lists.
   - [x] g. `353` / `366` (NAMES) — accumulate during the burst, emit `names` on 366. Parse `multi-prefix` and `userhost-in-names`.
   - [x] h. `TOPIC`, `332`, `333` — set `chan.topic`, push a TOPIC message with setter/time.
   - [x] i. `MODE` — channel prefix changes (op/voice/etc.) update the user in `chan.users`. Other channel modes get a `MODE_CHANNEL` message; user modes get `MODE_USER`. Ban/exception/invite list numerics deferred to phase D.
   - [x] j. `PING` / `PONG` — handled in transport, never reaches the bus.
4. [x] **Outbound input dispatch**
   - [x] a. `client/js/irc/commands/` — port the minimum set from `attic/server/plugins/inputs/`: `/msg`, `/me` (action), `/join`, `/part`, `/nick`, `/topic`, `/quit`, `/raw`. Plain text becomes a `PRIVMSG` to the current channel.
   - [x] b. The dispatcher replaces the `socket.emit("input", {target, text})` consumer — every call site already exists; only the bus subscriber changes.
   - [x] c. The rest of the input commands (`/ban`, `/kick`, `/whois`, `/list`, `/mode`, `/notice`, `/ctcp`, `/away`, `/back`, `/connect`, `/disconnect`, `/rejoin`, `/invite`, `/kill`, `/ignore`, `/ignorelist`, `/mute`) are phase D.
5. [x] **Reconnect**
   - [x] a. On WS close, exponential backoff, re-open, re-register, rejoin the channels we believe we're in. Mark `chan.state = PARTED` while disconnected; clear `chan.users`.
6. [x] **Verification** _(2026-08-24: `test/irc/client.live.ts` against the dev ircd with a TCP peer covers the whole list; headless Chromium end-to-end works only through a header-stripping TLS proxy because of upstream bug #99 — see `docs/resources/nefarious2-websocket.md`.)_
   - [x] a. Connect to nefarious2 from the SPA, join a channel, see the topic, see the names list, send a message, receive your own echo, receive someone else's reply, watch a join/part/quit happen, change your nick, get a "you are not registered" reply for something you typed and have it land in the lobby.

## D. Fill in — un-stub as it gets annoying

No fixed order. Tackle items in whatever sequence the friction dictates.

1. [x] **SASL**
   - [x] a. PLAIN (account + password) wired into CAP negotiation _Done 2026-08-25: `client/js/irc/sasl.ts` state machine + `handlers/sasl.ts`; failure continues registration unless `disconnectOnSaslFail`._ between `CAP REQ` and `CAP END`. Handle `AUTHENTICATE +`, base64 framing, success (903) / failure (904/905).
   - [x] b. EXTERNAL (for client cert / OAUTHBEARER flows) — leave as a stub until needed. _Stub present._
2. [x] **History (`more`)**
   - [x] a. Replace the existing `more` bus event consumer _Done: `client/js/irc/history.ts`; LATEST on first join, BEFORE on `more`, AFTER on re-join; batches in `handlers/batch.ts`; history ids are a negative block below live ids._ with a `CHATHISTORY BEFORE`/`BETWEEN` request and `batch` reassembly.
   - [x] b. Track `moreHistoryAvailable` from batch length. _Full page ⇒ total+1, short page ⇒ total; 15 s timeout keeps the button._
3. [x] **Remaining input commands** — port `/ban`, `/kick`, `/whois`, `/list`, `/mode`, `/notice`, `/ctcp`, `/away`, `/back`, `/invite`, `/kill`, `/rejoin`. `/ignore`/`/ignorelist`/`/mute` become localStorage-backed. `/connect`/`/disconnect` will need phase D.5 (saved networks). _Done 2026-08-25: all listed commands plus `/kickban /umode /op..devoice /server /cycle /invitelist`; WHOIS and LIST result handlers; ignore list in localStorage with hostmask matching. 46 tests._
4. [x] **Channel info numerics**
   - [x] a. Ban list (367/368), invite exception list (346/347), ban exception list (348/349) into the existing special-channel UI. _Done 2026-08-24: `handlers/lists.ts`; +e lists have their own EXCEPTLIST special view (`Special/ListExcepts.vue`) and `/exceptlist`. 14 tests._
5. [x] **Saved network configs**
   - [x] a. Persist the connect form _`client/js/irc/saved-networks.ts` (`thelounge.networks`), picker on Connect, remember-password + autoconnect opt-ins._'s last-used values in localStorage; offer a "saved networks" picker on the connect screen.
   - [x] b. `Windows/NetworkEdit.vue` reads/writes this store _Done; unsupported fields dropped from the form._. `network:get`/`network:edit`/`network:new` route through localStorage.
   - [x] c. Multi-network: one `IrcClient` per network _Registry already handled it; covered by `test/irc/multi-network.ts`. Open: the `connecting` banner is global._, a `NetworkManager` aggregator dispatching by network UUID. Defer the UI side of "switch which network is active" until you actually need it.
6. [x] **STS** — cache STS policy per host in localStorage; upgrade `ws://` to `wss://` when policy says so. _Done 2026-08-25: `client/js/irc/sts.ts`; insecure `port=` → one secure reconnect; secure `duration=` cached; connect-time upgrades persisted to the saved network. 14 tests._
7. [x] **`event-playback` / read markers** _(event-playback with D.2; `draft/read-marker` done 2026-08-25: `handlers/markread.ts`, marker fetched after JOIN, sent debounced on open/own messages, new `markread` bus event. nefarious2 quirk: unauthenticated sessions get `timestamp=*` and no echo of their own MARKREAD — `m_markread.c notify_local_clients()` skips empty accounts; candidate upstream report.)_ — when nefarious2 supports them, use them for reconnect catch-up and unread tracking. Update `firstUnread` from MARKREAD on init.
8. [x] **Search** — decide between: drop, in-memory search of loaded messages, or a small optional preview/search service URL configurable per deploy. _Decided + done 2026-08-24: in-memory over loaded messages (`client/js/search.ts`), reached via the header magnifier and `/search`; extend with a CHATHISTORY provider later. 17 tests._
9. [x] **Link previews** — decide between: drop, client-side `<img>`/`<video>` only for direct media URLs (no metadata fetch), or optional external service URL. _Decided + done 2026-08-24: client-side direct media only (`client/js/helpers/mediaPreview.ts`, https-only, ≤5/msg), `msg:preview` handler deleted, `ExternalPreviewResolver` hook left for a deploy-time service. 18 tests._
10. [x] **Highlight keywords** — port the regex builder from `attic/server/client.ts` into `client/js/highlight.ts`. The settings UI already exists. _Done 2026-08-24: `isHighlight(text, nick, keywords, exceptions?)`, exceptions folded into the regex, IRC formatting stripped first; 28 tests._
11. [ ] **Notifications and push** — keep the `Notification` API path (works in-browser today). Web push needs a tiny relay service; defer or drop. _Decision 2026-08-25: `Notification` API kept and working; web push deferred until a relay exists (or nefarious2's `draft/webpush` matures — it needs VAPID from services). SW push handler removed in D.13; re-add then._ _Exploration and plan (all platforms, grouping/snooze, nefarious2 `draft/webpush` status): `docs/projects/notifications.md` (2026-08-27)._
12. [x] **File uploads** — point at a network-provided uploader endpoint (configurable per deploy) or drop. _Done 2026-08-25: `branding.uploads.endpoint` (https, multipart POST, JSON `{url}` or text); off by default; contract in `docs/resources/branding.md`. 13 tests._
13. [x] **Service worker** — audit `client/service-worker.js`, strip server-coordinated push registration, keep the offline shell. _Done 2026-08-24: fetch handler scoped to same-origin GET, shell precache (index.html + manifest) with offline navigation fallback, `push` handler removed pending D.11, `notificationclick` kept._

## E. Cleanup and shipping

1. [x] **Dependency purge**
   - [x] a. Remove `socket.io`, `socket.io-client`, `express` _Done 2026-08-25: deps 26→6, devDeps 81→63. No browser IRC lib re-added (parser is hand-rolled). `chalk`/`semver`/`got` remain only for `scripts/changelog.js` + `scripts/generate-emoji.js`._, `irc-framework` (the server-side copy — re-add the browser-friendly choice from §0.2 as a client dep), `ldapjs`, `sqlite`, `web-push`, `ws`, `ua-parser-js` (if unused client-side), etc.
   - [x] b. `yarn install`, `yarn build`, `yarn lint`, `yarn test` all clean. _522 mocha passing; coverage 63% statements._
2. [ ] **Bus contract reshape (optional, end-state)**
   - [ ] a. With everything on IRC, the `ServerToClientEvents`/`ClientToServerEvents` types are no longer the right contract. Consider migrating `socket-events/*` into `client/js/irc/handlers/` and reshaping the bus around an IRC-native store. Worth doing only after the dust settles.
3. [x] **Branding hooks**
   - [x] a. `config.json` fetched at boot _Done 2026-08-25: `client/js/branding.ts` + `client/config.json`; runtime for the SPA, build-time for index.html/manifest; see `docs/resources/branding.md`. localStorage keys still `thelounge.*` (migration follow-up)._ for network name, default host/port, theme, branding strings. `manifest.json` parametrized. Audit and replace remaining "The Lounge" strings.
4. [ ] **Native shells**
   - [x] a. Electron wrapper. _Done 2026-08-25: `shells/electron/` (self-contained package; `app://` privileged scheme with CSP, sandboxed preload, `web+irc://` handler, electron-builder; Linux pack + smoke verified; no signing/auto-update)._
   - [x] b. Capacitor (or thin native shell + WebView) for iOS/Android. Note WebSocket + background-keep-alive caveats per platform. _Scaffolded 2026-08-25: `shells/capacitor/` (Capacitor 8, android/ + ios/ generated and synced; `client/js/native.ts` reconnects on foreground and handles the back button). Not compiled here (no Android SDK/Xcode); caveats in its README._
   - [x] c. Chrome PWA. _Done 2026-08-27: manifest reshaped (`scope`, `launch_handler: focus-existing`, `web+irc:` `protocol_handlers`, `any` + `maskable` icons), `client/js/pwa.ts` (service-worker registration, reactive install prompt, `launchQueue` consumer, update detection with a reload in Help), full-shell precache for offline cold starts, `tools/pwa-check.mjs` installability probe; see `docs/resources/pwa.md`._
5. [ ] **Docs**
   - [x] a. Rewrite `CLAUDE.md` to reflect the static-SPA architecture and `attic/` policy. _Done 2026-08-25._
   - [ ] b. Move this file to `docs/archives/` when shipped.

## Sequencing checkpoints

Each milestone is a state you can sit on without rushing to the next:

1. [x] **M1 — Static SPA, no server.** End of phase A. App builds and renders the connect form (which doesn't connect yet). _Reached 2026-08-24. The splash shows while the client tries (and fails) to reach Socket.IO; the connect form appears once phase B stubs the transport._
2. [x] **M2 — Bus stubbed, localStorage features alive.** End of phase B. Settings/sort/mute/mentions all work locally. Connect form is wired to nothing. _Reached 2026-08-24._
3. [x] **M3 — Chat works on one channel of one network.** End of phase C. The bare-minimum IRC client. _Reached 2026-08-24 (verified headlessly + via live tests; real-browser use blocked on nefarious2#99)._
4. [x] **M4 — Daily-driver.** Several phase D items in — SASL, history, saved networks, the input commands you actually use. This is the milestone where you'd stop using whatever IRC client you use now and switch to this. _Reached 2026-08-25: SASL, CHATHISTORY, saved/multi networks, full command set, STS, read markers, search, media previews. Real-browser use needs the `nefarious2:ircv3-fixed` dev image (or upstream landing #97/#98/#99). Not yet used as a daily driver by a human — that's the real test._
5. [x] **M5 — Shippable.** Dependency cleanup, branding hooks, at least one native shell built and installable. _Reached 2026-08-25 on Linux: deps purged, `config.json` branding, Electron AppImage built and smoke-run. Open: code signing/notarization/auto-update, mac/win packaging unexercised, Capacitor apps scaffolded but not compiled, web push, optional E.2 bus reshape. Plan stays in `projects/` until a human has shipped a build._
