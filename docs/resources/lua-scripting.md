# Lua Scripting

Seance includes an embedded, sandboxed Lua scripting runtime powered by [Fengari](https://fengari.io/) (Lua 5.3 in pure JavaScript). It allows users to write custom client-side automation, slash commands, auto-responders, and event hooks directly inside the browser.

This page is how it is built. How to write scripts — the API, examples,
limits and pitfalls, for users — is [`docs/areas/scripting/`](../areas/scripting/README.md).

---

## Architecture & Sandboxing

### Off Unless Enabled (the master switch)

Scripting is gated by **Settings → Scripts → Enable scripting** (setting
`enableScripting`, default off). The flag lives in
`client/js/irc/scripting/enabled.ts`; `settings.ts` writes it and the script
manager subscribes to it.

While it is off:

- Fengari is packaged into an asynchronous chunk (`js/fengari.js`) and is
  **never downloaded** — the manager never creates its sandbox (not at boot,
  not for `/lua`, not for a syntax check), so there is 0 byte impact.
- No script handler fires, no script command is known, `/lua` answers that
  scripting is disabled, and the Scripts tab shows only the switch.
- Scripts and their data are kept; turning the switch back on reloads the
  enabled scripts.

Turning it off closes the Lua state at once (`scriptManager.teardown()`), so
nothing a script registered can fire again. Turning it on loads Fengari and
the enabled scripts on demand.

### The sandbox

Scripts run in one Fengari state with no way out to the page. They cannot
reach `window`, `document`, `fetch` or `localStorage` (and so no SASL
password, bouncer token or query log), only the `seance.*` table. How
(`client/js/irc/scripting/engine.ts`):

- **Only safe libraries are opened**: base, `coroutine`, `table`, `string`,
  `math` and `utf8`. `io`, `os`, `package` and `debug` are never opened, so
  they are absent from the registry too, and there is no `require`.
  (Removing the globals after `luaL_openlibs` was not enough: `require`
  read them back from `package.loaded`, and `debug.sethook` switched off the
  instruction limit.)
- **Source text only**: `load` always uses mode `"t"` (Lua's undumper trusts
  bytecode); `string.dump`, `dofile` and `loadfile` are removed.
- **One environment per script**: a script's globals are its own, and its
  `seance` table is bound to its id, so `seance.storage` and error reports
  always belong to the script whose handler or command is running. `/lua`
  snippets share one environment, and the `global` storage bucket.
- **The standard library is read-only, per script**: each script sees
  `string`, `table`, `math` and the rest through views of its own
  (`__newindex` raises; `rawset` on a view changes only that script's view),
  its `_G` is its own environment, its `load` defaults to that environment,
  and the string metatable is locked (`getmetatable("")` is `false`). So no
  script can replace `pcall` or `string.format` under another, or capture
  another's `seance` functions that way.
- **Every handler gets its own copy of the event**: one handler rewriting
  `msg.target` or `msg.networkUuid` cannot steer the next one's reply.
  `seance.reply` reads only the fields it needs from the table it is given,
  and `/lua` names a returned table (`[lua table]`) rather than walking it.
- **`seance` is read-only** (`__newindex` raises, `__metatable` is locked),
  and the handler and command tables live in locals of the bootstrap chunk,
  out of every script's reach.
- **No script can break the state for the others**: a JavaScript exception
  inside the VM becomes a Lua error (`lua_atnativeerror`), and error objects
  are described without their `__tostring` (one that loops or fails used to
  panic Fengari and leave every later call failing).
- **Loading is ordered**: every reload or switch-off bumps a generation, and
  a sandbox that finishes loading Fengari for an older one is closed instead
  of installed, so turning scripting off while it loads leaves nothing
  running and overlapping reloads load each script once.

### Limits

- **Instructions**: 100,000 per call (a script's load, one event handler, a
  command), counted every 1,000 by a `LUA_MASKCOUNT` hook that coroutines
  inherit and charge to the same budget. Once the budget is spent every
  instruction raises, so `while true do pcall(f) end` cannot catch the error
  and go round again. The error is
  `Instruction limit exceeded (possible infinite loop)`. Each handler and
  command runs through the host's `run`, which gives it a fresh budget and
  gives the dispatch loop a fresh one when it returns, so a handler that
  spends everything is reported and the handlers after it still run. One
  event may run 1,000,000 instructions across all its handlers
  (`MAX_EVENT_INSTRUCTIONS`); past that the rest are skipped with one error.
- **Handlers and commands**: at most 50 handlers per event name and 100
  command names across all scripts (`MAX_HANDLERS`, `MAX_COMMANDS`). An
  event runs the handlers registered before it started: one a handler adds
  waits for the next event.
- **Pattern matching** (`string.find`/`match`/`gmatch`/`gsub`): one call
  may take 200,000 steps (calls to Fengari's `match`; one `gmatch` step
  counts on its own), then fails with
  `pattern too complex (step limit)`. Fengari's matcher counted only its
  recursion depth and runs as one native call the instruction hook cannot
  interrupt, so the budget is patched into `fengari/src/lstrlib.js` at build
  time by a webpack loader, `scripts/fengari-match-budget.js`; each patch
  must find its anchor exactly once, so a Fengari upgrade that moves the code
  fails the build instead of shipping an unbounded matcher. Mocha loads
  Fengari unpatched: `test/scripts/fengari-match-budget.ts` compiles the
  patched source beside it and runs the pathological pattern,
  `test/tests/build.ts` checks the built chunk carries the patch, and
  `tools/scenarios/scripting-editor.mjs` runs one in the browser.
- **Integers are 32-bit** in Fengari (`math.maxinteger` is 2^31 − 1 and
  integer arithmetic wraps), not 64-bit as in standard Lua 5.3.
- **Memory** is not bounded by Fengari. `string.rep` refuses results over
  1 MiB (its count is checked after the same number conversion `string.rep`
  does, so `"500000000"` counts too); repeated concatenation can still build large strings within the
  instruction budget, and only hurts the tab running the script.
- **Storage**: sizes are characters, which is what localStorage counts
  (about 5M per origin, shared with the networks, the query logs and every
  setting), and scripting stays under 400k of it: 16,000 per script
  (`MAX_CODE_LENGTH`; the editor stops typing there and refuses a longer
  import), 256,000 for the library, 16,000 of `seance.storage` per script
  and 128,000 for all of it. A script saved under the earlier 50,000 limit
  still loads but must be shortened to be saved again. Every write is read
  back, since the localStorage wrapper swallows a full quota: a refused save
  shows in the editor as "Not saved: …" and a refused `seance.storage.set`
  raises a Lua error; nothing stored changes either way.
- **Sending**: a line sent from a command or `/lua` you typed goes out at
  once. A line sent from an event handler (or while loading) goes through
  the connection's background queue (`IrcClient.background`), paced by the
  fake-lag clock; past 10 waiting, more are dropped with an error. A
  script's own PRIVMSG/NOTICE is remembered for a minute and its echo does
  not fire `message` handlers, so an auto-responder cannot answer itself in
  a loop.

## The `seance` API

Every script has access to the global `seance` table:

### Events & Callbacks

#### `seance.on(event, callback)`

Subscribes to client events.

```lua
seance.on("message", function(msg)
    -- msg.network: Network name (e.g. "SeanceDev")
    -- msg.networkUuid: The connection's id (every event has one; two
    --                  connections can share a name)
    -- msg.target:  Channel or nickname (e.g. "#channel")
    -- msg.from:    Sender nick
    -- msg.text:    Message content
    -- msg.type:    "message", "notice", or "action"
    -- msg.self:    boolean (true if sent by own client)
    -- msg.tags:    IRCv3 tags table

    if msg.text == "!ping" and not msg.self then
        seance.reply(msg, "pong!")
    end
end)
```

```lua
seance.on("send", function(data)
    -- data.line:   The message text sent (not a raw line; no network fields)
    -- data.target: Target channel or nick
end)
```

```lua
seance.on("join", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.channel: Channel name
    -- data.nick:    Joined nick
    -- data.account: Optional account name (if extended-join)
    -- data.ident:   Username
    -- data.host:    Hostname
    -- data.self:    boolean (true if own client joined)
end)
```

```lua
seance.on("part", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.channel: Channel name
    -- data.nick:    Parting nick
    -- data.message: Optional part message
    -- data.self:    boolean (true if own client parted)
end)
```

```lua
seance.on("quit", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.nick:    Quit nick
    -- data.message: Optional quit message
end)
```

```lua
seance.on("kick", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.channel: Channel name
    -- data.nick:    Kicker nick
    -- data.kicked:  Kicked nick
    -- data.reason:  Optional kick reason
    -- data.self:    boolean (true if own client was kicked)
end)
```

```lua
seance.on("nick", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.oldNick: Previous nickname
    -- data.newNick: New nickname
    -- data.self:    boolean (true if own client renamed)
end)
```

```lua
seance.on("topic", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.channel: Channel name
    -- data.topic:   New topic text
    -- data.nick:    Setter nickname
end)
```

```lua
seance.on("mode", function(data)
    -- data.network: Network name
    -- data.networkUuid: The connection's id
    -- data.target:  Channel or nickname
    -- data.mode:    Mode string (e.g. "+o", "-b")
    -- data.params:  Array of mode parameters
    -- data.from:    Setter nickname
end)
```

### Slash Commands

#### `seance.register_command(name, callback)`

Registers a custom client slash command. Registered commands automatically participate in chat autocompletion.

```lua
seance.register_command("slap", function(args, rest)
    local target = rest ~= "" and rest or "themselves"
    local chan = seance.current_channel
    if chan ~= "" then
        seance.send("PRIVMSG " .. chan .. " :\001ACTION slaps " .. target .. " with a large trout\001")
    end
end)
```

### Messaging Helpers

- `seance.reply(msg, text)`: Replies on the event's own connection (`msg.networkUuid`): in the channel for a channel message, to the other side for a private one (its target, when the line was our own).
- `seance.send(rawLine, networkUuid?)`: Sends a raw IRC line on the network with that uuid (an event's `networkUuid`), or on the current network. A uuid that matches no connection sends nothing; it never falls back to another network.
- `seance.print(text)`: Displays a local client message in the active conversation window.

### Persistent Key-Value Storage

Scripts can persist state across browser sessions and page reloads:

- `seance.storage.get(key)`: Returns stored string, or `nil` if not found.
- `seance.storage.set(key, value)`: Saves `value` (string) for `key`, or deletes `key` if `value` is `nil`.

```lua
local seen = seance.storage.get("last_seen") or "never"
seance.print("Last run: " .. seen)
seance.storage.set("last_seen", seance.current_channel)
```

### Context Properties

- `seance.current_channel`: Name of active channel / query tab.
- `seance.current_network`: Name of active network.
- `seance.nick`: Nickname on active network.

---

## User Interface & Commands

1. **Settings → Scripts** (`Settings/Scripts.vue` at `/settings/scripts`,
   one tab of the settings modal like the others; nothing in the sidebar):

   - The tab always holds the Enable scripting switch; the library shows
     only while it is on.
   - **The library**: every script is filed under a _folder_ (free text,
     `Unsorted` when unset; scripts written before folders land there) with
     an optional one-line description, listed by folder, then name, each
     row with its state (Running / Off / Error) and an on/off switch. Past
     six scripts a search over name, folder, description and code appears.
     New script, Import .lua… and two examples (Auto-responder under
     _Automation_, /slap under _Commands_) each open the new script in the
     editor. An imported file arrives switched off, as a restored backup's
     scripts do.
   - **The editor** (`Settings/ScriptEdit.vue` at `/settings/scripts/<id>`,
     a child route of the tab, only while scripting is on) is one more
     overlay over the settings modal, teleported into `#viewport` at
     z-index 30 (the settings are 20, the confirm dialog and menus 999 and
     up, so Delete's question shows over it): the window less a margin,
     the whole screen on a phone, in the settings' frame — a header with
     ✕, a body that scrolls, a footer with Done — with the list still
     under it. Done, ✕, Escape and the backdrop close it back to the list,
     which reads the library again. It holds name, folder, description,
     Run this script, the code filling the height the fields leave, and Check
     syntax (compiles without running), Duplicate (the copy arrives off),
     Export .lua and Delete.
   - **The code field** is CodeMirror 6 (`helpers/luaEditor.ts`): the Lua
     mode from `@codemirror/legacy-modes`, line numbers, undo history,
     bracket matching. Its tokens carry the same `tok-*` classes Prism gives
     a code block in chat (keyword, string, comment, number, and the
     standard library's globals as `tok-function`), so every theme's
     `--tok-*` palette colours both alike. Tab indents (four spaces at the
     caret, or the selected lines); Shift+Tab is left to the browser, so it
     leaves the field. It is its own lazily loaded chunk, `js/code-editor.js`
     (about 300 KB, 96 KB gzipped, licence banner in `webpack.config.ts`),
     imported when an editor opens; until it arrives, or if it cannot, a
     plain textarea stands in. A name the library would drop on its next load — invalid, or
     another script's — is shown as an error and not saved
     (`irc/scripting/library.ts` `scriptNameError`). Edits save as they
     are typed; the sandbox reloads when an edit is committed (the field
     loses the caret, the switch flips, the editor closes), so a script's
     top-level code does not run again at every pause in the typing. The
     error banner follows what the manager last recorded.

2. **`/lua <code>` Command**:

   - Executes a Lua expression or statement directly in chat.
   - Example: `/lua return 2 + 2`
   - Example: `/lua seance.print("Current channel: " .. seance.current_channel)`

3. **Backup & Restore**:
   - Stored under `thelounge.scripts` and `thelounge.script_storage.*`.
   - Automatically included in Seance Settings Backup (`.seance-settings` files).
   - A restore brings every script back switched off, and Enable Scripting
     too (`settingsBackup.ts` `disarmScripts`): a script can send any line
     and read every message, so one from a file — perhaps someone else's —
     runs only after it is turned on here.
