<h1 align="center">Seance</h1>

<h3 align="center">
	A static, bouncer-less web IRC client that talks IRCv3 straight to the ircd
</h3>

<p align="center">
	<a href="https://github.com/evilnet/seance/actions/workflows/pages.yml"><img
		alt="Pages build"
		src="https://github.com/evilnet/seance/actions/workflows/pages.yml/badge.svg"></a>
</p>

<p align="center">
	<strong>Try it:</strong> <a href="https://evilnet.github.io/seance/">evilnet.github.io/seance</a>
	— the latest release, straight from GitHub Pages. <code>develop</code> and every open
	pull request are built beside it: <a href="https://evilnet.github.io/seance/previews/">evilnet.github.io/seance/previews</a>
</p>

## Overview

Traditional Web based IRC clients (TheLounge, KiwiIRC etc) require you to host
a service somewhere to translate between http requests and IRC. But that era is
coming to an end. Modern IRC servers like Nefarious2 have support for
web-sockets directly, and chat history, and fast-reconnect. This means Seance
can operate without a seperate service.

Seance is a static site: A browser-based IRC client with **no server of its own**.
The page opens a WebSocket directly to a compatable IRC server. It supports modern
IRC features:

SASL, `message-tags`,
`server-time`, `batch`, `echo-message`, `labeled-response`, `draft/chathistory`,
`draft/read-marker`, `draft/message-redaction`, `+typing`, STS and more.

- **Just files.** Build once, drop `public/` on any web server (or GitHub Pages),
  done. No Node process, no database, no accounts on the client side.
- **Brandable** `config.json` can set the network name, default server,
  theme, logo, help links, uploader and feature switches; see
  [`docs/resources/branding.md`](docs/resources/branding.md).
- **Chat History.** Backlog, read markers and catch-up after a
  reconnect all come from the ircd's `CHATHISTORY` capability.
- **Modern chat features.** Replies, reactions, editing and deletion, typing
  indicators, inline media previews, search, mentions, multiple networks.
- **Installable.** Seance also supports use as a Chrome/Edge/Android PWA
  (Progressive Web App) ([`docs/resources/pwa.md`](docs/resources/pwa.md)),
  and has a framework for being built as an Electron and
  Capacitor app for desktop and mobile stores (ios/apple/etc) under [`shells/`](shells/).

Seance is built primarily and tested for **nefarious2** (`ircv3.2-upgrade` beta
branch), EvilNet's ircd, but any ircd that offers IRC over WebSocket and the
same caps should work, degrading gracefully where a cap is missing. It works on
Nefarious ircd, Unrealircd etc.

Try it out on these networks:

- AfterNET: webirc.afternet.org port 9998 (web+irc://webirc.afternet.org:9998/#seance)
- Swiftirc: fiery.swiftirc.net port 4443 (web+irc://fiery.swiftirc.net:4443/#swiftric)
- Unreal ircd: irc.unrealircd.org port 443 (web+irc://irc.unrealircd.org/#chat)

If you have religious anti-AI beliefs, this project is not for you. The project
is built mainly with Claude Code (fable). ("But where are all the apps!")

Driving claude, however, are seasoned IRC veterans who "get it" with regards
to classic IRC culture but also strive to expand the IRC experience with modern
features normal folks have rightly become used to in apps like Discord and Slack.

Seance began as a fork of [The Lounge](https://github.com/thelounge/thelounge)
— The Vuejs user interface, themes and years of polish built the foundation this
inherits. Thank you to The Lounge contributors, and to [Shout](https://github.com/erming/shout) before
it. Seance is MIT licensed (like they were).

We are greatful for, and lean heavily on the [ircv3](https://ircv3.net/) project
which has been working for a very long time on some of these expanded IRC capabilities
and extensions to the IRC protocol. But we also feel their incentives and taste differ
from our own, so we embrace our own path in some areas choosing to create alternative
CAPs or modify the implementation to suit us.

## Building and serving

Requires [Node.js](https://nodejs.org/) 22 or newer and Yarn 1 (classic), which
ships with Node's `corepack`.

```sh
git clone https://github.com/evilnet/seance.git
cd seance
corepack yarn install
NODE_ENV=production corepack yarn build
```

That produces `public/`. Serve it from any static host:

```sh
python3 -m http.server -d public 8000
```

and open http://localhost:8000/. Brand it by editing `client/config.json`
before the build (or `public/config.json` after — runtime settings are read
from there on every page load).

The IRC server has to accept WebSocket connections from the page's origin over
`wss://` (a browser will not open a plain `ws://` socket from an `https://`
page). Running nefarious2 for local development, including a Docker script
with a self-signed certificate, is described in
[`docs/resources/nefarious2-dev.md`](docs/resources/nefarious2-dev.md).

## Development

```sh
corepack yarn watch      # rebuild public/ on change
corepack yarn lint       # eslint + prettier + stylelint
corepack yarn test       # lint + mocha
corepack yarn test:mocha # mocha only (builds first)
```

Run `corepack yarn githooks-install` once to get the pre-commit lint hook. If
linting fails, `corepack yarn format:prettier` usually fixes it.

Live tests against a real ircd (`test/irc/*.live.ts`) run when
`SEANCE_IRC_URL` points at one, e.g. `SEANCE_IRC_URL=wss://localhost:8443/`.

Where things live:

- `client/js/irc/` — the IRC layer: WebSocket transport, parser, CAP/SASL,
  one handler per command, one file per slash command.
- `client/components/`, `client/js/` — the Vue 3 app.
- `docs/` — design notes and plans:
  [`bus-contract.md`](docs/resources/bus-contract.md) (the events between the
  IRC layer and the UI), [`nefarious2-websocket.md`](docs/resources/nefarious2-websocket.md)
  (what the server actually does on the wire), and `docs/projects/` for
  in-progress work.
- `tools/` — the dev ircd runner, a WebSocket IRC probe and a PWA
  installability check.
- `attic/` — the original server code, kept for reference only.

See [`CLAUDE.md`](CLAUDE.md) for a fuller map of the codebase and its
conventions.

## Status

Usable as a daily client against nefarious2; branding, PWA, and Electron
packaging are in place, mobile shells are scaffolded. Push notifications
work on chrome/PWA but not yet in the app frameworks (it needs the
ircd's `draft/webpush` to send). The original plan and its checklist are in
[`docs/projects/initial_conversion.md`](docs/projects/initial_conversion.md).
