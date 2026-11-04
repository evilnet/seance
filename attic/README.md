# attic

**Reference only. Not built, not tested, not imported.**

This directory holds TheLounge's Node/Socket.IO server and everything that only
existed to support it, moved aside during the conversion to a static SPA that
speaks IRCv3 directly to nefarious2 over WebSocket (see
`docs/projects/initial_conversion.md`).

It is kept so we can look up how the old server handled things during the IRC
migration — how it parsed modes, what the kick handler did, how highlights were
matched, and so on — without those files polluting searches in `server/`-shaped
paths or showing up in lint/type-check/test runs.

| Path | What it was |
| --- | --- |
| `server/` | The Node backend: Express + Socket.IO server, `ClientManager`, `Client`, `Network`, models, `irc-events/`, `inputs/`, message storage, auth, packages. |
| `defaults/config.js` | Server-side default config (`~/.thelounge/config.js`). |
| `index.js` | The `thelounge` CLI entry point (`node index start`). |
| `.thelounge_home` | Pinned the server's runtime config directory when running from source. |
| `scripts/generate-config-doc.js` | Generated website docs from `defaults/config.js`. |
| `test/` | Server-only tests and fixtures (models, plugins, inputs, helper functions, config merging). |

Nothing in here is on the build path. `attic/` is excluded from Oxlint,
Prettier, and the tsconfigs. Do not add imports to it.
Once the migration is complete and nothing needs to be looked up any more, this
directory can be deleted.
