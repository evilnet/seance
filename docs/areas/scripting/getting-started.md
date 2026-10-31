# Getting started

## Turn scripting on

Open **Settings → Scripts** and switch on **Enable scripting**. The library
appears under the switch.

While the switch is off no script runs, `/lua` says scripting is disabled,
and the Lua interpreter is never downloaded. Your scripts are kept; turning
the switch back on runs the ones that are switched on.

## Your first script

Press **New script**. The editor opens over the settings with an empty
script called `my_script`, already switched on.

1. Give it a name — letters, digits, `_` and `-`, starting with a letter or
   digit, at most 32 characters, different from your other scripts' names
   (case does not count). The name is what the library lists and what an
   export is called.
2. Optionally give it a **folder** (free text; the library groups scripts
   by it, and anything without one goes under _Unsorted_) and a one-line
   **description**.
3. Type the code:

   ```lua
   -- Answers "!hello" with a greeting.
   seance.on("message", function(msg)
       if msg.text == "!hello" and not msg.self then
           seance.reply(msg, "Hello, " .. msg.from .. "!")
       end
   end)
   ```

4. Click outside the code field, or close the editor. The script loads.

Now when someone says `!hello` in a channel you are in, or in a private
message to you, Seance answers on your behalf. The `not msg.self` matters:
your own lines fire `message` too, so without it you would answer yourself.

`seance.on` asks for a function to be called on every `message` event, and
`seance.reply` answers a message where it came from. The
[API reference](api.md) lists every event and what its table holds.

## Your first command

```lua
-- /hello [text] prints a line only you can see.
seance.register_command("hello", function(args, rest)
    seance.print("Hello from Lua! You typed: " .. rest)
end)
```

Type `/hello there` in any conversation. `rest` is everything after the
command name, as you typed it; `args` is the same text split into words
(`args[1]` is `"there"`). The new command shows in the input's
autocompletion. A script cannot replace a built-in command such as `/join`
or `/msg` — built-ins always win — so pick a name that is free.

## When a script runs

A script's top-level code — everything not inside a handler — runs when the
script **loads**. That is:

- when the page loads, if scripting and the script are both switched on;
- when you finish an edit: the code field (or the name, folder or
  description) loses the caret, you flip a switch, or you close the editor;
- when you switch scripting on.

Typing saves as you go ("Changes are saved as you type"), but nothing
reloads until you leave the field, so your top-level code does not run at
every pause in the typing.

**Every load restarts every script from scratch.** All scripts share one
Lua interpreter, and a reload throws it away and runs each switched-on
script again in order. Whatever a script kept in Lua variables — counters,
tables of who said what — is gone after any edit to any script, and after a
page reload. Keep what must survive in [`seance.storage`](api.md#storage).

After loading, a script's handlers run as their events happen, and its
commands run when you type them.

## The editor

The editor holds the script's name, folder, description and a **Run this
script** switch, the code, and four buttons:

- **Check syntax** compiles the code without running it and says _Syntax
  OK_ or shows the error.
- **Duplicate** makes a copy (switched off, with its own empty storage) and
  opens it.
- **Export .lua** downloads the code as `<name>.lua`.
- **Delete** asks first, then removes the script and its storage.

The code field highlights Lua in your theme's colours, numbers the lines
and matches brackets. **Tab** indents (four spaces, or the selected lines);
**Shift+Tab** moves on out of the field. Under the code are the line and
character counts — a script can be at most 16,000 characters — and a
folded **Lua API reference**.

**Done**, **✕**, **Escape** or a click outside close the editor back to the
library.

## The library

The Scripts tab lists every script by folder, then by name, each with its
state — **Running**, **Off** or **Error** — and an on/off switch. Click a
script to open it. Once you have more than six, a search box appears that
looks through names, folders, descriptions and code.

- **New script** starts an empty one.
- **Import .lua…** reads a `.lua` file into a new script named after the
  file (`My Bot.lua` becomes `my_bot`). An imported script arrives switched
  off: read it, then switch it on.
- **Or try an example** adds one of two starters, an auto-responder
  (`!ping` → `pong!`) under _Automation_ and a `/slap` command under
  _Commands_.

## Trying code with `/lua`

`/lua` runs a snippet in the conversation you type it in. It is the
quickest way to try an idea, or to look something up:

```
/lua return 2 + 2
/lua return seance.nick, seance.current_network
/lua for i = 1, 3 do seance.print("line " .. i) end
```

What a snippet returns is shown as a block (several values side by side; a
table or function as `[lua table]` or `[lua function]`); a snippet that
returns nothing says _Lua execution completed._

Snippets share their globals with each other, so `/lua x = 41` then
`/lua return x + 1` gives `42` — until the next reload. They do not see
your scripts' variables, and their `seance.storage` is one bucket shared by
all snippets. `/lua` works without any script switched on, as long as
scripting is.

## When something goes wrong

Errors name the line they happened on. In

```
[string "-- Answers "!hello"..."]:3: attempt to index a nil value (local 'x')
```

the part in quotes is the start of the script and `3` is the line number.

- **An error while the script loads** — a syntax error, or one in the
  top-level code — is kept with the script: the library shows **Error** and
  the editor a red _Error:_ banner. Whatever the script set up before the
  error (handlers, commands) stays set up until the next reload.
- **An error in a handler or a command** is printed as a `[Lua error] …`
  line — where you typed, for a command; otherwise in the conversation you
  have open — and kept with the script the same way. The script keeps
  running, and its other handlers still fire.
- The **Error** state stays until the script next loads without one: fix
  the code and leave the field, or switch the script off and on.
- **A line the server could not be sent** (too long, or with a line break
  in it) is reported in that network's lobby as _Not sent: …_.
- **A line sent while the network is not connected is dropped silently**
  — only the browser's developer console mentions it.

Lua's own `print` writes to the browser's developer console, not to the
chat. Use `seance.print` to see something in Seance.
