# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Seance** is TheLounge's Vue 3 client turned into a static, bouncer-less IRC client. The browser speaks IRCv3 directly to **nefarious2** (EvilNet's ircd) over a WebSocket — one IRC line per WS message, `text.ircv3.net` subprotocol — with no Node server in between. The target ircd is nefarious2's **`ircv3.2-upgrade` branch** (`master` has neither WebSocket nor the IRCv3.2 caps). Goal: a `public/` tree an IRC network can rebrand via `config.json` and ship as its own web/PWA/native client.

**Status** (see `docs/projects/initial_conversion.md` for the checklist): phases 0 (discovery), A (server moved to `attic/`), B (bus stubbed), C (minimum IRC) are done; D (fill-in) is done except D.7 read markers/`MARKREAD` and D.11 web push (both deferred); E is in progress — E.3 branding is done, E.1 dependency purge is underway, E.2 bus-contract reshape is optional, E.4 native shells not started. Milestones M4 (daily-driver) and M5 (shippable) are not yet ticked.

Upstream is still `github.com/thelounge/thelounge`; divergence only grows. localStorage keys are still `thelounge.*` (renaming needs a migration). Node.js >= 22, Yarn 1 (classic), MIT licensed.

## Common commands

`yarn` is not on PATH on this machine — use `corepack yarn <cmd>` (or `npx` for one-offs).

| Task                                            | Command                                       |
| ----------------------------------------------- | --------------------------------------------- |
| Install deps                                    | `yarn install`                                |
| Build the SPA (webpack → `public/`)             | `yarn build` (`NODE_ENV=production` for prod) |
| Webpack watch                                   | `yarn watch`                                  |
| Serve the built SPA                             | `python3 -m http.server -d public 8000`       |
| Lint everything (eslint + prettier + stylelint) | `yarn lint`                                   |
| Auto-format                                     | `yarn format:prettier`                        |
| Full test (lint + mocha)                        | `yarn test`                                   |
| Mocha only (builds first)                       | `yarn test:mocha`                             |
| Mocha without the spec glob                     | `yarn test:nospec`                            |
| Coverage                                        | `yarn coverage`                               |
| Install git pre-commit hook                     | `yarn githooks-install`                       |

There is no `yarn dev`/`yarn start`; build and serve `public/` statically.

Run a single mocha file:

```sh
npx cross-env NODE_ENV=test TS_NODE_PROJECT='./test/tsconfig.json' \
  npx mocha --config=test/.mocharc.yml test/irc/client.ts
```

`yarn test:mocha` runs `webpack --mode=development` first because `test/tests/build.ts` inspects `public/`. Live tests (`test/irc/*.live.ts`) are `describe.skip` unless `SEANCE_IRC_URL` is set:

```sh
SEANCE_IRC_URL=wss://localhost:8443/ npx cross-env NODE_ENV=test \
  TS_NODE_PROJECT='./test/tsconfig.json' npx mocha --config=test/.mocharc.yml test/irc/client.live.ts
```

They relax TLS verification for `localhost` only (self-signed dev cert). Run live files **one at a time** — they share module singletons (the bus spy, the network manager, the id allocator) and time out waiting for `init` when several run in one mocha process (verified 2026-08-25: all pass individually, 4/6 fail combined; the ircd was not throttling). Making them coexist is an open follow-up. Quick headless smoke check after a build (expects the connect form and no console errors):

```sh
chromium --headless=new --disable-gpu --virtual-time-budget=5000 \
  --dump-dom http://127.0.0.1:8000/ | grep -c 'id="connect"'
```

## Dev IRC server

`tools/nefarious-dev/run.sh` runs nefarious2 in Docker (`-d` to detach; `docker logs -f nefarious-dev`). It bind-mounts `tools/nefarious-dev/ircd.conf` + `local.conf`, generates a SAN-bearing self-signed cert into `tmp/nefarious-dev/ircd.pem`, and publishes on 127.0.0.1: `6667` plain IRC, `6697` IRC/TLS, `8067` `ws://`, `8443` `wss://`. Server name `irc.seance.test`, network `SeanceDev`, test channel `#seance`, oper `seanceop`/`seance`. No services, so no SASL/accounts locally; `CHATHISTORY_REQUIRE_AUTH` is off and `IPCHECK_CLONE_LIMIT` is raised because the test suites reconnect a lot.

Images (build once from the gitignored `tmp/nefarious2` checkout — see the header of `run.sh`):

- `nefarious2:ircv3-fixed` (**default**) — `ircv3.2-upgrade` plus the local `seance/websocket-fixes` branch (also exported as `tmp/nefarious2-fixes.patch`). Required for real browsers.
- `nefarious2:ircv3` (`NEFARIOUS_IMAGE=nefarious2:ircv3`) — stock branch. Plain `ws://` and every real browser fail against it.

The three upstream bugs the fix branch addresses (details and transcripts in `docs/resources/nefarious2-websocket.md`): **#97** plain-port WS handshake corrupted by pre-101 auth notices; **#98** inbound frames >= 528 bytes disconnect; **#99** upgrade requests >= 512 bytes hang (browsers send ~550). **Merged upstream 2026-08-28** (PR [#101](https://github.com/evilnet/nefarious2/pull/101), `fceb160` on `ircv3.2-upgrade`), so a stock build of that branch now carries them — `tmp/nefarious2` is 17 commits behind and the `ircv3-fixed` image only still exists because the checkout is old. The TLS listener also requests a client cert, which headless Chromium answers with `ERR_SSL_CLIENT_AUTH_CERT_NEEDED` — automated browser runs need a pass-through TLS proxy.

`node tools/irc-ws-probe.mjs wss://localhost:8443/ nick [--insecure] [--binary] [--stay]` is a dependency-free CAP/NICK/USER probe that prints every line.

## Architecture

Two TypeScript trees (`client/`, `shared/`) share `tsconfig.base.json`; `tsconfig.json` references only those.

### `client/` — the app

Vue 3 + Vuex + Vue Router SPA built by webpack (`webpack.config.ts`) into `public/`. Components in `client/components/` (`.vue` SFCs); app logic in `client/js/` (`store.ts`, `router.ts`, `store-settings.ts`, `commands/` for UI-only slash commands, `helpers/`); themes in `client/themes/`; service worker `client/service-worker.js` (offline shell, no push).

- **`client/js/boot.ts`** — boot sequence: `loadBranding()` (`config.json`) → commit static `configuration.ts` → apply stored settings → `appLoaded` → drop splash → handle `?uri=`/query params → route to the last channel or `Connect`. Importing `./irc/manager` registers the IRC bus handlers.
- **`client/js/foreground.ts`** — browser-side "the app is back": `visibilitychange`/`online`/bfcache `pageshow` call `reconnectAll()` (`irc/manager.ts`, de-bounced), which dials waiting networks now and probes open sockets (`WsTransport.probe()`: PING, 10 s of silence = dead socket → normal reconnect). The Capacitor shells do the same from `native.ts`.
- **`client/js/pwa.ts`** — installed-app glue: registers `service-worker.js` (secure contexts only), captures `beforeinstallprompt` into `store.state.installPromptAvailable` (Settings → "Install … as an app"), consumes `window.launchQueue` so `web+irc:` links reuse the running window (manifest `launch_handler: focus-existing`), and flags a new build via `controllerchange` (Help offers a reload). `tools/pwa-check.mjs <url>` asks headless Chromium for its installability verdict; see `docs/resources/pwa.md`.
- **`client/js/socket.ts`** — `EventBus`, an in-process replacement for socket.io-client. `on/once/off` subscribe to server→client events, `dispatch(event, payload)` fires them; `emit(event, payload)` is routed to the single `handle(event, fn)` registered for it (unhandled emits `console.warn`). The `socket.on/emit` call-site shape across `socket-events/*` and components is kept **on purpose** so the IRC layer plugs in without touching ~50 call sites. No networking lives here.
- **`client/js/socket-events/*`** — the bus consumers that mutate the store (`init`, `msg`, `join`, `names`, `network`, `more`, ...). `index.ts` lists them.
- **`client/js/branding.ts`** + **`client/config.json`** — deploy branding schema/loader; `config.json` is copied to `public/` and fetched at runtime, and read by webpack for `index.html`/manifest.

### `client/js/irc/` — the IRC layer

Data flow: `transport.ts` (`WsTransport`: one line per frame, PING/PONG, reconnect backoff, 500-byte guard) → `message.ts` (hand-rolled parser/serialiser, `casemap.ts`) → `caps.ts` / `sasl.ts` / `isupport.ts` → `client.ts` (`IrcClient`: one per network, owns the `SharedNetwork` model and `channel.ts` state) → `handlers/` → `socket.dispatch(...)`. Typed input comes back via `bus.ts` (`socket.handle("input" | "open" | "names" | "more" | "msg:react" | "msg:redact" | "network:*")`) → `commands/`.

- **`handlers/`** — one file per command/numeric exporting `{COMMAND: handler}`; `handlers/index.ts` holds the `modules` list and the `unhandled` fallback. **To add a handler: add a file and one entry in `modules`.**
- **`commands/`** — one file per slash command exporting a `Command`; `commands/index.ts` holds the `modules` list and `dispatchInput`. **To add a command: add a file and one entry in `modules`.** Unknown commands are sent raw.
- `manager.ts` (`NetworkManager` registry, `createNetwork`), `bus.ts` (bus handlers, store-free), `history.ts` (`draft/chathistory` + batches; distinct from `client/js/history.ts`, the input history), `catchup.ts` (paced per-channel history/marker fetch after JOIN — the active channel at once, the rest one per 4 s, because ircu-family servers charge ~2 s of fake lag per command and stop reading at 10 s; see `docs/projects/connect-burst.md`), `persistence.ts` (nefarious2's built-in bouncer, `draft/persistence`: after `PERSISTENCE STATUS ON` the autojoin waits for the server's restoration batch, which is applied as state only — see `docs/projects/seamless-reconnect.md`), `sts.ts`, `saved-networks.ts` (`thelounge.networks`), `ids.ts` (one shared id allocator across networks; history ids are negative), `errors.ts`, `hostmask.ts`, `wire.ts`, `types.ts`.

### Working in the IRC layer

- `Handler = (client: IrcClient, msg: IrcMessage) => void` (`types.ts`). Handlers mutate the client's model and emit through the client — `client.pushMessage(chan, partial, increasesUnread?)`, `client.findChannel(name)`, `client.isSelf(nick)`, `client.timeOf(msg)` (honours `@time`), `client.lobby`, `client.channels` — never the transport or the store directly. `handlers/away.ts` is a small model.
- `Command = {commands: string[]; allowDisconnected?: boolean; input(ctx)}` with `ctx = {client, chan, cmd, args, rest}`. Build lines with `formatLine(...)` (`message.ts`) or `trailingLine(cmd, params)` (`wire.ts`) and call `client.send(line)`. `commands/away.ts` is a small model.
- UI-only commands (`/collapse`, `/expand`, `/search`, `/join` of an already-listed channel) are intercepted in `client/js/commands/` before the bus sees them; service aliases (`/cs`, `/ns`, ...) pass through raw.
- Event names, payload shapes and store expectations are fixed by `docs/resources/bus-contract.md`; when adding a new event, extend `shared/types/socket-events.ts` and a `socket-events/*` consumer together.
- Replies, reactions, deletion and edits (bus-contract §1.4): `Channel.idByMsgid` / `idOf()` is the msgid → id map; `client.react()` / `redact()` / `editMessage()` send, `handlers/tagmsg.ts` / `handlers/redact.ts` / `privmsg.ts` (`+seance/edit`) dispatch `msg:react` / `msg:redact` / `msg:edit`. Anything that refers to another message by msgid must go through `client.afterReplay(fn)` so that inside a chathistory replay it runs after the batch's messages have ids. Wire constants (`REPLY_TAG`, `EDIT_TAG`, `REACT_TAG`, `UNREACT_TAG`, `REDACTION_CAP`, `TYPING_TAG`) live in `wire.ts`.
- **Reconnects are quiet, by content not by context.** A reattach can bring the server's join burst several times over (session restore, our re-JOIN, the bouncer's alias attach), so: `topic.ts` prints a 332/333 only when the topic differs from the one the channel shows (`Channel.topicAsked` is the `/topic` escape hatch), and a JOIN for a channel already JOINED produces no line and no second `CHATHISTORY`/`MARKREAD`/`MODE` (`Channel.rejoining`, `client.restoring` and the state check in `handleMessage`). The catch-up (`CHATHISTORY AFTER`) is what shows what actually happened. Keep new join-burst handlers consistent with this.
- Typing notifications (bus-contract §1.5): `client.typing(chan, state)` sends `@+typing=<state> TAGMSG` with the spec's 3 s per-target throttle (`TYPING_INTERVAL_MS`; session reset by `sendMessage`/`onClose`), the `typing` bus emit routes to it in `bus.ts`, and `handlers/tagmsg.ts` dispatches `typing {chan, nick, state}` for other users' tags (never own echo or replay). Tests: `test/irc/typing.ts` (sinon fake timers).

### `shared/`

Cross-cutting types and helpers. `shared/types/socket-events.ts` (`ServerToClientEvents` / `ClientToServerEvents`) is **still the bus contract** the IRC layer dispatches against; reshaping it around an IRC-native store is the optional E.2.

### Everything else

- **`attic/`** — TheLounge's old `server/`, CLI entry, defaults and server tests. **Reference only**: not built, linted, type-checked or tested; excluded from ESLint, Prettier and the TS references. Look there for "how did the old server do X"; never import from it. See `attic/README.md`.
- **`tools/`** — `nefarious-dev/` (dev ircd), `irc-ws-probe.mjs` and `pwa-check.mjs`.
- **`docs/`** — PARA layout (`projects/`, `areas/`, `resources/`, `archives/`), see `docs/README.md`.
- **`tmp/`** — gitignored scratch: the nefarious2 checkout, the fix patch, dev-server state.
- **`test/`** — see Conventions.

## Conventions

- Prettier is enforced (pre-commit hook via `yarn githooks-install`). If `yarn lint` fails, run `yarn format:prettier` first.
- `client/` compiles with `strict: true`; `noImplicitAny: false` remains in the tsconfigs with a "TODO: Remove eventually" — write explicit types in new code. No Node built-ins in `client/` (it must bundle for the browser; `transport.ts` uses only the global `WebSocket`).
- **Pipeline the registration exchange.** Lines are processed in order and pre-registration commands are not charged fake lag, so never wait for a reply whose outcome the server already knows: `CAP END` (or the SASL opener) goes out in the same flush as `CAP REQ`, and the active channel's history/marker in the same flush as the `JOIN` (`caps.ts` `pipelineEnd`, `catchup.ts` `prefetchCatchup`).
- **Don't add per-channel commands to the connect path.** Every command costs ~2 s of server-side fake lag and the socket is ignored past 10 s (`docs/resources/nefarious2-websocket.md` § Fake lag). Autojoin is one `JOIN a,b,c` (`joinChannels`), `MODE` is asked lazily on first open, and anything else per channel goes through `catchup.ts`.
- `MAX_LINE_BYTES = 500` (`client/js/irc/message.ts`) caps every outbound line, tags included: nefarious2 kills connections on inbound WS frames >= 528 bytes (#98) and the branch rejects message bodies over 512 bytes as excess flood, and browsers cannot control fragmentation. `splitMessage` chunks long text; do not raise the cap.
- After changing `client/`, run `yarn build` (or `yarn watch`) — the mocha build test and the headless check both read `public/`.
- Tests mirror the source under `test/`: `test/irc/*.ts` for the IRC layer, `test/shared/`, `test/tests/` (`build.ts`, `eventBus.ts`), `test/client/` (browser specs webpack bundles in development mode into `test/public/testclient.js`; ignored by mocha). Mocha config `test/.mocharc.yml` (tsx loader, `check-leaks`).
- IRC unit tests use a `FakeTransport` injected through `transportFactory` and drive lines with `transport.line(...)`, asserting on a `sinon.spy(socket, "dispatch")`. **Gotcha:** `test/irc/client.ts` installs that spy in a root-level `beforeEach`, which mocha applies to every file in the run; other files (`multi-network.ts`, `history.ts`, ...) check `socket.dispatch.isSinonProxy` and only `restore()` a spy they own. Follow that pattern in new test files or the suite fails when run together.
- Modules that must run under mocha (`irc/*`, `saved-networks.ts`, `sts.ts`) stay free of store/DOM imports; tests swap storage via `useStorageBackend`.
- Live tests are gated on `SEANCE_IRC_URL` and need the dev ircd running.
- localStorage keys are still `thelounge.*` (`thelounge.networks`, `thelounge.sts`, `thelounge.mentions`, `thelounge.muted`, `thelounge.sort.*`, ...). Do not rename without a migration.

## Documentation

- `docs/projects/initial_conversion.md` — the conversion plan and its status; update checkboxes as work lands.
- `docs/resources/bus-contract.md` — the spec for every bus event the IRC layer dispatches/handles and what the store expects (payload shapes, `SharedMsg`/`MessageType`, routing).
- `docs/resources/nefarious2-websocket.md` — server behaviour: WS framing, CAP set, ISUPPORT/numeric quirks, upstream bugs and the local fix branch.
- `docs/resources/nefarious2-dev.md` — running the dev ircd (Docker and native), test identities, TLS notes.
- `docs/resources/browser-irc-parser.md` — why the parser is hand-rolled.
- `docs/resources/branding.md` — `config.json` schema, runtime vs build-time branding, uploader contract.
- `docs/resources/logo.md` — how the ghost artwork was prepared, what each icon file is for, and where it falls short (16px, Safari pinned tab, notification badge).
- `docs/resources/pwa.md` — what makes the deploy installable in Chrome, launch/update/offline behaviour, how to verify.
- `docs/resources/irc-links.md` — the `web+irc://` link scheme (why not `irc:`/`ircs:`), its grammar and everywhere it is wired.
- There are no public end-user docs yet; `branding.links` defaults point at this repository and its `docs/`.
