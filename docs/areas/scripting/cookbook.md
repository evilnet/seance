# Cookbook

Complete scripts: paste one into a new script, change the names and
channels to yours, and leave the field. Each stands alone — scripts cannot
share code, so a helper two of them need is copied into both.

- [A clock from the server](#a-clock-from-the-server)
- [!ping, at most once a minute](#ping-at-most-once-a-minute)
- [A quiet word watch](#a-quiet-word-watch)
- [/shrug](#shrug)
- [/note: notes that survive a reload](#note-notes-that-survive-a-reload)
- [Karma](#karma)
- [Voice your friends](#voice-your-friends)
- [Rejoin when kicked](#rejoin-when-kicked)
- [Greet newcomers on one network](#greet-newcomers-on-one-network)
- [/seen](#seen)
- [Who changed what: reading modes](#who-changed-what-reading-modes)

## A clock from the server

Scripts have no clock, but every message from a server with `server-time`
(nefarious2 has it) carries the time it was sent in `msg.tags.time`. This
helper turns that into Unix seconds, so you can measure gaps between
messages:

```lua
-- Seconds since 1970 from an IRCv3 server-time tag
-- ("2026-10-30T14:05:09.123Z"), or nil when there is none. The result is
-- a float: Seance's integers are 32-bit and would overflow in 2038.
local function epoch(stamp)
    local y, mo, d, h, mi, s =
        (stamp or ""):match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)")
    if not y then
        return nil
    end
    y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
    -- Days since 1970-01-01 (Howard Hinnant's days_from_civil).
    if mo <= 2 then
        y = y - 1
    end
    local era = y // 400
    local yoe = y - era * 400
    local doy = (153 * ((mo + 9) % 12) + 2) // 5 + d - 1
    local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    local days = era * 146097 + doe - 719468
    return days * 86400.0 + tonumber(h) * 3600 + tonumber(mi) * 60 + tonumber(s)
end
```

## !ping, at most once a minute

The starter auto-responder answers every `!ping`; in a busy channel that is
a way to get kicked. This one answers each channel at most once a minute.
It needs `epoch` from above, pasted above it.

```lua
-- Answers !ping with pong, once a minute per channel at most.
-- (paste epoch() from "A clock from the server" here)

local last = {}

seance.on("message", function(msg)
    if msg.self or msg.type ~= "message" or msg.text ~= "!ping" then
        return
    end

    local now = epoch(msg.tags.time)
    local where = msg.networkUuid .. " " .. msg.target:lower()

    if now and last[where] and now - last[where] < 60 then
        return
    end

    last[where] = now
    seance.reply(msg, "pong")
end)
```

`last` lives in a Lua variable, so a reload forgets it — fine for a
cooldown.

## A quiet word watch

Lines that mention one of your words show up in whatever conversation you
are looking at, without a notification. (For real highlights, with
notifications, use the highlight words in Settings.)

```lua
-- Shows lines mentioning these words wherever you are.
local words = {"seance", "nefarious", "lua"}

seance.on("message", function(msg)
    if msg.self then
        return
    end

    local text = msg.text:lower()

    for _, word in ipairs(words) do
        if text:find(word, 1, true) then
            seance.print(("[%s %s] <%s> %s"):format(msg.network, msg.target, msg.from, msg.text))
            return
        end
    end
end)
```

`text:find(word, 1, true)` searches for the word as plain text; without the
`true`, characters such as `.` and `-` in your words would be Lua pattern
syntax.

## /shrug

```lua
-- /shrug [text] says the text followed by ¯\_(ツ)_/¯ where you typed it.
seance.register_command("shrug", function(args, rest)
    local where = seance.current_channel

    if where == seance.current_network then
        seance.print("/shrug works in a channel or a private conversation.")
        return
    end

    local text = rest ~= "" and (rest .. " ") or ""
    seance.send("PRIVMSG " .. where .. " :" .. text .. "¯\\_(ツ)_/¯")
end)
```

In a network's lobby `seance.current_channel` is the network's name, which
is what the first check is for. The backslash is doubled because `\` starts
an escape in a Lua string.

## /note: notes that survive a reload

```lua
-- /note add <text> · /note list · /note clear
-- Kept on this device, across reloads.

local function load_notes()
    local notes = {}
    for line in (seance.storage.get("notes") or ""):gmatch("[^\n]+") do
        notes[#notes + 1] = line
    end
    return notes
end

seance.register_command("note", function(args, rest)
    local sub = (args[1] or ""):lower()
    local notes = load_notes()

    if sub == "add" then
        local text = rest:match("^%S+%s+(.+)$")
        if not text then
            seance.print("Usage: /note add <text>")
            return
        end
        notes[#notes + 1] = text
        seance.storage.set("notes", table.concat(notes, "\n"))
        seance.print("Noted (" .. #notes .. " in all).")
    elseif sub == "list" then
        if #notes == 0 then
            seance.print("No notes.")
        end
        for i, note in ipairs(notes) do
            seance.print(i .. ". " .. note)
        end
    elseif sub == "clear" then
        seance.storage.set("notes", nil)
        seance.print("Notes cleared.")
    else
        seance.print("Usage: /note add <text> | /note list | /note clear")
    end
end)
```

Storage holds strings only, so the list is kept as one string with a line
per note. `rest:match("^%S+%s+(.+)$")` takes everything after the first
word, spaces and all — `args` would have split the note into words.

## Karma

`alice++` and `alice--` in any channel move alice's score; `!karma alice`
tells it. Your own votes count; voting for yourself does not.

```lua
-- nick++ / nick-- keep a score per network; "!karma nick" tells it.

local function key(msg, nick)
    return msg.network:lower() .. ":" .. nick:lower()
end

seance.on("message", function(msg)
    if msg.type ~= "message" then
        return
    end

    local up = msg.text:match("^(%S+)%+%+$")
    local down = msg.text:match("^(%S+)%-%-$")
    local nick = up or down

    if nick then
        if nick:lower() == msg.from:lower() then
            return
        end
        local k = key(msg, nick)
        local score = (tonumber(seance.storage.get(k)) or 0) + (up and 1 or -1)
        seance.storage.set(k, tostring(score))
        return
    end

    local asked = msg.text:match("^!karma%s+(%S+)$")

    if asked then
        local score = tonumber(seance.storage.get(key(msg, asked))) or 0
        seance.reply(msg, asked .. " has " .. score .. " karma.")
    end
end)
```

There is no `msg.self` check here, on purpose: your `alice++` should count,
and your `!karma alice` should be answered. The answer itself cannot set
off another one — the echo of a script's own line never fires `message`.

Each nick is a key in storage, and one script's storage holds 16,000
characters — a few hundred nicks. When it is full, the next vote is an
error (`seance.storage is over 16,000 characters for this script`) and
nothing is lost.

If you run Seance on two devices, or in two tabs, with this script on in
both, every vote counts twice and `!karma` is answered twice. Keep it on
in one place.

## Voice your friends

Gives voice (`+v`) to these accounts when they join your channel. You need
channel operator status there, and the server must report accounts on join
(`extended-join`; nefarious2 does).

```lua
-- Voices these accounts when they join #mychannel.
local channel = "#mychannel"
local friends = {alice = true, bob = true} -- account names, lower case

seance.on("join", function(ev)
    if ev.self or ev.channel:lower() ~= channel then
        return
    end

    if ev.account and friends[ev.account:lower()] then
        seance.send("MODE " .. ev.channel .. " +v " .. ev.nick, ev.networkUuid)
    end
end)
```

Matching on the account, not the nick, means nobody gets voice by taking a
friend's nick. Passing `ev.networkUuid` sends the `MODE` on the network the
join happened on, whatever you are looking at.

## Rejoin when kicked

```lua
-- Rejoins a channel you were kicked from, and says who did it.
seance.on("kick", function(ev)
    if ev.self then
        seance.print("Kicked from " .. ev.channel .. " by " .. ev.nick
            .. " (" .. (ev.reason or "no reason") .. "); rejoining.")
        seance.send("JOIN " .. ev.channel, ev.networkUuid)
    end
end)
```

A channel with a key needs it on the end of the `JOIN`. Rejoining right
after a kick is often read as rude, and a ban stops it anyway.

## Greet newcomers on one network

```lua
-- Welcomes each newcomer to #help on AfterNET with a notice, once per load.
local greeted = {}

seance.on("join", function(ev)
    if ev.self or ev.network ~= "AfterNET" or ev.channel:lower() ~= "#help" then
        return
    end

    local who = ev.nick:lower()

    if greeted[who] then
        return
    end

    greeted[who] = true
    seance.send("NOTICE " .. ev.nick
        .. " :Welcome to #help! Ask your question and give people a while to answer.",
        ev.networkUuid)
end)
```

`ev.network` is the name the server announces, which can differ from the
address you connect to; check it with `/lua return seance.current_network`
while that network is open. A notice is the polite way to greet: clients do not
answer notices automatically.

## /seen

Remembers what each person last did while this page has been open.

```lua
-- /seen <nick>: the last thing this page saw them do (forgotten on reload).
local seen = {}

local function note(network, nick, what)
    seen[network:lower() .. " " .. nick:lower()] = what
end

seance.on("message", function(msg)
    note(msg.network, msg.from, ("saying \"%s\" in %s"):format(msg.text, msg.target))
end)

seance.on("join", function(ev)
    note(ev.network, ev.nick, "joining " .. ev.channel)
end)

seance.on("part", function(ev)
    note(ev.network, ev.nick, "leaving " .. ev.channel)
end)

seance.on("quit", function(ev)
    note(ev.network, ev.nick, "quitting (" .. (ev.message or "no message") .. ")")
end)

seance.on("nick", function(ev)
    note(ev.network, ev.oldNick, "becoming " .. ev.newNick)
end)

seance.register_command("seen", function(args)
    local nick = args[1]

    if not nick then
        seance.print("Usage: /seen <nick>")
        return
    end

    local what = seen[seance.current_network:lower() .. " " .. nick:lower()]
    seance.print(nick .. ": " .. (what or "not seen since this page loaded"))
end)
```

This keeps everything in a Lua table, so a reload (any edit to any script)
empties it. Keeping it in `seance.storage` instead would survive reloads
but fill the 16,000 characters within a busy day.

## Who changed what: reading modes

A `mode` event carries the whole change (`"+ov-b"`) and its parameters in
one list. This walks the letters and pairs each with its parameter. Which
letters take one is up to the server; the table below covers the common
ones (operator, voice, half-op, ban, key, limit), and a server may have
more.

```lua
-- Prints each channel mode change as its own line.
local takes_param = {o = true, v = true, h = true, b = true, k = true, l = "set"}

seance.on("mode", function(ev)
    if not ev.target:match("^[#&]") then
        return -- your own user modes
    end

    local adding, i = true, 1

    for letter in ev.mode:gmatch(".") do
        if letter == "+" then
            adding = true
        elseif letter == "-" then
            adding = false
        else
            local param = ""
            local takes = takes_param[letter]
            if takes == true or (takes == "set" and adding) then
                param = " " .. (ev.params[i] or "?")
                i = i + 1
            end
            seance.print(("%s %s%s%s on %s"):format(
                ev.from, adding and "+" or "-", letter, param, ev.target))
        end
    end
end)
```

`l` (the user limit) takes a number when it is set and nothing when it is
removed, hence `"set"`.
