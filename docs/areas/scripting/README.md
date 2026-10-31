# Scripting

Seance can run small [Lua](https://www.lua.org/manual/5.3/) programs of
yours: an auto-responder, a slash command of your own, something that
happens when someone joins or you are kicked. This section is the guide to
writing them.

- [Getting started](getting-started.md) — turning scripting on, your first
  script and command, the editor and the library, trying code with `/lua`,
  and where errors show up.
- [The `seance` API](api.md) — every event and its fields, commands,
  sending, printing, storage, and the Lua you get.
- [Cookbook](cookbook.md) — complete scripts to copy and change.
- [Limits and pitfalls](limits.md) — what a script cannot do, the limits it
  runs under, sharing scripts safely, and the mistakes everyone makes once.

## What to know first

- **Scripts run in your browser, and only while Seance is open.** They are
  not a bot: close the tab and they stop. Every tab that has Seance open
  runs them, so two tabs answer a `!ping` twice.
- **Scripts are kept on this device** (in the browser's storage). Another
  device has them only if you export and import them, or restore a settings
  backup — and they arrive switched off.
- **Scripting is off until you turn it on** (Settings → Scripts → Enable
  scripting). While it is off the Lua interpreter is not even downloaded.
- **It is Lua 5.3** ([Fengari](https://fengari.io/), Lua in JavaScript),
  with the `string`, `table`, `math`, `utf8` and `coroutine` libraries and
  one more table, `seance`, which is the script's only way to touch IRC.
  There is no `io`, `os` or `require`: no files, no clock, no timers, no web
  requests.
- **A script can read every message you see and send any line as you.**
  Read a script before you run one someone gave you.

How the sandbox is built, and why, is in
[`docs/resources/lua-scripting.md`](../../resources/lua-scripting.md);
this section is for people writing scripts.
