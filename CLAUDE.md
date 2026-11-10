# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It is kept short on purpose: feature details live in `docs/` (the long form of this file: `docs/resources/codebase-guide.md`), and each pointer below says where.

## Project

**Seance** is TheLounge's Vue 3 client turned into a static, bouncer-less IRC client. The browser speaks IRCv3 directly to **nefarious2** (EvilNet's ircd, `ircv3.2-upgrade` branch) over a WebSocket — one IRC line per WS message, `text.ircv3.net` subprotocol — with no Node server in between. Output is a `public/` tree an IRC network can rebrand via `config.json` and ship as its own web/PWA/native client. Other ircds should work too; nefarious2-only behaviour belongs in `client/js/irc/profiles/`.

Status: `docs/projects/initial_conversion.md`. Upstream is still `github.com/thelounge/thelounge`. Node.js 22.22.2+, 24.15+ or 26+ (CI and `.node-version`: 26), pnpm, MIT.

## Commands

pnpm, at the version `package.json`'s `packageManager` names (`npm i -g pnpm@12.16.1`; pnpm does not switch itself, because that writes a two-document lockfile GitHub's dependency graph cannot read). Node 25+ ships no corepack, and pnpm advises against it anyway. Dependency install scripts run only when `pnpm-workspace.yaml`'s `allowBuilds` names them.

| Task                                            | Command                                       |
| ----------------------------------------------- | --------------------------------------------- |
| Install deps                                    | `pnpm install`                                |
| Build the SPA (Vite → `public/`)                | `pnpm build` (`NODE_ENV=production` for prod) |
| Check the pot against the `t()` call sites      | `pnpm i18n:check`                             |
| Rebuild on change                               | `pnpm watch`                                  |
| Serve the built SPA                             | `python3 -m http.server -d public 8000`       |
| Lint everything (oxlint + prettier + stylelint) | `pnpm lint`                                   |
| Type-check (TypeScript 7; not test/ or `.vue`)  | `pnpm typecheck`                              |
| Auto-format                                     | `pnpm format:prettier`                        |
| Full test (lint + typecheck + mocha)            | `pnpm test`                                   |
| Mocha only (builds first)                       | `pnpm test:mocha`                             |
| Playwright e2e (needs `SEANCE_E2E_IRC_URL`)     | `pnpm test:e2e`                               |

There is no `pnpm dev`/`pnpm start`; build and serve `public/` statically. One mocha file:

```sh
NODE_ENV=test pnpm exec mocha --config=test/.mocharc.yml test/irc/client.ts
```

CI (`.github/workflows/ci.yml`) runs on every pull request and push to `develop`, in two parallel jobs after a frozen-lockfile install: `lint` (`pnpm lint`, `pnpm typecheck`) and `check` (the production build, mocha against it with `pnpm test:mocha:built`, and `tools/scenarios/smoke.mjs`: the built app boots in Chromium with no console error).

Live tests (`test/irc/*.live.ts`) are skipped unless `SEANCE_IRC_URL` is set; run them one file at a time. The dev ircd is `tools/nefarious-dev/run.sh` (Docker; `ws://` 8067, `wss://` 8443, channel `#seance`). Both: `docs/resources/nefarious2-dev.md`.

## Architecture

- **`client/`** — Vue 3 + Vuex + Vue Router SPA, built by Vite into `public/`. Components in `client/components/`, logic in `client/js/`, themes in `client/themes/` (`coffee` default; `docs/resources/themes.md`). Feature notes, one section each (do not disturb, the inbox, alert sounds, Lua scripting, …): `docs/resources/client-features.md`; the `ps` theme: `docs/resources/ps-theme-map.md`; web push: `docs/resources/web-push-map.md`; oper tools: `docs/resources/oper-tools-map.md`.
- **`client/js/socket.ts`** — `EventBus`, an in-process stand-in for socket.io-client. The `socket.on/emit` call shape is kept on purpose; `client/js/socket-events/*` are the consumers that mutate the store. Event names and payloads: `docs/resources/bus-contract.md` and `shared/types/socket-events.ts` — extend both together.
- **`client/js/irc/`** — the IRC layer: `transport.ts` (WebSocket) → `message.ts` (parser) → `caps.ts`/`sasl.ts`/`isupport.ts` → `client.ts` (`IrcClient`, one per network) → `handlers/` → `socket.dispatch(...)`. Input comes back through `bus.ts` → `commands/`. Module notes and protocol rules (unread counts, reconnects, SASL, retries, the server's throttle, pending messages, …): `docs/resources/irc-layer.md`.
  - **To add a handler**: a file in `handlers/` exporting `{COMMAND: handler}` and one entry in `handlers/index.ts` `modules`. Handlers mutate the client's model through `client.*` (`pushMessage`, `findChannel`, `timeOf`, …), never the transport or the store. Model: `handlers/away.ts`.
  - **To add a command**: a file in `commands/` exporting a `Command` and one entry in `commands/index.ts`. Build lines with `formatLine` / `trailingLine`. Model: `commands/away.ts`. Unknown commands are sent raw.
- **`client/js/translate/`** — on-device translation in its own worker (`js/translate-worker.js`, built by `vite.translate.config.mts` after every app build; WebLLM, transformers.js/ONNX Runtime, wllama), off by default: it runs only where the deploy allows it and the user's `translationEnabled` is on (`translate/switch.ts`), and while off nothing of it renders or runs but the detector behind the in-place offer to switch it on (translation.md § Offered in place). Summary: `docs/resources/client-features.md` § Translation; long form `docs/resources/translation.md`.
- **`client/js/i18n/`**, **`client/locales/`**, **`tools/i18n/`** — the interface's 24 languages: `messages.pot`, the `.po` catalogs compiled to JSON by `pnpm i18n:compile` (`pnpm build` runs it). `docs/resources/i18n.md`.
- **`shells/`** — the app shell around `public/`: `tauri/` (iOS, Android, Windows, macOS, Linux). The page reaches it through one bridge, `client/js/helpers/shell.ts`. Plan: `docs/projects/desktop-shells.md`; the shell has a README.
- **`shared/`** — cross-cutting types and helpers.
- **`attic/`** — TheLounge's old server. Reference only; never import from it.
- **`tools/`** — dev ircd, `irc-ws-probe.mjs`, `browser-drive.mjs` + `scenarios/` (real-Chromium checks; `docs/resources/browser-testing.md`).

## Rules

- **The suite has no browser and no DOM.** A change under `client/components/`, `client/css/` or the store is unverified by `pnpm test`; check it in a real browser (`docs/resources/browser-testing.md`). Feature sections in `docs/` name their browser scenario.
- **Rebuild after changing `client/` or switching branches.** `public/` is gitignored and shared, and the mocha build test reads it.
- **Size the UI in `rem`, never `px`.** Breakpoints stay px; anything that must follow the font scale uses a container query. Details: `docs/resources/client-features.md` § UI sizing.
- **Reduced motion and high contrast** are read from `html[data-reduce-motion]` / `html[data-contrast="more"]`, never `@media`.
- **Every `<input type="checkbox">` carries `v-switch`** (a test enforces it).
- **History is one deep**: every `router.push` is a `replace`; "back" is `leavePage()`.
- **Overlays**: whatever covers the screen carries `.screen-overlay`, and a backdrop closes through `v-backdrop`, never `@click.self` (tests enforce both).
- **No Node built-ins in `client/`**; new code has explicit types (`strict: true`). Modules that run under mocha (`irc/*`, `saved-networks.ts`, `sts.ts`) stay free of store and DOM imports.
- **The connect path is expensive**: each command costs ~2 s of server fake lag and the socket is ignored past 10 s. Pipeline registration (`CAP END` in the same flush as `CAP REQ`), autojoin is one `JOIN a,b,c`, per-channel work goes through `catchup.ts`, and anything automatic nobody is waiting for goes through `IrcClient.background`, not `send`. Nothing but registration before 001 (`client.isWelcomed`). Details: `docs/resources/irc-layer.md`.
- **`MAX_LINE_BYTES = 500`** caps every outbound line, tags included. Do not raise it.
- **localStorage keys are still `thelounge.*`.** Do not rename without a migration.
- **Every UI string goes through `t()`/`tCount()`.** `client/locales/messages.pot` is the only English copy; a key is a whole phrase with `{var}` placeholders, never translated fragments concatenated; user content and server text never pass through `t()`. New keys via `tools/i18n/add.ts`; `pnpm i18n:check` (inside `pnpm test:mocha` too) fails a call site the pot disagrees with. `docs/resources/i18n.md`.
- **New CSS uses logical properties** (`margin-inline-start`, `inset-inline-start`, `text-align: start`): right to left ships (`ar`); check it with the development build's `qqx` pseudo-locale (`NODE_ENV=development pnpm build`).
- **Prettier is enforced**; if `pnpm lint` fails, run `pnpm format:prettier` first.

## Tests

Tests mirror the source under `test/` (`test/irc/`, `test/helpers/`, `test/push/`, …); mocha config `test/.mocharc.yml`. IRC tests inject a `FakeTransport` through `transportFactory` and assert on `sinon.spy(socket, "dispatch")`. `test/irc/client.ts` installs that spy in a root-level `beforeEach` that applies to every file, so other files check `socket.dispatch.isSinonProxy` and only `restore()` a spy they own — follow that pattern. With `echo-message` and `labeled-response` negotiated, outgoing PRIVMSG/NOTICE carry `@label=s<n>`.

## Issues and docs

- GitHub Issues live on upstream `evilnet/seance` (always pass `-R evilnet/seance`); triage labels and conventions: `docs/agents/`.
- Glossary: `CONTEXT.md`; ADRs: `docs/adr/`; every other document: `docs/resources/codebase-guide.md` § Documentation and `docs/README.md`.
