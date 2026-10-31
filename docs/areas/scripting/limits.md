# Limits and pitfalls

## What a script cannot do

- **Run when Seance is closed.** Scripts live in the page. Close the tab
  or let the phone discard it, and nothing runs until the page is back.
- **Run once.** Every tab with Seance open runs every switched-on script,
  and so does every device you have restored them on. Two tabs answer a
  `!ping` twice.
- **Do something later.** There are no timers and no clock: a script runs
  only when an event arrives or you type its command. For the time a
  message was sent, read its `tags.time`
  ([cookbook](cookbook.md#a-clock-from-the-server)).
- **Reach outside IRC.** No web requests, no files, no access to the page,
  its settings, your saved passwords or the query logs. A script sees what
  `seance` gives it and nothing else.
- **Reach another script.** Each script has its own globals and its own
  storage; one cannot read, call or break another.
- **Change or stop a message.** `message` and `send` tell a script about a
  line; they cannot rewrite it or keep it from being shown or sent.
- **Add to the interface.** A script's only output on screen is
  `seance.print`.

## The limits

| What                                      | Limit                                   | Past it                                                                                              |
| ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| One handler, command or script load       | 100,000 Lua instructions                | `Instruction limit exceeded (possible infinite loop)`; the next handler still runs                   |
| One event, all handlers together          | 1,000,000 instructions                  | The rest are skipped: `Skipped the rest of this message event: its handlers ran out of instructions` |
| One `string.find`/`match`/`gmatch`/`gsub` | 200,000 matching steps                  | `pattern too complex (step limit)`                                                                   |
| `string.rep`                              | a 1 MiB result                          | `string.rep: result too large`                                                                       |
| Handlers                                  | 50 per event name, all scripts together | `seance.on: too many message handlers (50)`                                                          |
| Commands                                  | 100 names, all scripts together         | `seance.register_command: too many commands (100)`                                                   |
| Script lines waiting to go out            | 10 per network                          | `[Lua error] Not sent: 10 script lines are already waiting to go out`                                |
| One IRC line                              | 500 bytes, no line breaks               | _Not sent: …_ in the network's lobby                                                                 |
| One script's code                         | 16,000 characters                       | The editor stops taking more; an import that long is refused                                         |
| All scripts' code                         | 256,000 characters                      | _Not saved: …_ in the editor                                                                         |
| Scripts                                   | 50                                      | —                                                                                                    |
| `seance.storage`, one script              | 16,000 characters                       | The `set` raises an error and stores nothing                                                         |
| `seance.storage`, all scripts             | 128,000 characters                      | The same                                                                                             |
| Name / folder / description               | 32 / 40 / 120 characters                | The field takes no more                                                                              |

The instruction budget is plenty for answering messages: roughly 50,000
turns of an empty loop, or ten thousand or so that do real work. A
`while true do … end` stops at the limit instead of freezing the page —
even one wrapped in `pcall`.

Memory has no limit of its own. A script that keeps every line it sees in
a table grows for as long as the page is open, and only that tab suffers.

## Sharing scripts

- **Export .lua** in the editor downloads a script; **Import .lua…** in the
  library reads one in, switched off.
- A [settings backup](../../resources/settings-backup.md) carries your
  scripts and their storage. Restoring one brings every script back
  **switched off, and the Enable scripting switch too**, so nothing from a
  file runs until you have looked at it and turned it on here.

**Read a script before you run one someone gave you.** A script sees every
line you see, private messages included, and can send any line as you:
messages, joins and parts, commands to services (`PRIVMSG NickServ …`),
kicks and bans where you are an operator, server commands if you are an IRC
operator. It cannot read your saved password or your other settings. Every
line it sends goes through `seance.send` or `seance.reply`, so those are
the lines to read.

## Pitfalls

1. **Answering yourself.** Your own lines fire `message` (`msg.self` is
   `true`). Check `msg.self` unless you mean to answer your own lines.

2. **Answering notices.** `seance.reply` always sends a `PRIVMSG`; answer
   only `msg.type == "message"`. Bots and services talk in notices
   precisely so that nothing answers them automatically.

3. **`seance.current_channel` in a handler.** It is the conversation you
   are looking at, not where the event happened. Answer with
   `seance.reply(msg, …)`, or send to `msg.target` / `ev.channel` with
   `ev.networkUuid`.

4. **`seance.send` in a handler without the network.** It then goes to the
   network you are looking at, which need not be the one the event came
   from. Pass `ev.networkUuid`.

5. **A handler that does nothing, and no error.** `seance.on` and
   `seance.register_command` silently ignore anything that is not a
   function. Look for a typo in a function's name, or a `local function`
   defined below the line that registers it.

6. **Variables forgotten.** Any edit to any script, flipping a switch, and
   every page load restart every script. Keep what must last in
   `seance.storage`.

7. **Storing something that is not a string.** `seance.storage.set("on", true)` stores an empty string. Convert first, and `tonumber` numbers on
   the way back.

8. **Long or multi-line replies.** Seance does not split what a script
   sends. Keep each line under about 450 bytes of text and send one line
   at a time.

9. **Registering inside a handler.** A `seance.on` inside a handler adds
   another handler every time the event fires, until the limit of 50 is
   reached. Register once, at the top level.

10. **Nothing in the chat from `print`.** Lua's `print` writes to the
    browser's developer console. Use `seance.print`.

11. **Big numbers going negative.** Integers are 32-bit: `86400 * 30000`
    overflows. Use floats for big arithmetic
    ([details](api.md#the-lua-you-get)).

12. **Case.** Nicks and channels are not case-sensitive on IRC, but Lua's
    `==` is. Compare `a:lower() == b:lower()`, and use lower-case keys in
    tables of nicks and channels.
