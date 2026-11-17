# One conversation store for channels and private chats

Design review for rubin, 2026-11-15. Read-only study of the worktree
`seance_locke_bugs` (line numbers are that tree as it stands today, another
session's staged changes included), PR #220, issue #219 and nefarious2
`ircv3.2-upgrade` at d7331801.

## Status: built (2026-11-16)

Phases 1 and 2 and the first half of phase 3 are in the code
(`client/js/irc/conversationStore.ts`; tests `test/irc/conversationStore.ts`,
`test/irc/attach-cursor.ts`; browser check
`tools/scenarios/conversation-store.mjs`). The rest of this document is the
design as it was reviewed, on the `seance_locke_bugs` tree: its line numbers
are that tree's, and where the code went another way it is listed here.

Built:

- One IndexedDB store, `seance-conversations`, one record per line, for
  channels and private chats alike; `querylog.ts` is gone and its
  localStorage log is moved in at the first boot.
- A page load restores every window before any connection and is then a
  reconnect: the JOIN is quiet and starts the catch-up walk, the cursor's
  replay is deduplicated against the kept lines.
- The gap marker (`SharedMsg.gapBefore`, `msg:gap`, `history:fill`), kept
  with the line, with a control that loads the missing lines into place.
- The replay hardening of 4.1, the one setting, Clear history's `clearedAt`,
  deletion by msgid whether or not the line is loaded, ZNC seeding for
  channels.
- "Show older" reads the device first, also without a connection (4.4).

Where the code differs from the text below:

| Design                                                                        | Built                                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lineKey` is the primary key (2.1)                                            | The key is `[conversation, time, lineKey]`; an index finds a line by msgid                                                                                                                                                                                           | Newest lines, a page of older ones and a trim are then plain key ranges; with msgids first they would be index cursors.                                                                                                          |
| A second write of a line replaces the first (2.2)                             | A line is added only when absent                                                                                                                                                                                                                                     | A late copy from another tab (a history page) would undo an edit or a reaction the first tab applied.                                                                                                                            |
| A channel the device has lines for is shown parted and never joined (2.5)     | Under a held session or a bouncer, as designed: the server says what we are in, and a channel only the device remembers stays parted. Where nothing holds our channels, one we were in is joined again with its key (`ConvRecord.joined`), until a refusal or a kick | The saved join list is a holdover from before bouncers and is not extended; without a bouncer a reload would otherwise drop every channel joined by hand (A12), which a live reconnect does not.                                 |
| Closing a window deletes its lines and record (2.8)                           | A closed window, channel or private chat, is remembered (`ConvRecord.closed`): hidden, never opened by itself, and its lines are there, read, when it is opened again                                                                                                | rubin, 2026-11-16: closed means hidden and not reopened, not forgotten.                                                                                                                                                          |
| No tombstones for deleted lines (2.10)                                        | A deleted msgid is remembered for a week (`ConvRecord.dead`)                                                                                                                                                                                                         | #326 review: with add-only writes and the unload journal, a late copy brought a deleted line back.                                                                                                                               |
| The snapshot is read once (2.3)                                               | A network's share goes to its first store and is read again when that store goes away; a store without one is `blind` and marks the gap above its first page                                                                                                         | #326 review: a client made again after `/quit` started from page-load state, and a slow boot read left a silent hole.                                                                                                            |
| A cut leg starts a walk from its oldest line (4.1.1)                          | The leg's oldest new line gets the gap marker, and one page of its fill is queued in the background; the rest waits for the control                                                                                                                                  | One mechanism, and five pages per busy channel on every reload after a long absence was about 10 s of fake lag each (#326 review).                                                                                               |
| `CURSOR_UNKNOWN` (4.1.3)                                                      | The channels whose JOIN was left to the replay walk after all (`IrcClient.catchUpUncovered`)                                                                                                                                                                         | The FAIL arrives after the restored JOINs, so "not covered" has to be applied after the fact. nefarious2 sends it only for a msgid it cannot parse or a store that is down; a msgid that aged out is read as its time, silently. |
| The cursor: the older of the saved one and the newest stored line (section 3) | As written                                                                                                                                                                                                                                                           |                                                                                                                                                                                                                                  |
| `filled` after a walk that stopped short                                      | True once the marker is placed                                                                                                                                                                                                                                       | The window is complete down to the marker, which is what the replay needs to know.                                                                                                                                               |
| A page from the device must end at a flagged line (4.4)                       | It does not: the divider is drawn inside the page                                                                                                                                                                                                                    | The flag travels with its line.                                                                                                                                                                                                  |
| Restore 100 lines per window                                                  | As written; "show older" then reads the rest from the device                                                                                                                                                                                                         | Phase 1 alone would have shown fewer private lines than the old log (200).                                                                                                                                                       |
| BUG-051 "already fixed"                                                       | Fixed here: `history:clear` reaches the IRC layer (`IrcClient.clearHistory`), with the same names the `seance_locke_bugs` fix uses                                                                                                                                   | That fix is not on develop.                                                                                                                                                                                                      |

Not built, in the order I would take them:

1. Private chats in the catch-up through the private rows of
   `CHATHISTORY TARGETS` (2.6). Without the replay, a private chat still
   only gets what arrives live.
2. Lobby notices in the store (`noticelog.ts`, phase 4).
3. `navigator.storage.persist()`, retention-aware gaps
   (`evilnet/CHATHISTORYRETENTION`), `historyDenied` kept for a day,
   eviction under storage pressure (a failed write is dropped and the
   server's history brings back what it has).
4. Walk depth by absence (2.3): the walk is five pages, as on a reconnect.
5. The boot read's cost on a slow phone is not measured; it gives up after
   1 s and the page then marks gaps instead of trusting what it shows. A size
   budget: a full disk is handled when it happens (deletions land by
   themselves, the oldest half of every long conversation goes).

## Verdict in short

- rubin is right that one mechanism should keep and restore every window.
  Storage, the write path, restore, merge with the server, caps, Clear
  history, the setting and deletion handling have no reason to differ. Almost
  every difference in the code today is an accident of when each piece was
  built.
- IRC forces three differences, and they are small seams, not separate
  mechanisms: how a window is known to exist (a channel has membership the
  server knows, a private chat has nothing), how a closed private chat stays
  closed (tombstones), and what starts the catch-up (a JOIN echo for a
  channel, registration for a private chat).
- "Make a reload behave like a reconnect" is the right restore path. It needs
  two things with it or it makes things worse than today: a visible, fillable
  **gap marker** where the merge could not prove the lines join up, and three
  small hardenings of the server-driven replay. With them, a reload on
  AfterNET for a logged-in user costs zero per-channel commands.
- #219 is right that a display cache is safe and that `closedQueries.ts`
  should stay as it is. It is wrong that `querylog.ts` cannot be folded in,
  and its strongest technical objection (the walk can stop on a hole) was
  fixed in develop three days after it was written.
- No nefarious2 change is required.
- Do not patch BUG-120 in `querylog.ts`. The fix it proposes is the write
  path of the new store; build it there once.

Terms used below, once:

- **Query**: a private conversation window (TheLounge's word, still the
  code's: `ChanType.QUERY`).
- **msgid**: the server's unique id for a line (`@msgid=` tag).
- **Fake lag**: nefarious2 charges each command about 2 s and stops reading
  a client that is 10 s ahead, so every command on the connect path is
  expensive.
- **Catch-up walk**: after a reconnect, `CHATHISTORY LATEST`, then `BEFORE`
  pages going back until a page meets what the window already holds
  (`history.ts` `resolve`, append mode).
- **Held set**: the msgids a window held when our JOIN came back; the walk
  stops when a page contains one of them. **Floor**: the time of the newest
  server-stamped line held then; the walk also stops below it.
- **Cursor**: the newest msgid shown anywhere on a network, saved with the
  network. Offered to nefarious2 as `PERSISTENCE ATTACH default <msgid>`;
  the server then replays everything since it by itself (the **replay**),
  one batch per channel or private chat (a **leg**).
- **Tombstone**: a small record that a private chat was closed and when
  (`closedQueries.ts`).

---

## 1. Today, holistically

### 1.1 Where conversation state lives

```
 DEVICE                                         SERVER (nefarious2)
 ------                                         -------------------
 localStorage                                   history store (LMDB)
   thelounge.querylog.<uuid>   PM lines+read     channels: 7 days (RETENTION)
   thelounge.networks          join list,        PMs: by account pair, if
                               cursor            CHATHISTORY_PRIVATE and
   thelounge.state.closedQueries  tombstones     neither side opted out
   thelounge.state.lastChannel    last window   read markers (per account)
   thelounge.mentions             the inbox     bouncer session: channels
   thelounge.sort.channels        order          joined, last active
 IndexedDB                                      metadata: seance/closed
   seance-notices   lobby notices (24 h)         (tombstones, 300 bytes)
   seance-push      push stash, seen ring       msgid index (resolves the
   (#220: seance-history, 50 lines/channel)      cursor)
 memory only
   Channel.msgRefs / idByMsgid   what the UI shows (100 lines for a window
   Vuex store messages           not on screen, 1500 for the open one)
```

Device, piece by piece:

| What                      | Where                                       | Shape and write                                                                                 | Notes                                                                               |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Private lines, read point | `querylog.ts`, localStorage                 | one JSON blob per network; read once (`:484-490`), written whole on a 1 s throttle (`:524-560`) | 200 lines, 30 chats, 300k chars (`:35-39`); messages, actions, notices only (`:43`) |
| Channel lines             | nowhere                                     |                                                                                                 | A reload starts every channel empty                                                 |
| Channel lines (#220)      | `historycache.ts`, IndexedDB                | one record per channel, merged in a transaction                                                 | 50 lines, 7 days, msgid only, opt-in, thrown away by the first page                 |
| Lobby notices             | `noticelog.ts`, IndexedDB                   | one array per network, loaded once, written whole (`:227-234`)                                  | Same two-tab overwrite as BUG-120, nobody has reported it                           |
| Which channels exist      | saved network `join` list (`client.ts:757`) | edited in the network form                                                                      | A channel joined by hand is not added, as far as I can find                         |
| Which private chats exist | `queryLog.names()` (`client.ts:773-787`)    | the log's keys                                                                                  |                                                                                     |
| Closed private chats      | `closedQueries.ts`, localStorage + metadata | read fresh on every use; other tabs hear the `storage` event (`manager.ts:504-508`)             | Synced across devices                                                               |
| Cursor                    | saved network (`saved-networks.ts:764-772`) | read-modify-write of the whole networks list                                                    |                                                                                     |
| Inbox (mentions)          | `mentions.ts`, localStorage                 | separate, user-curated                                                                          | Stays out of this design                                                            |

Server, what matters here:

- Channel history is kept `CHATHISTORY_RETENTION` days (default 7,
  `ircd_features.c:1384`) and advertised as ISUPPORT
  `evilnet/CHATHISTORYRETENTION` in seconds (`m_chathistory.c:4324-4341`).
  The client does not read that token today.
- Private history is stored under the pair of the two parties' identities
  (account, or session id for a guest), not their nicks
  (`ircd_relay.c:412-420`). Two guests under `CHATHISTORY_REQUIRE_AUTH` get
  nothing stored at all (`ircd_relay.c:391-394`); either side can opt out.
  So for a guest on AfterNET the device copy is the only copy.
- `CHATHISTORY TARGETS` lists private chats too, named after the other
  party's nick (`m_chathistory.c:2961-2978`, `:3170-3183`). The client asks
  it only to order channels and ignores the private rows
  (`catchup.ts:704-728`, `:663-699`).
- The replay sends at most `BOUNCER_AUTO_REPLAY_LIMIT` (100) lines per leg,
  the newest ones, and says a leg was cut only by leaving out
  `draft/chathistory-end` (`replay.c:680-720`). It has private legs too
  (`replay.c:736-786`). An unknown cursor falls back to the session's last
  activity and says `FAIL PERSISTENCE CURSOR_UNKNOWN` (`replay.c:1218-1232`,
  `bouncer_session.c:13896`).

### 1.2 A reload today

```
 channel                                   private chat
 -------                                   ------------
 window: from the saved join list,         window: from the query log,
         or the server's session restore           synchronously
 lines:  none                              lines:  up to 200 from the log,
                                                   remembered by msgid
 JOIN echo -> CHATHISTORY LATEST 50,       no JOIN, so no fetch at all;
   one channel per ~2 s, prepended         only the replay (if the cursor
 replay (if ATTACH) appended               was taken) adds lines
 "show older" offered                      "show older" not offered
                                           (client.ts:4191)
```

A reconnect on a live page is different again, and better: the window still
holds its lines, so the JOIN echo starts the catch-up walk
(`history.ts:322-331`), pages are deduplicated by msgid and placed by server
time among the rows (`placeByTime`, `:605-697`), or the replay covers the gap
with no per-channel command (`persistence.ts:386-397`).

### 1.3 Where channels and private chats diverge

Inherent to IRC (the design must keep a seam for each):

| #   | Difference                                                                                                                                 | Why it is inherent                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | A channel's window is known from membership (join list, session restore, a bouncer's JOINs). A private chat's is known only to the device. | IRC has no "my open private chats". TARGETS lists chats with stored history, not open windows.                                            |
| I2  | A closed private chat needs a tombstone; a parted channel does not.                                                                        | Nothing on the server says "closed"; the next replay would reopen it.                                                                     |
| I3  | A channel's catch-up starts at its JOIN echo; a private chat has no such event.                                                            | No JOIN for a nick.                                                                                                                       |
| I4  | A private chat is keyed by a nick that can change or be reused; the server keys its history by account pair.                               | Nicks are not identities. The window is not renamed on NICK today (`handlers/nick.ts` renames users in channels only); out of scope here. |
| I5  | The device copy is more often the only copy for a private chat (guests, opt-out, `+Y`).                                                    | Server policy (`ircd_relay.c:386-443`).                                                                                                   |
| I6  | The server volunteers a channel's read marker after JOIN; a private chat's must be asked for (`catchup.ts:275-289`).                       | Protocol.                                                                                                                                 |

Accidental (all go away with one store):

| #   | Difference                                                                                                                              | Where                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A1  | Private lines kept, channel lines not (or in a second store, #220)                                                                      | `client.ts:4339-4342`, `history.ts:534-536` |
| A2  | Restored private lines count as held (dedupe, read point). #220's channel lines are "never evidence" and are replaced by the first page | `client.ts:4148-4202`; #220 `dropCached`    |
| A3  | Channels get a catch-up after connect; private chats only through the replay                                                            | `client.ts:3746-3754`, `catchup.ts:551-567` |
| A4  | "Show older" is switched off in a restored private chat                                                                                 | `client.ts:4187-4192`                       |
| A5  | Read point kept across a reload for private chats only                                                                                  | `markread.ts:73-75`                         |
| A6  | Edits, deletions and reactions follow into the log for private chats only, and only for a line still loaded                             | `client.ts:3828-3853`, `redact.ts:46`       |
| A7  | Clear history forgets a private chat's log; for a channel it empties the screen until the next reload                                   | `client.ts:4250-4259`                       |
| A8  | Caps: 200 lines / 30 chats / 300k chars versus nothing (50 lines / 7 days in #220)                                                      | `querylog.ts:35-39`                         |
| A9  | Kinds kept: messages, actions, notices versus everything a channel shows                                                                | `querylog.ts:43`                            |
| A10 | Two settings: `keepPrivateConversations` (on) and #220's `keepChannelHistory` (off)                                                     | `settings.ts:394-406`                       |
| A11 | ZNC's buffer replay is deduplicated against restored private lines only                                                                 | `history.ts:1015-1018`                      |
| A12 | A channel joined by hand on a connection without a held session is forgotten by a reload; a private chat is not                         | `client.ts:757-760` vs `:773-787`           |

---

## 2. Recommended design

One module, `client/js/irc/conversationStore.ts`, backed by IndexedDB, holding
every window's lines. The `IrcClient` model and the Vuex store keep working
as they do; the store sits under them.

```
        server lines (live, history page, replay)
                      |
                handlers -> IrcClient.pushMessage / deliverPrepend
                      |                         |
          Channel model (msgRefs,          ConversationStore
          idByMsgid: what is shown)        (IndexedDB: what is kept)
                      |                         ^
                  Vuex store  ---- "more" ------+   older pages, phase 3
```

### 2.1 Storage shape

One database, `seance-conversations`, two object stores.

```
 conversations   key [uuid, folded target]
   { name, kind: "channel"|"query", open, touched, read,
     filled, clearedAt?, v }

 lines           key [uuid, folded target, lineKey]
                 index byTime on [uuid, folded target, time]
                 index byAlias on the msgids of edits folded into a line
   { key, msgid?, aka?, time, gapBefore?, msg }
```

- **One record per line**, not one blob per conversation. This is the
  decision everything else rests on: an append writes one small record, a
  page of older lines is a range read, trimming is a range delete, and two
  writers of the same line produce the same record.
- `lineKey` is the msgid when the line has one. Without one it is a
  best-effort identity: time in ms, folded nick, kind, text, plus a counter
  for equal lines in the same ms. That is exactly what `history.ts:957-959`
  already builds for ZNC.
- `msg` is the message as it was handed to the UI, minus its numeric id,
  link previews and pending state. IndexedDB stores objects as they are
  (dates stay dates), so the hand-kept field list in `toLogged`/`fromLogged`
  (`querylog.ts:145-237`) goes.
- Kept: every kind of line the server sent that a window shows (messages,
  actions, notices, and joins, parts, quits, kicks, modes, topics, nick
  changes). Not kept: pending copies and the client's own status or error
  text. Keeping events is what "as it was last" means, and it avoids the
  problem #220 hit in its second commit (events inside a stored span).
- `conversations` is the index: it answers "which windows existed" without
  reading a line. `filled` says the device held everything up to the
  conversation's newest line when it was last written (the persisted form of
  `Channel.historyFilled`, `channel.ts:202`). `clearedAt` is explained under
  Clear history.
- `gapBefore` on a line means: the device does not know that it holds
  everything between this line and the stored line before it (2.4).

### 2.2 One write path two copies cannot clobber

The rule: **a tab only ever writes what it changed, one line at a time,
inside an IndexedDB transaction.** Nobody writes a conversation whole, so
there is nothing to overwrite.

Each change is queued as a small piece of data and flushed together:

```
 put(target, line)                    a line arrived (live, page or replay)
 patch(target, key, edit|reaction)    read the record, change it, write it
 remove(target, key)                  REDACT
 meta(target, {read, touched, ...})   merged: read and touched take the max
 clear(target) / forget(target)       Clear history / window closed
```

```
 tab A                    IndexedDB                    tab B
 -----                    ---------                    -----
 carol: "around?"                                      bob: "hi" (read it)
 put(carol, L1) --tx--> + carol/L1
                          bob/L7           <--tx--  put(bob, L7)
                          bob.read = max   <--tx--  meta(bob, read)
 both tabs got dave's line:
 put(dave, L9)  --tx-->   dave/L9          <--tx--  put(dave, L9)   same key,
                                                                    one record
```

Why this is enough:

- IndexedDB runs read-write transactions on the same stores one after
  another, across tabs and the installed app. A read-modify-write inside
  one transaction (a reaction, the read point) cannot lose an update.
- A line both tabs receive has the same key, so the second write replaces
  the first with the same content. This is the msgid-less duplicate the
  BUG-120 brief worried about, solved by the key.
- A tab never rewrites old lines, so a line another tab deleted, cleared or
  closed does not come back. `patch` on a missing record does nothing.
- Deleting a network, switching the setting off or clearing a conversation
  while another tab has writes queued: each network has an `epoch` number
  that those actions bump; a flush whose epoch is stale drops its queue. A
  `put` older than the conversation's `clearedAt` is dropped inside the
  transaction.

Flush timing: coalesce for about 250 ms, not 1 s, and flush on
`visibilitychange` to hidden as today (`manager.ts:509-513`). IndexedDB
writes are asynchronous, so unlike localStorage a page killed outright can
lose its last quarter second. On a server with history the next catch-up
brings those lines back (its floor is the newest line that did reach the
store). On a server without, they are lost. That is a real, small step back
from the synchronous flush and is named in section 4.

Other tabs' open windows do not update live from the store (the BUG-120
brief reached the same conclusion: each tab has its own connection and gets
the lines itself). Closing a private chat keeps its existing cross-tab path.

### 2.3 One restore path: a reload is a reconnect

At boot, before any client exists, the store is opened and each autoconnect
network's snapshot is read: the conversation index and the newest ~100
lines of every open conversation (100 is what the UI itself keeps for a
window that is not on screen, `socket-events/msg.ts:151`). `boot()` already
awaits a fetch and the router before `autoconnectSavedNetworks()`
(`boot.ts:81`, `:223`, `:288`), so the read runs beside them and adds no
visible delay. The client's constructor then takes the snapshot
synchronously, the way it takes `queryLog.names()` today, so the client
stays testable under mocha with a plain object.

For every conversation in the snapshot, channel or private, the client does
what `restoreQueryLines` (`client.ts:4148-4202`) does today for a private
chat, plus what a live page would have in memory:

```
 lines        -> remembered by msgid (dedupe), handed to the UI as one page
 read point   -> chan.readMarker; unread counted against it
 newestRef    -> the newest restored line
 historyRequested = true, historyFilled = stored `filled`
 a channel that was joined: rejoining = true (its JOIN echo is state, not
                            a "you joined" line; handlers/join.ts:88)
```

From there the existing reconnect code does the rest, unchanged in shape:

```
 reload, logged in on AfterNET (15 channels)

 today                                   proposed
 -----                                   --------
 t=0   channels empty,                   t=0   every window shows its last
       private chats show their log            ~100 lines from the device
 t~2s  registered; replay since the      t~2s  registered; replay since the
       cursor appended                         cursor appended behind them,
 t~2..32s  15 x CHATHISTORY LATEST 50,         deduplicated by msgid
       one per ~2 s; each channel        no per-channel command
       fills when its turn comes         (serverReplayCovers is true)

 reload, guest or another ircd with chathistory

 t=0   as above                          t=0   as above
 JOIN echo -> LATEST 50, prepended       JOIN echo -> the catch-up walk:
                                           LATEST 100, BEFORE pages back to
                                           the held set, placed by time
 no history (guest on AfterNET):         device lines are the history; live
   channels stay empty                   lines append
```

A conversation with nothing on the device (first visit, setting off, an
unsaved network) has no `before` reference and takes the fresh path of
today, `LATEST 50` prepended (`history.ts:334-338`). Both paths stay; none
is thrown away.

Critical look at the idea, since rubin asked for one:

- **It is the right shape** because the reconnect path already does what
  rubin's requirement says: match by msgid, insert by server time, keep what
  is older (`history.ts:757-877`, `placeByTime`). Since #279, #281, #282 and
  #293 it is also well tested. Restoring into the model before the JOIN echo
  is all it takes to reach it.
- **It moves the reload onto the path's weak spots.** A fresh load can never
  have a hole today, because it holds nothing older than the page it
  fetched. A reconnect can: the walk stops after 5 pages (`history.ts:69`,
  `:819`) and appends what it has under the old lines, with nothing on
  screen to say lines are missing, and no way to fetch them (scrolling up
  asks for lines before the oldest shown, which is above the hole). That is
  a defect of the reconnect path today. A reload after a night away in a
  busy channel would now hit it every time. Hence 2.4.
- **It leans on the replay more.** Today a reload holds nothing, so every
  channel fetches for itself even when the replay ran. After this, the
  replay is the only catch-up for a logged-in user, so its three blind spots
  matter (section 4.1).
- **Depth should follow the absence.** Five pages per channel is 10 s of
  fake lag each. When the newest device line is older than some threshold
  (a day, or the advertised retention), walk one page only and leave a gap
  marker: cheaper than today's reconnect, and the user fills what they care
  about.

### 2.4 Merging, and saying where it could not

```
 device lines            server page(s)              result
 ------------            --------------              ------
 m1 m2 m3 m4             m3 m4 m5 m6                 m1 m2 m3 m4 m5 m6
                         (m3, m4 known: dropped;     joined: walk reached
                          m5, m6 appended)           the held set

 m1 m2 m3 m4             m4' m5 m6                   m1 m2 m3 m4 m4' m5 m6
                         (m4' missed between         m4' placed by time
                          held lines)

 m1 m2 m3 m4             m40 ... m90                 m1 m2 m3 m4
                         (5 pages, never reached     ---- gap ----
                          m4)                        m40 ... m90

 m1 m2 (10 days old)     m7 ... m9 + end tag         m1 m2 m7 m8 m9
                         (server keeps 7 days)       nothing to fetch: old
                                                     lines stay
```

The gap marker is one flag, `gapBefore`, on the oldest line a walk gathered
when it stopped without meeting the held set and without the server saying
"end". The UI draws a divider there ("Some messages here were not loaded",
with a control to load them). Loading asks `CHATHISTORY BEFORE <that line>`
and runs the same walk step: when a page meets a held msgid the flag is
cleared, otherwise it moves to the new oldest line. So the walk can be
resumed on demand instead of being bounded by what the connect path can
afford. The flag is stored with the line, so it survives a reload.

This is where I part with #219's "never put lines side by side across a gap
nothing has proven filled; show a divider or drop the cached rows". The
divider is right. Dropping the rows is not, under rubin's requirements, and
"proof" is not needed either: the client does not have to prove coverage,
it has to record where it has none. Every way a hole can enter the store is
one the client knows about at the time (a walk that stopped short, a replay
leg that was cut), because eviction only ever removes the oldest lines.

Without msgids (another ircd, ZNC): lines are matched by the best-effort
identity. A walk without msgids on anything held stops on the floor time
alone, as today. Without `server-time` there is no shared clock and lines
are simply kept as they arrive; such a server has no history to merge
anyway.

### 2.5 How a window is known to exist after a reload

```
                      channel                      private chat
                      -------                      ------------
 window at t=0        store index (open)           store index (open)
                      + saved join list            minus tombstones
 joined / live?       the server says: JOIN        not applicable
                      echo, session restore,
                      a bouncer's JOINs
 new since last time  the server JOINs us          replay leg, TARGETS row
                      (session, bouncer)           newer than what is held,
                                                   or a live line; minus
                                                   tombstones
 closed elsewhere     server did not give it       tombstone from seance/closed
                      back: window stays,          (closedQueries.ts, as today)
                      parted, with its lines
```

The store's index is the one answer to "which windows were open" for both
kinds. That is the unified part. The seams are I1 to I3: only the server can
say a channel is joined; only tombstones can say a private chat is closed.

The client never JOINs a channel just because the device has lines for it.
It shows the window, parted, and joins only what the saved list or the
server says. (This also happens to bring back a channel joined by hand, as a
readable parted window, which today is simply gone: A12.)

`closedQueries.ts` stays as it is. Its tombstones are not conversation
content: they are a small per-account record with a server copy, a merge
rule and a wire format, and it already reads storage fresh on every use, so
it has no BUG-120. Moving its device copy into the conversation record
would save one localStorage key and risk a working sync. Not worth it.

### 2.6 Private chats join the catch-up (phase 3)

Today a private chat is caught up only by the replay. Where there is no
replay (no held session, a refused cursor, Ergo, soju) but the server keeps
private history, lines received on another device never arrive here. The
unified catch-up: after registration, ask `CHATHISTORY TARGETS` when there
are private chats as well as channels, and use its private rows:

- a row newer than what the device holds for that chat queues the same
  walk, through the same paced queue (`catchup.ts`);
- a row for a chat with no window and no tombstone opens one, unread;
- a row no newer than what is held costs nothing. For private chats the
  index is trusted (for channels it stays a hint): a command per chat for
  30 chats is a minute of fake lag.

With the replay accepted, none of this runs; its private legs do the job.

### 2.7 Caps and eviction

- Per conversation: the newest 1000 lines (the UI holds at most 1500 for
  the open window). Oldest out first, never from the middle, so trimming
  cannot create a hole.
- No age cap. rubin wants old lines to stay; the count bounds the size.
- No cap on the number of private chats (30 was localStorage's budget). A
  closed one is deleted.
- Rough size: 0.3 to 0.5 KB a line, so a full conversation is under 0.5 MB
  and fifty full ones about 25 MB. IndexedDB quotas are far above that.
- Under storage pressure (a quota error, or `navigator.storage.estimate()`
  near its limit): evict whole channels first, least recently touched,
  private chats last. That asymmetry follows I5: the server can give a
  channel back, often not a private chat.
- Older pages the user scrolls up to are stored only while the conversation
  is under its cap.
- Ask `navigator.storage.persist()` in the installed PWA and the shells
  only (#219's point, and right). Safari in a plain tab deletes script
  storage after 7 days without a visit; the store then starts empty and the
  server fills what it can. Best effort.

### 2.8 Settings and privacy

- **One setting**, "Keep conversations on this device", taking over
  `keepPrivateConversations` and its stored value (off stays off). #220's
  separate opt-in `keepChannelHistory` made sense for an experimental
  display cache; as a permanent second switch it is the divergence rubin
  objects to. During phase 2 the channel half can sit behind a development
  flag until it has been checked in a browser, then join the one setting.
- **Off**: nothing is kept or restored; the database is emptied for every
  network; tombstones go memory-only as today (`closedQueries.ts:92-107`).
  The settings sync of #323 already runs this in other tabs; the epoch
  guard covers a flush that was in flight.
- **Clear history** (BUG-051): deletes the conversation's lines and sets
  `clearedAt` to the time of its newest line. From then on, on this device,
  nothing at or before `clearedAt` is stored, fetched automatically or
  offered by "show older", for a channel as for a private chat. Today a
  cleared channel is back after the next reload (A7); this closes that too.
  `clearedAt` goes when the window is closed.
- **Closing a window** (either kind) deletes its lines and its record. A
  private chat also leaves its tombstone, as today.
- **Removing a network** deletes its key range and bumps its epoch, next to
  the existing `forget…` calls (`saved-networks.ts:726-746`).
- **A network that was never saved** has a new uuid every page: memory
  only, as today (`querylog.ts:525`).
- Never in the settings backup, as today.

### 2.9 Servers and logins

| Case                                                  | Restore                      | Merge                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nefarious2, logged in, cursor taken                   | device lines                 | the replay, deduplicated; no per-channel command                                                                                                        |
| nefarious2, logged in, no held session                | device lines                 | the walk per channel; TARGETS orders it                                                                                                                 |
| Guest on AfterNET (`REQUIRE_AUTH`)                    | device lines                 | none for a channel without `+H`: the device is the history                                                                                              |
| Another ircd with chathistory and msgids (Ergo, soju) | device lines                 | the walk                                                                                                                                                |
| No chathistory                                        | device lines                 | none; live lines append                                                                                                                                 |
| ZNC                                                   | device lines                 | its buffer replay, deduplicated by identity; seed that from the store for channels too (A11), or a kept buffer shows every channel twice after a reload |
| No msgid                                              | device lines by identity key | by time and identity, best effort                                                                                                                       |

A small saving that falls out: a guest on AfterNET draws one refused
`CHATHISTORY` per channel on every reload, because `Channel.historyDenied`
(`channel.ts:212`) lives in memory. The conversation record can carry it
for a day. Optional.

### 2.10 Deletion

As rubin asked: best effort. A `REDACT` deletes the line from the store by
msgid whether or not it is still loaded (one call in `handlers/redact.ts`,
through the alias index for an edited line). No tombstones for deleted
lines: with per-line writes no tab rewrites a line it did not just receive,
and a device that missed the `REDACT` keeps the line, which is accepted.
The server already leaves deleted lines out of history pages.

---

## 3. What it retires, and migration

| Item                                            | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `querylog.ts`                                   | Replaced. Its edit, reaction and read-point rules move over (they are right); `parse()` (`:251-278`) stays as the migration reader.                                                                                                                                                                                                                                                                                                                                                   |
| BUG-120 (two copies overwrite each other's log) | Gone by construction (2.2). Do not patch the blob.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| BUG-051 (Clear history undone by the log)       | Already fixed in this worktree (`client.ts:4250-4259` calls `queryLog.forget`). The store keeps it fixed and extends it to channels and to other tabs through `clearedAt`.                                                                                                                                                                                                                                                                                                            |
| REDACT after a trim (#219)                      | Confirmed: `msg:redact` is dispatched only when `chan.idOf(msgid)` resolves (`redact.ts:46-56`), `followInQueryLog` needs the line's id (`client.ts:3835-3839`), and the UI trims a background window to 100 lines (`msg.ts:147-171`) while the log keeps 200. Fixed by deleting by msgid.                                                                                                                                                                                            |
| #220 `historycache.ts`                          | Superseded. Worth taking from it: the transaction helper that always settles, the swappable backend for mocha, the generation guard for a read in flight, the `redact.ts` change, and `tools/scenarios/history-cache.mjs` (it refuses the socket across a reload, which is exactly the check needed). Not needed: `cached` rows, `confirmedMsgids`, `dropCached`, the `msg:drop` event, `firstFillAnswered`, tombstones, the 50-line / 7-day / msgid-only limits, the second setting. |
| `noticelog.ts`                                  | Not required, but it has the same load-once, write-whole weakness. It fits the store as a third kind (`lobby`: no msgid, device clock, 24 h cap) and can move in phase 4.                                                                                                                                                                                                                                                                                                             |
| `closedQueries.ts`                              | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The cursor                                      | Stays in the saved network. At load, offer the older of the saved cursor and the newest line the store actually holds, so a flush that never landed cannot leave a hole behind the cursor.                                                                                                                                                                                                                                                                                            |

Migration of stored logs: on the first boot with the store, for each
`thelounge.querylog.<uuid>` key, parse it with the existing reader and write
its chats and lines (`read`, `touched` and edit aliases included) in one
transaction, then delete the key. Writes are keyed, so two tabs migrating
at once produce the same records. If the setting is off, the keys are just
deleted. An old tab still running old code writes its key again; the next
boot migrates it again. No way back to the old format; none is needed.

---

## 4. Hard parts and risks

### 4.1 The replay becomes the only catch-up for logged-in users

These exist today on a live page's reconnect. A reload does not meet them
now only because it holds nothing. Each is a client-side fix; I read them
from the code and have not reproduced them.

1. **A cut leg leaves a silent hole.** The server withholds
   `draft/chathistory-end` on a leg it cut at 100 lines (`replay.c:680-720`).
   The client hands the leg to `deliverCatchup` without looking at its tags
   (`history.ts:909-912`, `:1113-1139`). Fix: a leg without the end tag
   starts the walk for that target from the leg's oldest line, with the
   held set taken before the leg was delivered; if it does not reach, the
   gap marker.
2. **One cursor for the whole network.** The cursor is the newest msgid
   anywhere (`client.ts:4531-4552`). A channel whose own catch-up had not
   finished when the page went away has a gap older than the cursor, and
   `serverReplayCovers` (`persistence.ts:386-397`) asks only whether history
   was ever requested and a line is held, not whether the channel was
   complete. Fix: require the channel's `filled` (stored, 2.1); a channel
   that is not filled walks for itself.
3. **An unknown cursor.** On `CURSOR_UNKNOWN` the server replays from the
   session's last activity, which another device may have kept recent
   (`bouncer_session.c:13896`), and the client leaves `serverReplay` on
   (`persistence.ts:292-297`). A device back after more than the retention
   would be told it is covered when it is not. Fix: treat `CURSOR_UNKNOWN`
   as "not covered"; every channel walks, and the walk deduplicates what the
   replay brought.

Also: the replay path appends without placing by time (`history.ts:1137`).
With restored lines it can be given the held set like the walk.

### 4.2 Asynchronous storage

- **Restore before connect.** Solved by reading the snapshot before
  `createNetwork` (2.3). The connect form's later `createNetwork` for a
  network that was not autoconnected needs the same read first; simplest is
  to read every saved network's snapshot at boot. If the read fails or
  takes over a second or so, go on without it; lines that arrive late are
  shown as a page above what is there, the way `restoreNotices` does
  (`client.ts:4211-4241`), and are not counted as held.
- **The last quarter second** (2.2).
- **WebKit drops IndexedDB connections** when an installed app is suspended.
  `noticelog.ts` already opens a connection per transaction; do the same or
  reopen on error. Without IndexedDB at all, the store is memory
  only and the app behaves as it does today for channels.
- **Read cost at boot** is unmeasured. Thirty conversations of 100 lines is
  3000 records; I expect tens of ms on a desktop. Measure on a mid-range
  Android before fixing the restore size.

### 4.3 The gap marker touches the UI

A new field on the message (`gapBefore`), a divider row in the message
list, a bus event to set and clear it (`bus-contract.md` and
`shared/types/socket-events.ts` together), and a "load" control that must
obey the same rules as "show older" (one request in flight per window,
`history.ts:269-274`). It needs a browser scenario; mocha cannot see it.

### 4.4 Older pages from the device (phase 3)

"Show older" should read the store before asking the server, which also
gives scrollback with no connection. The hard case is a gap flag deeper
than what is loaded: the page from the device must end at the flagged line,
the next request goes to the server, and its lines must be checked against
the store (by key) to notice when they meet stored lines again. Contained,
but it is the one place where the store and the server interleave.

### 4.5 Smaller things

- Restoring events as rows must not run handlers. It does not: restored
  lines go to the UI as a page of finished messages, as private lines do
  today.
- The store grows the amount of private text on the device (1000 lines
  where there were 200). The setting, Clear history and closing a window
  are the user's controls; all three now cover every tab.
- 100 restored lines in each of 15 windows go through `more` at boot
  (`socket-events/more.ts`), which attaches media previews per message.
  Check it does not start loading images for windows nobody opened.
- A reload right after a long absence in many busy channels queues many
  walks. The adaptive depth in 2.3 keeps that below what a reconnect costs
  today.

### 4.6 nefarious2

Nothing is required. Already there and unused by the client:
`evilnet/CHATHISTORYRETENTION` (tells a gap that can still be fetched from
one that cannot) and the private rows of `CHATHISTORY TARGETS`. #219 asked
whether ATTACH should confirm coverage per target; with `filled` kept on
the device and cut legs followed by a walk, it does not need to.

---

## 5. Phasing

Each phase ships something a user notices and nothing in it is replaced by
a later one.

```
 1  the store, private chats on it      BUG-120, REDACT-after-trim gone;
                                        caps lifted; logs migrated
 2  channels on it, reload = reconnect  every window shows at once; no
    + gap marker + replay hardening     per-channel fetch when the replay
    + one setting                       runs; holes are visible and fillable
 3  older pages from the device,        scrollback offline; private chats
    private chats in the catch-up       caught up without a replay
 4  lobby notices in the store,         one mechanism for every window
    retention-aware gaps, persist()
```

**Phase 1.** `conversationStore.ts` with an IndexedDB backend and a memory
backend for mocha; per-line operations and the epoch guard; the snapshot
read at boot; `IrcClient` uses it where it uses `queryLog` (the call sites
are few: `client.ts:764-787`, `:3828-3853`, `:4148-4202`, `:4250-4265`,
`:4339-4342`; `history.ts:534-536`, `:1015-1050`; `markread.ts:73-75`;
`redact.ts`); migration; `querylog.ts` removed. Channels untouched, so the
risk is confined to behaviour that already exists. Tests: two store
instances on one backend stand in for two tabs (the BUG-120 brief's test
list applies as written); `tools/scenarios/query-close-sync.mjs` still
passes; a two-tab browser scenario.

**Phase 2.** Channel lines are written and restored as held lines; the JOIN
of a restored channel is quiet; the gap marker; the three replay fixes of
4.1; ZNC seeding for channels; the single setting; Clear history's
`clearedAt`. The gap marker and the replay fixes are not optional extras of
this phase: without them a reload trades today's empty-but-honest channel
for scrollback with invisible holes. Scenario: #220's, extended with a
burst longer than five pages (expect the divider, and that loading fills
it) and a reload with the socket refused.

**Phase 3.** `requestMore` reads the store first; private chats use the
TARGETS rows; "show older" comes back in restored private chats (A4).

**Phase 4.** As listed. None of it blocks the rest.

---

## 6. Where I agree and disagree

With rubin:

- Agree: one store, one write path, one restore path, device lines stay,
  msgid matching with a best-effort fallback, deletion as best effort, no
  patch to the query log.
- Qualify: "a PM is just a channel with two people" holds for everything
  that is kept and shown. It does not hold for whether the window exists,
  whether it is closed, and what starts its catch-up (I1 to I3). The design
  keeps those three as explicit seams on a shared mechanism.
- Qualify: reload-as-reconnect is right, and it is not free. It needs the
  gap marker and the replay fixes in the same phase.

With #219:

- Agree: IndexedDB, not SQLite; eviction is the constraint, not quota; the
  REDACT-after-trim bug is real; `closedQueries.ts` should not be folded in;
  a divider where lines may be missing.
- Disagree: "the walk can stop on a hole" described `known = chan.msgids`
  taken when the page arrived. Since fee545d16 (#279, 2026-11-11) the walk
  stops only on msgids held at the JOIN (`client.ts:3726`,
  `history.ts:769`). #220 is based on the tree before that and conflicts
  with develop.
- Disagree: folding `querylog.ts` in is not a regression. Lines without a
  msgid get an identity key the code already has; the restore does not need
  to be synchronous, only earlier than the connection, and boot already
  waits on a fetch before it connects.
- Disagree: coverage does not need proof or server help. It needs the
  device to record where it stopped short, which is one flag.
- Partly agree: "ATTACH replay is not a walk" is true and is the main risk
  of this design. The answer is three client checks (4.1), not giving up on
  held lines.
- #220's final choice, the first page replaces the kept lines, was made to
  avoid keeping a line deleted on the server while the device was away.
  rubin has waived that guarantee, which removes the reason for it.

Calls I made that are rubin's to overrule:

1. One setting for both kinds, default on, inheriting the private setting's
   value.
2. A channel the device has lines for but that neither the saved list nor
   the server gives back stays as a parted, readable window rather than
   disappearing.
3. 1000 lines per conversation, 100 restored into each window, no age cap.
