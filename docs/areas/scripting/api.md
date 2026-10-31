# The `seance` API

Everything a script can do with IRC goes through one global table,
`seance`. It is read-only (assigning to it raises an error) and it is the
script's own: storage and error reports always belong to the script whose
code is running.

| Name                                                                          | What it is                          |
| ----------------------------------------------------------------------------- | ----------------------------------- |
| [`seance.on(event, fn)`](#events)                                             | Call `fn` on every `event`          |
| [`seance.register_command(name, fn)`](#commands)                              | Add a slash command `/name`         |
| [`seance.send(line, networkUuid?)`](#seancesendline-networkuuid)              | Send a raw IRC line                 |
| [`seance.reply(msg, text)`](#seancereplymsg-text)                             | Answer a message where it came from |
| [`seance.print(text)`](#seanceprinttext)                                      | Show a line only you can see        |
| [`seance.storage.get(key)` / `.set(key, value)`](#storage)                    | Keep strings across reloads         |
| [`seance.current_channel`, `seance.current_network`, `seance.nick`](#context) | Where you are                       |

## Events

```lua
seance.on("join", function(ev)
    seance.print(ev.nick .. " joined " .. ev.channel)
end)
```

`seance.on(event, fn)` calls `fn` with a table describing each event as it
happens. A script may register as many handlers as it likes, for as many
events as it likes, up to 50 per event name across all scripts.

- Event names are not case-sensitive. A name that is not one of the nine
  below is accepted and never fires.
- `fn` must be a function. Anything else is **silently ignored** — a
  common slip is passing a `local function` that is only defined further
  down the file, which is still `nil` at that point.
- Every handler gets its own copy of the event table; changing it changes
  nothing for the next handler.
- **Only live events fire.** Scrollback loaded from the server, the
  catch-up after a reconnect and anything else replayed from history never
  run handlers, so a script never answers an old message.
- Lines from people on your ignore list never reach scripts.
- Every event except `send` carries `network` (the network's name, as the
  server announces it, e.g. `AfterNET`) and `networkUuid` (the
  connection's id; pass it to `seance.send` to answer on the right
  network — two connections can have the same name).

### `message`

A message, action (`/me`) or notice in a channel or a private
conversation.

| Field         | Type    | Meaning                                                                                                                                                                                                                        |
| ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network`     | string  | The network's name                                                                                                                                                                                                             |
| `networkUuid` | string  | The connection's id                                                                                                                                                                                                            |
| `target`      | string  | Where it was sent: the channel (`#seance`), or for a private message your own nick — or, for your own private message, the other person's                                                                                      |
| `from`        | string  | Who sent it                                                                                                                                                                                                                    |
| `text`        | string  | The text; for an action, without the `ACTION` wrapping                                                                                                                                                                         |
| `type`        | string  | `"message"`, `"action"` or `"notice"`                                                                                                                                                                                          |
| `self`        | boolean | `true` for your own lines                                                                                                                                                                                                      |
| `tags`        | table   | The line's IRCv3 tags with a value, by name: `tags.time` (`"2026-10-30T14:05:09.123Z"`), `tags.msgid`, `tags.account` (the sender's account, when the server sends it), `tags["+draft/reply"]`… Always a table, possibly empty |

- **Your own lines fire too** (`self` is `true`): what you type, as the
  server echoes it back, and what you send from another device. The echo
  of a line a _script_ sent does not fire — so an auto-responder cannot
  answer itself in a loop — but check `msg.self` anyway, or you will answer
  your own `!ping`.
- A message to `@#channel` (to the channel's ops only) arrives with
  `target` `#channel`.
- CTCP requests and replies other than `ACTION` (`VERSION`, `PING`, …) do
  not reach scripts.

### `send`

You sent a message, action or notice from Seance — typed in the input, or
with `/msg`, `/me`, `/notice`, or an edit.

| Field    | Type   | Meaning                                              |
| -------- | ------ | ---------------------------------------------------- |
| `line`   | string | The text you sent (not a raw IRC line; no `PRIVMSG`) |
| `target` | string | The channel or nick it went to                       |

`send` has no `network` or `networkUuid`, and it cannot change or stop the
message: by the time it fires, the message is on its way. Lines that
scripts send, and raw commands, do not fire it.

### `join`

Someone joined a channel you are in, or you joined one.

| Field         | Type       | Meaning                                                                            |
| ------------- | ---------- | ---------------------------------------------------------------------------------- |
| `network`     | string     | The network's name                                                                 |
| `networkUuid` | string     | The connection's id                                                                |
| `channel`     | string     | The channel                                                                        |
| `nick`        | string     | Who joined                                                                         |
| `account`     | string/nil | Their account, when the server reports it (`extended-join`) and they are logged in |
| `ident`       | string/nil | Their username (the part before the `@`)                                           |
| `host`        | string/nil | Their host                                                                         |
| `self`        | boolean    | `true` when it is you                                                              |

Your own join fires on **every** connect and reconnect, once for each
channel. Read it as "I am in this channel now", not "I just chose to join
it".

### `part`

Someone left a channel you are in, or you left one.

| Field         | Type       | Meaning                    |
| ------------- | ---------- | -------------------------- |
| `network`     | string     | The network's name         |
| `networkUuid` | string     | The connection's id        |
| `channel`     | string     | The channel                |
| `nick`        | string     | Who left                   |
| `message`     | string/nil | Their part message, if any |
| `self`        | boolean    | `true` when it is you      |

### `quit`

Someone who shares a channel with you disconnected. It fires once per quit,
however many channels you shared.

| Field         | Type       | Meaning                    |
| ------------- | ---------- | -------------------------- |
| `network`     | string     | The network's name         |
| `networkUuid` | string     | The connection's id        |
| `nick`        | string     | Who quit                   |
| `message`     | string/nil | Their quit message, if any |

### `kick`

Someone was kicked from a channel you are in — perhaps you.

| Field         | Type       | Meaning                         |
| ------------- | ---------- | ------------------------------- |
| `network`     | string     | The network's name              |
| `networkUuid` | string     | The connection's id             |
| `channel`     | string     | The channel                     |
| `nick`        | string     | Who did the kicking             |
| `kicked`      | string     | Who was kicked                  |
| `reason`      | string/nil | The reason given, if any        |
| `self`        | boolean    | `true` when **you** were kicked |

Note the difference from the other events: `nick` is the kicker, and
`self` is about the person kicked.

### `nick`

Someone who shares a channel with you changed their nick, or you changed
yours.

| Field         | Type    | Meaning               |
| ------------- | ------- | --------------------- |
| `network`     | string  | The network's name    |
| `networkUuid` | string  | The connection's id   |
| `oldNick`     | string  | The nick before       |
| `newNick`     | string  | The nick after        |
| `self`        | boolean | `true` when it is you |

### `topic`

Someone changed a channel's topic. The topic shown when you join is not a
change and does not fire.

| Field         | Type   | Meaning                          |
| ------------- | ------ | -------------------------------- |
| `network`     | string | The network's name               |
| `networkUuid` | string | The connection's id              |
| `channel`     | string | The channel                      |
| `topic`       | string | The new topic (empty if cleared) |
| `nick`        | string | Who changed it                   |

### `mode`

A mode change on a channel, or on you.

| Field         | Type   | Meaning                                                      |
| ------------- | ------ | ------------------------------------------------------------ |
| `network`     | string | The network's name                                           |
| `networkUuid` | string | The connection's id                                          |
| `target`      | string | The channel, or your nick for your own user modes            |
| `mode`        | string | The change as sent, e.g. `"+o"`, `"+ov-b"`                   |
| `params`      | table  | Its parameters in order, e.g. `{"alice", "bob", "*!*@spam"}` |
| `from`        | string | Who set it (the server's name when the server did)           |

A change with several letters arrives as one event; pair the letters with
`params` yourself.

## Commands

```lua
seance.register_command("greet", function(args, rest)
    if args[1] == nil then
        seance.print("Usage: /greet <nick>")
        return
    end
    seance.send("PRIVMSG " .. seance.current_channel .. " :Welcome, " .. args[1] .. "!")
end)
```

`seance.register_command(name, fn)` adds `/name`. When you type it, `fn` is
called with:

- `args` — the text after the command split at single spaces:
  `/greet alice bob` gives `{"alice", "bob"}`. Two spaces in a row give an
  empty word between them.
- `rest` — the text after the command name exactly as typed (`""` when
  there is none).

What to know:

- The name has no leading `/`, and is not case-sensitive (`/GREET` works).
- **Built-in commands win**: a script cannot replace `/join`, `/msg`,
  `/me` or any other command Seance already has. Your aliases
  (Settings → Aliases) are expanded before commands are looked up, so an
  alias can call a script's command — and an alias with the same name hides
  it.
- Registering a name again — in the same script or another — replaces the
  earlier one; the last script loaded wins. There can be 100 command names
  across all scripts.
- Script commands show in the input's autocompletion.
- A command runs even while the network is down, but what it sends then is
  dropped.
- If the command fails, the error is reported (`[Lua error] Error in /greet command: …`); the line is never sent to the server as a raw
  command instead.
- Inside a command, [`seance.current_channel`](#context) and friends are
  the conversation you typed in, and `seance.send` without a network goes
  to that network, at once.

## Sending

### `seance.send(line, networkUuid?)`

Sends one raw IRC line, exactly as written:

```lua
seance.send("PRIVMSG #seance :hello")
seance.send("PRIVMSG #seance :\001ACTION waves\001") -- an action, like /me
seance.send("MODE #seance +v alice", ev.networkUuid)
seance.send("JOIN #lua")
```

- **Which network.** With `networkUuid` (from an event), that connection;
  if no connection has that id, nothing is sent — never to another network.
  Without it: in a command or `/lua`, the network you typed on; anywhere
  else, the network of the conversation you have open. So **in an event
  handler, always pass the event's `networkUuid`**.
- **One line, at most 500 bytes**, the command included. No line breaks;
  Seance does not split long text for you. A line that breaks either rule
  is not sent, and the network's lobby says so.
- **Only while connected.** A line for a network that is down, or still
  connecting, is dropped; only the browser's developer console says so.
- **When it goes.** From a command or `/lua`, at once. From an event
  handler, or a script's top-level code, it waits its turn behind the
  server's flood allowance — usually immediately, but a few seconds when
  Seance has been busy, since a server that thinks it is being flooded
  stops reading. At most 10 script lines can wait per network; past that a
  line is dropped with a `[Lua error] Not sent: …` line.
- **Seeing it.** A message a script sends appears in the conversation when
  the server echoes it back. Servers with the `echo-message` capability
  (nefarious2, the server Seance is built for, has it) do; on a server
  without it you will not see your script's messages in the window, though
  everyone else does.

### `seance.reply(msg, text)`

Answers a `message` event where it came from, on the event's own network:
in the channel, for a channel message; to the other person, for a private
one.

```lua
seance.on("message", function(msg)
    if msg.text == "!time" and not msg.self and msg.type == "message" then
        seance.reply(msg, "Server time: " .. (msg.tags.time or "unknown"))
    end
end)
```

- It sends a `PRIVMSG` with `text` — always a `PRIVMSG`, even when the
  event was a notice. Don't answer notices automatically (check
  `msg.type == "message"`): two programs answering each other's notices
  can talk forever.
- The same rules as `seance.send` apply: one line, at most about 450 bytes
  of text, paced from a handler.
- It reads only the `network`, `networkUuid`, `target`, `from` and `self`
  fields of the table, so you can also build one yourself.

### `seance.print(text)`

Shows `text` as a line from `lua` that only you see. It is not sent
anywhere and is gone after a reload.

- In a command or `/lua`: in the conversation you typed in.
- In an event handler, or while loading: in the conversation you have open
  — wherever you are, not where the event happened. Early in a page load,
  before any conversation is open, the line goes nowhere.

## Storage

```lua
local runs = tonumber(seance.storage.get("runs")) or 0
seance.storage.set("runs", tostring(runs + 1))
seance.print("This script has loaded " .. (runs + 1) .. " times.")
```

`seance.storage` keeps strings on this device, across reloads and page
loads.

- `seance.storage.get(key)` returns the string stored under `key`, or
  `nil`.
- `seance.storage.set(key, value)` stores `value` under `key`;
  `value` `nil` deletes the key.
- **Store strings.** A number is turned into a string (`42` comes back as
  `"42"`; use `tonumber`). A boolean or a table is stored as an empty
  string, so convert it yourself — `tostring(flag)`, or join a list with
  `table.concat(list, "\n")` and split it again with
  `text:gmatch("[^\n]+")`. There is no JSON library.
- **Each script has its own storage**, kept by the script's identity, not
  its name: renaming a script keeps it, **Duplicate** starts the copy with
  none, and **Delete** removes it. All `/lua` snippets share one storage of
  their own.
- **Limits:** 16,000 characters per script (keys, values and a little
  bookkeeping) and 128,000 for all scripts together. A `set` that would go
  over raises a Lua error and changes nothing; so does one the browser
  refuses because its storage is full.
- Scripts and their storage travel in a
  [settings backup](../../resources/settings-backup.md).

## Context

| Name                     | Inside a command or `/lua`       | Anywhere else                        |
| ------------------------ | -------------------------------- | ------------------------------------ |
| `seance.current_channel` | The conversation you typed in    | The conversation you have open       |
| `seance.current_network` | That conversation's network name | The open conversation's network name |
| `seance.nick`            | Your nick on that network        | Your nick on the open network        |

- **In an event handler these describe the window you are looking at,
  not where the event happened.** Use the event's own fields (`msg.target`,
  `ev.channel`, `ev.networkUuid`).
- In a network's lobby, `seance.current_channel` is the network's name, so
  `seance.current_channel == seance.current_network` tells a command that
  it was typed in the lobby, where there is nobody to talk to.
- With nothing open, all three are `""`.

## The Lua you get

Scripts are Lua 5.3 (the [reference manual](https://www.lua.org/manual/5.3/)).

- **Libraries:** the base functions (`pairs`, `ipairs`, `tostring`,
  `tonumber`, `pcall`, `error`, `select`, `type`, `setmetatable`, …),
  `string`, `table`, `math`, `utf8` and `coroutine`.
- **Not there:** `io`, `os`, `debug`, `package` and `require`, `dofile`,
  `loadfile`, `string.dump`. So no files, no `os.time` or `os.date`, no
  timers and no web requests. `load` takes source text only. For the time,
  use a message's `tags.time` (the [cookbook](cookbook.md#a-clock-from-the-server)
  turns it into seconds).
- **Numbers** are integers or floats: `7 // 2` is `3`, `7 / 2` is `3.5`,
  and `10 / 2` is `5.0` — which prints as `5.0`. Use `//`, `math.floor` or
  `string.format("%d", n)` for whole numbers in text.
- **Integers are 32-bit**, unlike standard Lua's 64: `math.maxinteger` is
  2,147,483,647, `2147483647 + 1` wraps round to `-2147483648`, and
  `86400 * 30000` is negative. A literal too big for an integer becomes a
  float (`3000000000` is `3000000000.0`). For big numbers — Unix time in
  seconds after 2038, milliseconds at all — calculate in floats (`86400.0 * days`), which are exact up to 2^53, and format them with
  `string.format("%.0f", n)`.
- **Strings are bytes.** `#text` counts bytes (`#"ツ"` is 3), and
  `string.upper`/`lower` change only ASCII letters. `utf8.len(text)` counts
  characters and `utf8.codes` walks them.
- **The standard library is read-only**: `string.trim = …` raises an
  error, and strings' metatable cannot be reached. Write `local function trim(s) … end` instead.
- **Each script has its own globals.** A global in one script is invisible
  to the others, and there is no `require`: to share a helper, copy it into
  each script that needs it.
- **`print` writes to the browser's developer console**, not the chat; use
  `seance.print`.
- Every handler, command and script load gets a budget of 100,000 Lua
  instructions — roughly 50,000 turns of an empty loop, or ten thousand or
  so that do real work. Past it the call stops with
  `Instruction limit exceeded (possible infinite loop)`. See
  [limits](limits.md) for this and the others.
