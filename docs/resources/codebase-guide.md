# Codebase guide

The long form of `CLAUDE.md` as it stood on 2026-11-02, before it was cut down; the longest bullets are now sections of the files beside this one.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Seance** is TheLounge's Vue 3 client turned into a static, bouncer-less IRC client. The browser speaks IRCv3 directly to **nefarious2** (EvilNet's ircd) over a WebSocket — one IRC line per WS message, `text.ircv3.net` subprotocol — with no Node server in between. The target ircd is nefarious2's **`ircv3.2-upgrade` branch** (`master` has neither WebSocket nor the IRCv3.2 caps). Goal: a `public/` tree an IRC network can rebrand via `config.json` and ship as its own web/PWA/native client.

**Status** (see `docs/projects/initial_conversion.md` for the checklist): phases 0 (discovery), A (server moved to `attic/`), B (bus stubbed), C (minimum IRC) are done; D (fill-in) is done except D.7 read markers/`MARKREAD` and D.11 web push (both deferred); E is in progress — E.3 branding is done, E.1 dependency purge is underway, E.2 bus-contract reshape is optional, E.4 native shells not started. Milestones M4 (daily-driver) and M5 (shippable) are not yet ticked.

Upstream is still `github.com/thelounge/thelounge`; divergence only grows. localStorage keys are still `thelounge.*` (renaming needs a migration). Node.js 22.22.2+, 24.15+ or 26+ (CI and `.node-version`: 26), pnpm, MIT licensed.

## Common commands

pnpm, at the version `package.json`'s `packageManager` names (`npm i -g pnpm@12.16.1`; pnpm does not switch itself, because that writes a two-document lockfile GitHub's dependency graph cannot read). Node 25+ ships no corepack, and pnpm advises against it anyway. Dependency install scripts run only when `pnpm-workspace.yaml`'s `allowBuilds` names them.

| Task                                                      | Command                                           |
| --------------------------------------------------------- | ------------------------------------------------- |
| Install deps                                              | `pnpm install`                                    |
| Build the SPA (Vite → `public/`)                          | `pnpm build` (`NODE_ENV=production` for prod)     |
| Compile the locale catalogs (`pnpm build` runs it)        | `pnpm i18n:compile`                               |
| Check the pot against the `t()` call sites                | `pnpm i18n:check`                                 |
| Rebuild on change                                         | `pnpm watch`                                      |
| Serve the built SPA                                       | `python3 -m http.server -d public 8000`           |
| Serve the SPA and an ircd WS proxy on one HTTPS port      | `python3 tools/serve.py` (`--http`, `--upstream`) |
| Lint everything (oxlint + prettier + stylelint)           | `pnpm lint`                                       |
| Type-check (TypeScript 7; not test/ or `.vue`)            | `pnpm typecheck`                                  |
| Auto-format                                               | `pnpm format:prettier`                            |
| Full test (lint + typecheck + mocha)                      | `pnpm test`                                       |
| Mocha only (builds first)                                 | `pnpm test:mocha`                                 |
| Coverage                                                  | `pnpm coverage`                                   |
| Playwright e2e (builds first, needs `SEANCE_E2E_IRC_URL`) | `pnpm test:e2e`                                   |

There is no `pnpm dev`/`pnpm start`; build and serve `public/` statically.

Run a single mocha file:

```sh
NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/irc/client.ts
```

CI (`.github/workflows/ci.yml`) runs on every pull request and push to `develop`, in two parallel jobs after a frozen-lockfile install: `lint` (`pnpm lint`, `pnpm typecheck`) and `check` (the production build, mocha against it with `pnpm test:mocha:built`, which is `pnpm test:mocha` without its build, and `tools/scenarios/smoke.mjs`: the built app boots in Chromium with no console error).

`pnpm test:mocha` runs the production-shaped `pnpm build` first because `test/tests/build.ts` inspects `public/`. Live tests (`test/irc/*.live.ts`) are `describe.skip` unless `SEANCE_IRC_URL` is set:

```sh
SEANCE_IRC_URL=wss://localhost:8443/ NODE_ENV=test \
  pnpm exec mocha --config=test/.mocharc.yml test/irc/client.live.ts
```

`SEANCE_IRC_CHANNEL` overrides the channel the newer files join (default `#seance`), so they can be pointed at a public network. They relax TLS verification for `localhost` only (self-signed dev cert). Run live files **one at a time** — they share module singletons (the bus spy, the network manager, the id allocator) and time out waiting for `init` when several run in one mocha process (verified 2026-08-25: all pass individually, 4/6 fail combined; the ircd was not throttling). Making them coexist is an open follow-up. Quick headless smoke check after a build (expects the connect form and no console errors):

```sh
chromium --headless=new --disable-gpu --virtual-time-budget=5000 \
  --dump-dom http://127.0.0.1:8000/ | grep -c 'id="connect"'
```

## Dev IRC server

`tools/nefarious-dev/run.sh` runs nefarious2 in Docker (`-d` to detach; `docker logs -f nefarious-dev`). It bind-mounts `tools/nefarious-dev/ircd.conf` + `local.conf`, generates a SAN-bearing self-signed cert into `tmp/nefarious-dev/ircd.pem`, and publishes on 127.0.0.1: `6667` plain IRC, `6697` IRC/TLS, `8067` `ws://`, `8443` `wss://`. Server name `irc.seance.test`, network `SeanceDev`, test channel `#seance`, oper `seanceop`/`seance`. No services, so no SASL/accounts locally; `CHATHISTORY_REQUIRE_AUTH` is off and `IPCHECK_CLONE_LIMIT` is raised because the test suites reconnect a lot.

Image (build once from the gitignored `tmp/nefarious2` checkout — see the header of `run.sh`): a single `docker build -t nefarious2:ircv3 .` of stock `ircv3.2-upgrade`, then `docker tag nefarious2:ircv3 nefarious2:ircv3-fixed` so `run.sh`'s default keeps working. No patch is needed any more — the two images are the same build, and `ircv3-fixed` survives only as a compatibility alias.

The WebSocket bugs that used to require a local branch (details and transcripts in `docs/resources/nefarious2-websocket.md`) — **#97** plain-port WS handshake corrupted by pre-101 auth notices, **#98** inbound frames >= 528 bytes disconnect, **#99** upgrade requests >= 512 bytes hang (browsers send ~550) — were **merged upstream 2026-08-28** (PR [#101](https://github.com/evilnet/nefarious2/pull/101), `fceb160`), together with the client-cert follow-up: dedicated WebSocket ports no longer demand a client certificate, and `websocket=autodetect` ports use ALPN to spot browsers, so headless Chromium no longer trips `ERR_SSL_CLIENT_AUTH_CERT_NEEDED` and a TLS pass-through proxy is no longer required. `tmp/nefarious2` is on `ircv3.2-upgrade` at `346a1c0` (2026-09-11). A dev image older than `aef2f29` rewrites C0 control bytes to U+FFFD in WS text mode — the symptom is every echoed `/me` rendering as raw `�ACTION …�`; rebuild the image, the client is not at fault.

`node tools/irc-ws-probe.mjs wss://localhost:8443/ nick [--insecure] [--binary] [--stay]` is a dependency-free CAP/NICK/USER probe that prints every line.

## Architecture

Two TypeScript trees (`client/`, `shared/`) share `tsconfig.base.json`; `tsconfig.json` references only those.

### `client/` — the app

Vue 3 + Vuex + Vue Router SPA built by Vite (`vite.config.mts`, helpers in `scripts/build-info.mts`; the push worker is `vite.push.config.mts` and the translation worker `vite.translate.config.mts`, both built after every app build) into `public/`. Components in `client/components/` (`.vue` SFCs); app logic in `client/js/` (`store.ts`, `router.ts`, `store-settings.ts`, `commands/` for UI-only slash commands, `helpers/`); themes in `client/themes/` (one CSS file each, `coffee` is the default; `docs/resources/themes.md`); service worker `client/service-worker.js` (offline shell, web push: one raw IRC line per push, parsed/stripped/merged by `client/js/push/*`, bundled as `js/push.js` and loaded with `importScripts`; see `docs/projects/push-payload-multiline.md`).

- **`client/js/boot.ts`** — boot sequence: `loadBranding()` (`config.json`) → commit static `configuration.ts` → apply stored settings → `appLoaded` → drop splash → handle `?uri=`/query params → route to the last channel or `Connect` → `autoconnectSavedNetworks()`, last, once the page has its route: the saved networks flagged autoconnect are dialed whatever page the URL opened on (a reload on Settings or Help brings them back too; the connect form no longer does this on mount). Importing `./irc/manager` registers the IRC bus handlers.
- **Attention** — moved to `docs/resources/client-features.md` § Attention.
- **Do not disturb and per-network presence** — moved to `docs/resources/client-features.md` § Do not disturb and per-network presence.
- **Increase Contrast and Reduce Motion** — moved to `docs/resources/client-features.md` § Increase Contrast and Reduce Motion.
- **Switches** — moved to `docs/resources/client-features.md` § Switches.
- **Backdrops** — a modal's backdrop closes it through `v-backdrop` (`helpers/backdrop.ts`), never `@click.self` (`test/tests/backdrop.ts` fails one): only a click pressed and released on the backdrop itself counts, so a text selection dragged out of a dialog no longer closes it. A scenario closes one with `clickBackdrop` (`tools/scenarios/lib/backdrop.mjs`); a bare `element.click()` does nothing. Tests: `test/helpers/backdrop.ts`; browser check: `tools/scenarios/backdrop-drag.mjs`.
- **`client/js/foreground.ts`** — browser-side "the app is back": `visibilitychange`/`online`/bfcache `pageshow` call `reconnectAll()` (`irc/manager.ts`, de-bounced), which dials waiting networks now and probes open sockets (`WsTransport.probe()`: PING, 10 s of silence = dead socket → normal reconnect). The phone shells do the same from `native.ts` (`App.appStateChange`).
- **`client/js/pwa.ts`** — moved to `docs/resources/client-features.md` § `client/js/pwa.ts`.
- **Install guide** — moved to `docs/resources/client-features.md` § Install guide.
- **Last opened conversation** — moved to `docs/resources/client-features.md` § Last opened conversation.
- **Channel order** — moved to `docs/resources/client-features.md` § Channel order.
- **The phone layout is decided by the short side** — moved to `docs/resources/client-features.md` § The phone layout is decided by the short side.
- **Touch and iOS** — moved to `docs/resources/client-features.md` § Touch and iOS.
- **Message action toolbar** — moved to `docs/resources/client-features.md` § Message action toolbar.
- **The iOS status bar** — moved to `docs/resources/client-features.md` § The iOS status bar.
- **Markdown** — moved to `docs/resources/client-features.md` § Markdown.
- **Network header** — moved to `docs/resources/client-features.md` § Network header.
- **A conversation on a network that is down** — moved to `docs/resources/client-features.md` § A conversation on a network that is down.
- **Animated image previews play once** — moved to `docs/resources/client-features.md` § Animated image previews play once.
- **The inbox** — moved to `docs/resources/client-features.md` § The inbox.
- **Reactions** — moved to `docs/resources/client-features.md` § Reactions.
- **The `ps` theme** — moved to `docs/resources/ps-theme-map.md` § The `ps` theme.
- **File uploads** — moved to `docs/resources/client-features.md` § File uploads.
- **Settings backup** — moved to `docs/resources/client-features.md` § Settings backup.
- **Settings is a modal** — moved to `docs/resources/client-features.md` § Settings is a modal.
- **Command aliases** — moved to `docs/resources/client-features.md` § Command aliases.
- **Who plays an alert's sound** — moved to `docs/resources/client-features.md` § Who plays an alert's sound.
- **Web push** — moved to `docs/resources/web-push-map.md` § Web push.
- **Oper tools** — moved to `docs/resources/oper-tools-map.md` § Oper tools.
- **Lua scripting** — moved to `docs/resources/client-features.md` § Lua scripting.
- **Translation** (`client/js/translate/`) — `docs/resources/client-features.md` § Translation; long form `docs/resources/translation.md`.
- **Interface languages** (`client/js/i18n/`, `client/locales/`, `tools/i18n/`) — `docs/resources/client-features.md` § Interface languages (i18n); long form `docs/resources/i18n.md`.
- **`client/js/socket.ts`** — `EventBus`, an in-process replacement for socket.io-client. `on/once/off` subscribe to server→client events, `dispatch(event, payload)` fires them; `emit(event, payload)` is routed to the single `handle(event, fn)` registered for it (unhandled emits `console.warn`). The `socket.on/emit` call-site shape across `socket-events/*` and components is kept **on purpose** so the IRC layer plugs in without touching ~50 call sites. No networking lives here.
- **`client/js/socket-events/*`** — the bus consumers that mutate the store (`init`, `msg`, `join`, `names`, `network`, `more`, ...). `index.ts` lists them.
- **`client/js/branding.ts`** + **`client/config.json`** — deploy branding schema/loader; `config.json` is copied to `public/` and fetched at runtime, and read by the build for `index.html`/manifest.

### `client/js/irc/` — the IRC layer

Data flow: `transport.ts` (`WsTransport`: one line per frame, PING/PONG, reconnect backoff, 500-byte guard) → `message.ts` (hand-rolled parser/serialiser, `casemap.ts`) → `caps.ts` / `sasl.ts` / `isupport.ts` → `client.ts` (`IrcClient`: one per network, owns the `SharedNetwork` model and `channel.ts` state) → `handlers/` → `socket.dispatch(...)`. Typed input comes back via `bus.ts` (`socket.handle("input" | "open" | "names" | "more" | "msg:react" | "msg:redact" | "network:*")`) → `commands/`.

- **`handlers/`** — one file per command/numeric exporting `{COMMAND: handler}`; `handlers/index.ts` holds the `modules` list and the `unhandled` fallback. **To add a handler: add a file and one entry in `modules`.**
- **`commands/`** — one file per slash command exporting a `Command`; `commands/index.ts` holds the `modules` list and `dispatchInput`. **To add a command: add a file and one entry in `modules`.** Unknown commands are sent raw.
- **`multiline.ts`** — moved to `docs/resources/irc-layer.md` § `multiline.ts`.
- **Oper-tool modules** (`request.ts`, `oper.ts`, …) — moved to `docs/resources/irc-layer.md` § Oper-tool modules.
- **Other modules** (`manager.ts`, `bus.ts`, `history.ts`, `catchup.ts`, …) — moved to `docs/resources/irc-layer.md` § Other modules.

### Working in the IRC layer

- `Handler = (client: IrcClient, msg: IrcMessage) => void` (`types.ts`). Handlers mutate the client's model and emit through the client — `client.pushMessage(chan, partial, increasesUnread?)`, `client.findChannel(name)`, `client.isSelf(nick)`, `client.timeOf(msg)` (honours `@time`), `client.lobby`, `client.channels` — never the transport or the store directly. `handlers/away.ts` is a small model.
- `Command = {commands: string[]; allowDisconnected?: boolean; input(ctx)}` with `ctx = {client, chan, cmd, args, rest}`. Build lines with `formatLine(...)` (`message.ts`) or `trailingLine(cmd, params)` (`wire.ts`) and call `client.send(line)`. `commands/away.ts` is a small model.
- UI-only commands (`/collapse`, `/expand`, `/search`, `/join` of an already-listed channel) are intercepted in `client/js/commands/` before the bus sees them; service aliases (`/cs`, `/ns`, ...) pass through raw.
- Event names, payload shapes and store expectations are fixed by `docs/resources/bus-contract.md`; when adding a new event, extend `shared/types/socket-events.ts` and a `socket-events/*` consumer together.
- **Replies, reactions, deletion and edits** — moved to `docs/resources/irc-layer.md` § Replies, reactions, deletion and edits.
- **Unread counts live in the IRC layer** — moved to `docs/resources/irc-layer.md` § Unread counts live in the IRC layer.
- **Reconnects are quiet: a join burst is state, only what was asked for is a line** — moved to `docs/resources/irc-layer.md` § Reconnects are quiet: a join burst is state, only what was asked for is a line.
- **A SASL login that was asked for must succeed** — moved to `docs/resources/irc-layer.md` § A SASL login that was asked for must succeed.
- **The retry schedule spaces automatic retries only; anyone who asks restarts it** — moved to `docs/resources/irc-layer.md` § The retry schedule spaces automatic retries only; anyone who asks restarts it.
- **The catch-up cursor is offered exactly once per connection, and only then** — moved to `docs/resources/irc-layer.md` § The catch-up cursor is offered exactly once per connection, and only then.
- **A login can give its dial back** — moved to `docs/resources/irc-layer.md` § A login can give its dial back.
- **`/who`** — moved to `docs/resources/irc-layer.md` § `/who`.
- Typing notifications (bus-contract §1.5): `client.typing(chan, state)` sends `@+typing=<state> TAGMSG` with the spec's 3 s per-target throttle (`TYPING_INTERVAL_MS`; session reset by `sendMessage`/`onClose`), the `typing` bus emit routes to it in `bus.ts`, and `handlers/tagmsg.ts` dispatches `typing {chan, nick, state}` for other users' tags (never own echo or replay). Tests: `test/irc/typing.ts` (sinon fake timers).
- **Pending outgoing messages** — moved to `docs/resources/irc-layer.md` § Pending outgoing messages.

### `shared/`

Cross-cutting types and helpers. `shared/types/socket-events.ts` (`ServerToClientEvents` / `ClientToServerEvents`) is **still the bus contract** the IRC layer dispatches against; reshaping it around an IRC-native store is the optional E.2.

### Everything else

- **`attic/`** — TheLounge's old `server/`, CLI entry, defaults and server tests. **Reference only**: not built, linted, type-checked or tested; excluded from Oxlint, Prettier and the tsconfigs. Look there for "how did the old server do X"; never import from it. See `attic/README.md`.
- **GitHub Pages** (`.github/workflows/pages.yml`) — `evilnet.github.io/seance/` is the latest release; `develop/` and `pr<N>/` beside it are the develop branch and every open non-draft PR by a collaborator (or labelled `preview`), listed at `previews/`. One deployment is the whole site, so every run assembles all of them (`tools/pages-site.mjs`, `test/tools/pages-site.ts`), each build cached by commit so a PR push rebuilds that PR alone; a failed build becomes a stub page; no build's `*.map` files are published (local builds keep them). PR builds run the PR's code under `pull_request_target` with a read-only token — that gating is the security boundary, keep it. Version strings: the tag, `<tag>-<sha8>` for develop, `<tag>-pr<N>.<sha7>` for a PR; with them the build step passes `SEANCE_RELEASE` (the tag — the shallow checkout has none to find) and `SEANCE_TRACK` (`release`, `develop`, `pr<N>`), and Help's About opens with which build this is in words ("This is a preview of pull request #142.", `helpers/sourceLinks.ts` `buildTrackOf`, `test/helpers/sourceLinks.ts`); a build made anywhere else names its git branch.
- **`tools/`** — `nefarious-dev/` (dev ircd), `irc-ws-probe.mjs`, `pwa-check.mjs`, `pages-site.mjs` (the Pages site), and `browser-drive.mjs` + `scenarios/` (drives a real Chromium over the DevTools protocol: WebSocket frames with byte sizes for the nefarious2 framing bugs, or a scenario that clicks/asserts/screenshots — nothing in `pnpm test` touches the DOM or a browser). See `docs/resources/browser-testing.md` and the `browser-check` skill.
- **`docs/`** — PARA layout (`projects/`, `areas/`, `resources/`, `archives/`), see `docs/README.md`.
- **`tmp/`** — gitignored scratch: the nefarious2 checkout, the fix patch, dev-server state.
- **`test/`** — see Conventions.

## Conventions

- Prettier is enforced (`pnpm lint`, and CI). If `pnpm lint` fails, run `pnpm format:prettier` first.
- **UI sizing: rem, never px** — moved to `docs/resources/client-features.md` § UI sizing: rem, never px.
- `client/` compiles with `strict: true`; `noImplicitAny: false` remains in the tsconfigs with a "TODO: Remove eventually" — write explicit types in new code. No Node built-ins in `client/` (it must bundle for the browser; `transport.ts` uses only the global `WebSocket`).
- **Pipeline the registration exchange.** Lines are processed in order and pre-registration commands are not charged fake lag, so never wait for a reply whose outcome the server already knows: `CAP END` goes out in the same flush as `CAP REQ`. The SASL opener is the one exception: it waits for the `sasl` ACK, since sasl-3.1 requires the cap enabled first and a NAKed REQ makes the server drop an opener queued behind it. That costs one round trip and no extra command. A `CAP REQ` sent after that `CAP END` but before 001 (a NAKed REQ retried cap by cap, a `CAP NEW`) suspends registration again, so the negotiator sends another `CAP END` behind it (`caps.ts` `reEnd`). The active channel's history/marker goes out in the same flush as the `JOIN` (`caps.ts` `pipelineEnd`, `catchup.ts` `prefetchCatchup`).
- **Nothing but registration before 001** — moved to `docs/resources/irc-layer.md` § Nothing but registration before 001.
- **Don't add per-channel commands to the connect path** — moved to `docs/resources/irc-layer.md` § Don't add per-channel commands to the connect path.
- `MAX_LINE_BYTES = 500` (`client/js/irc/message.ts`) caps every outbound line, tags included: nefarious2 kills connections on inbound WS frames >= 528 bytes (#98) and the branch rejects message bodies over 512 bytes as excess flood, and browsers cannot control fragmentation. `splitMessage` chunks long text; do not raise the cap.
- After changing `client/`, run `pnpm build` (or `pnpm watch`) — the mocha build test and the headless check both read `public/`. `public/` is gitignored and shared by every branch, so it does not change on checkout: rebuild after switching branches.
- **Whatever covers the screen carries `.screen-overlay`.** A modal's backdrop, a full-screen sheet, a dimmer: the class is the one rule (`html[data-shell="native"] :is(.screen-overlay, …)` in `style.css`) that starts it below the native shell's status bar and notch and stops it above Android's buttons, whether it is fixed to the screen or absolute in `#viewport` (whose padding box runs under the bars). Never add an overlay's id to an inset rule. `test/tests/screenOverlays.ts` fails a component with `role="dialog"`, `aria-modal`, an `id="…-overlay"` or a `<Teleport to="body">` that lacks the class, unless its exemption list says why it keeps clear of the bars itself (the image viewer, the reaction picker, Mentions, the connect page). Browser check: `tools/scenarios/native-shell-chrome.mjs`.
- **The suite has no browser and no DOM.** No component is ever mounted (the Playwright e2e in `test/e2e/` is the exception, and only against a live ircd), so a change under `client/components/`, `client/css/` or the store is unverified by `pnpm test` however green it is. Check those in a real browser (`docs/resources/browser-testing.md`).
- Tests mirror the source under `test/`: `test/irc/*.ts` for the IRC layer, `test/shared/`, `test/helpers/` (`client/js/helpers/`, e.g. `parseMarkdown.ts`, `layout.ts`, `highlighter.ts`), `test/push/` (`client/js/push/`, the service worker's push module), `test/tests/` (`build.ts`, `eventBus.ts`; everything that needs no DOM lives under `test/helpers/` and `test/tests/`), `test/e2e/` (Playwright, ignored by mocha, needs a built `public/` and `SEANCE_E2E_IRC_URL`). Mocha config `test/.mocharc.yml` (tsx loader, `check-leaks`).
- IRC unit tests use a `FakeTransport` injected through `transportFactory` and drive lines with `transport.line(...)`, asserting on a `sinon.spy(socket, "dispatch")`. **Gotcha:** `test/irc/client.ts` installs that spy in a root-level `beforeEach`, which mocha applies to every file in the run; other files (`multi-network.ts`, `history.ts`, ...) check `socket.dispatch.isSinonProxy` and only `restore()` a spy they own. Follow that pattern in new test files or the suite fails when run together.
- Modules that must run under mocha (`irc/*`, `saved-networks.ts`, `sts.ts`) stay free of store/DOM imports; tests swap storage via `useStorageBackend`.
- Live tests are gated on `SEANCE_IRC_URL` (and `SEANCE_IRC_CHANNEL`, default `#seance`) and need the dev ircd running.
- **Every UI string goes through `t()`/`tCount()`** — `docs/resources/client-features.md` § Interface languages (i18n).
- localStorage keys are still `thelounge.*` (`thelounge.networks`, `thelounge.sts`, `thelounge.mentions`, `thelounge.muted`, `thelounge.media.trusted`, `thelounge.sort.*`, `thelounge.state.lastChannel`, `thelounge.translate`, ...). Do not rename without a migration.

## Documentation

- `docs/projects/initial_conversion.md` — the conversion plan and its status; update checkboxes as work lands.
- `docs/resources/bus-contract.md` — the spec for every bus event the IRC layer dispatches/handles and what the store expects (payload shapes, `SharedMsg`/`MessageType`, routing).
- `docs/resources/nefarious2-websocket.md` — server behaviour: WS framing, CAP set, ISUPPORT/numeric quirks, upstream bugs and the local fix branch.
- `docs/resources/nefarious2-dev.md` — running the dev ircd (Docker and native), test identities, TLS notes.
- `docs/resources/nefarious2-oper.md` — the IRC-operator surface on the wire: OPER/PRIVS, snomask bits, every server notice format, WALLOPS, CHECK, STATS, bans, server bugs (filed and not).
- `docs/resources/x3-services.md` — X3 services (O3, AuthServ, ChanServ) on the wire: the snoop feed, the audit lines opers' commands leave in the report channel, alert criteria and TRACE, the G-line commands, WHOIS/CHANINFO/ACCOUNTINFO output, how to recognise the bots.
- `docs/projects/oper-tools.md` — the oper tools: what was decided, what is built, what is next.
- `docs/projects/vite-8-sweep.md` — moving the client build from webpack 5 to Vite 8: every webpack duty and its Vite answer, the spike, the migration plan.
- `docs/resources/browser-irc-parser.md` — why the parser is hand-rolled.
- `docs/resources/branding.md` — `config.json` schema, runtime vs build-time branding, uploader contract.
- `docs/resources/logo.md` — how the ghost artwork was prepared, what each icon file is for, and where it falls short (16px, Safari pinned tab, notification badge).
- `docs/resources/pwa.md` — what makes the deploy installable in Chrome, launch/update/offline behaviour, how to verify.
- `docs/resources/browser-testing.md` — `tools/browser-drive.mjs`: watching the IRC WebSocket frame by frame, writing scenarios, and the traps (scrollback, profile reuse, synthetic clicks).
- `docs/resources/irc-links.md` — the `web+irc://` link scheme (why not `irc:`/`ircs:`), its grammar and everywhere it is wired.
- `docs/resources/reactions.md` — reactions as free text: the emoji picker, the recents list, `/react`'s argument rules and where the catalog comes from.
- `docs/resources/settings-backup.md` — the `.seance-settings` file: what it carries, what it never does, how a restore applies.
- `docs/resources/aliases.md` — command aliases: the expansion rules, where they hook into input, the settings editor.
- `docs/resources/translation.md` — the on-device translation engines, router, worker and weights; `docs/projects/translation-devices.md` the per-model GPU/CPU choice. Summary: `docs/resources/client-features.md` § Translation.
- `docs/resources/i18n.md` — the interface's languages: the pot and the catalogs, the tools (add, merge, sync, fill, sweep, check), RTL and the `qqx` rig. Summary: `docs/resources/client-features.md` § Interface languages (i18n).
- `docs/areas/scripting/` — the user's guide to Lua scripts: getting started, the `seance` API, a cookbook, limits and pitfalls. `docs/resources/lua-scripting.md` is how the sandbox is built.
- `docs/resources/themes.md` — how a theme file works, the themes (`coffee` the default, `ps` the one with a live scene), the Ink & Amber tokens and where they deviate from the handoff in `docs/resources/themes/`. Browser check: `tools/scenarios/themes.mjs`.
- `docs/projects/ps-theme.md` — the `ps` theme's five-plan spec; plan 1 (the seam) landed 2026-09-24 — the hook, the engine and palette, the live scene, the daylight fallback and the message column's palette; plan 2 (the chrome) 2026-09-25 — the glass and solid chrome with its two palettes, Mulish and Fraunces (Source Sans 3 and Newsreader since plan 4), the calibrated legibility model and its generator; plan 3 (the plains) 2026-09-26 — the land and river, the yurt, the birds, the day's weather, the luminous day glass, the measured budget and the frosted private view; plan 4 (the rest) 2026-09-26 — the embers, reduced motion's full stand-down, the select by the hour, cloudier rain and storms with no birds, the user's new faces, the in-message nick, the gutter, and the full browser check with its glyph samples; plan 5 (right-to-left) still ahead.
- `docs/projects/heart-theme.md` — the `<3` theme's design record, the ancestor of `ps`.
- There are no public end-user docs yet; `branding.links` defaults point at this repository and its `docs/`.
