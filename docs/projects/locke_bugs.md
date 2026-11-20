# Locke's bug report: work list

Status, 2026-11-17: of the 87 entries, 84 are fixed, in #325 (released in
v5.8.0); 13a is won't-fix, 5g is superseded by the conversation store (#326),
and 10e is deferred to the native-shell review. 4e's remaining half waits on
nefarious2 forwarding the label for CHECK. Section 14 lists what the fixing
turned up.

Another developer did a read-only review and reported 148 findings
(`BUG-001` to `BUG-148`). The review read an older checkout, from before
Vite, pnpm, oxlint and the Tauri shell. So on 2026-11-15 every finding was
checked again against `develop`, one at a time: the code path read end to
end and, where it was cheap, reproduced with tsx or a throwaway mocha test.
**87 still apply and are listed below.** The other 61 were dropped; the last
section records why.

Tick an item when its fix lands (name the PR), or when it is closed
another way, with a note under it saying how (5g, 13a). Move this file to `archives/`
when every box is ticked. Each entry gives the report's ID and title, a
severity (revised where the re-check changed it), today's location and what
is wrong today. Paths are from the repository root. Line numbers are as of
2026-11-15.

## 1. Read first: security

- [x] **1a. BUG-113: a deep-link target is pasted unchecked into `/query`**
      (High if the network uuid leaks)
      `client/js/socket-events/network.ts:186`,
      `client/js/router.ts:181-192`,
      `client/js/irc/commands/index.ts:150-172`. Vue Router decodes the
      `#/net/<uuid>/<target>` parameter, and it is sent as
      `` `/query ${target}` `` once that saved network connects (for example
      on autoconnect). A space alone sends a message: `/query` sends the rest
      as a PRIVMSG, so `NickServ%20<cmd>` reaches NickServ. With `%0A` (and
      `%2F` for slashes) and no `draft/multiline`, the second line runs as its
      own command, and an unknown command goes out raw. The uuid is random
      per device, so exploiting this needs it to leak.
- [x] **1b. BUG-112: `pairs()` on a Lua library view returns the real shared
      table** (High for shared scripts)
      `client/js/irc/scripting/engine.ts:125-132` (`view`), `:206-213`
      (`env_for`). `__pairs = function() return next, lib, nil end` gives
      `local _, real = pairs(string)` the shared table, so one script can
      overwrite `string`, `table`, `math`, `utf8` or `coroutine` members for
      every other script, including `s:upper()` calls, because the string
      metatable's `__index` is that same table. Reproduced. `rawset` on a view
      writes only the script's own view and is harmless. This contradicts
      `docs/areas/scripting/api.md:374`.
- [x] **1c. BUG-110: an unbounded push line index can hang the service worker**
      (Medium: hardening)
      `client/js/push/line.ts:157-180`, `client/js/push/merge.ts:44-71`
      (`joinLines` loop at `:51`). `lineIndexOf` never bounds
      `sent`/`total`. With tsx, `1/1000000000/1000000000` is accepted, 309
      digits give `Infinity`, and `sent=5000000` alone takes about 2 s. The tag
      is a server tag inside the encrypted push, so only the user's own ircd
      can send it. Cap at the documented 64
      (`docs/projects/push-payload-multiline.md:90`).

## 2. Connection lifecycle and the multiline queue

There is one `IrcClient` per network for its whole life
(`client/js/irc/manager.ts:187`), so a `WeakMap<IrcClient, …>` outlives every
disconnect unless `onOpen`/`onClose` clears it. 2a, 2b and 2e were reproduced
with a fake transport.

- [x] **2a. BUG-001: WHOIS data in flight survives a disconnect and corrupts
      the next WHOIS** (Medium)
      `client/js/irc/handlers/whois.ts:64`, `:384-388`. The `pending` map loses
      an entry only on 318/369, and neither `onOpen` (`client.ts:1494`) nor
      `onClose` (`client.ts:2063-2127`) resets it. The next WHOIS of that nick
      merges into the stale record (old channels plus new), and a later 301
      for the nick is swallowed as "in progress".
- [x] **2b. BUG-002: the WHO queue survives a disconnect and misattributes
      later replies** (Medium)
      `client/js/irc/handlers/who.ts:53`, `:67`, `:199`;
      `client/js/irc/commands/who.ts`. Only a 315 shifts the queue. After a
      reconnect the next `/who` meets the stale token: its 354 rows show as
      raw text, the 315 prints "No one matched WHO", and the new query stays
      queued. A refused send also leaves its `beginWho` entry.
- [x] **2c. BUG-007: `saslOk` is not reset for a new connection** (Medium)
      `client/js/irc/client.ts:589` (field; set at `:1936`, `:1967`, `:1977`;
      missing from `onOpen` `:1494-1526`). It is read at `client.ts:1880`
      (`METADATA * SUB` before `CAP END`), `:2287` (`webpush:available`),
      `client/js/irc/presence.ts:563` (`heldByBouncer`) and
      `client/js/irc/bouncer.ts:300`. It bites when a later connection runs no
      SASL: the network was edited to "No authentication", or the credentials
      were emptied while `saslDisconnectOnFail` is off.
- [x] **2d. BUG-010: exception and invite-exception list buffers survive a
      disconnect** (Low)
      `client/js/irc/handlers/lists.ts:84`, `:100-127`. An `/exceptlist` (+e)
      or `/invitelist` (+I) cut off before 349/347 keeps its rows, so the next
      list for that channel shows them twice. Bans were fixed in 8488e7a0e:
      they moved to `banList.ts`, which is reset in `onOpen`.
- [x] **2e. BUG-014: a multiline pending copy times out while its cooldown
      retry waits** (Low)
      `client/js/irc/multiline.ts:836-866` (`multilineCooldown`), `:742`
      (`armPending`); `client/js/irc/pending.ts:37`, `:153-162`. A cooldown up
      to 120 s parks the batch, but the copy's 60 s timer keeps running.
      Reproduced: `FAIL BATCH MULTILINE_COOLDOWN 90` gave "Not sent" at 61 s,
      then the batch was sent at 92 s. With nefarious2's `max-bytes=16384`, a
      cooldown over 59 s is reachable.
- [x] **2f. BUG-077: another device's multiline echo settles our in-flight
      batch** (Medium)
      `client/js/irc/multiline.ts:242`, which calls `multilineAccepted` at
      `:794`. The finding came from the old `feat/multiline` branch, and
      develop's send queue still has it. Pending copies settle by label, but
      `multilineBatch` calls `multilineAccepted()` for any non-nested self
      batch. A multiline message from the same account on another device
      (soju, a shared session) therefore settles ours. If the server then
      answers our batch with `MULTILINE_COOLDOWN`, `standard-replies.ts:226`
      reports it failed instead of retrying it. Settle only when the opener's
      `label` matches `inFlight.label`.

## 3. History and catch-up

- [x] **3a. BUG-006: `catchupPrefetched` sticks when the prefetched JOIN never
      echoes** (Medium)
      `client/js/irc/catchup.ts:160-163` (set), `:186-187`, `:196`, `:211-213`;
      caller `client/js/irc/client.ts:2390-2394`. Only a JOIN echo clears it.
      If the autojoin is refused (47x) or the socket dies first, the next JOIN
      echo for that channel skips the history fetch: a hand `/join` after an
      invite, or a later reconnect once the channel is no longer active. For a
      channel that is not active, the queued catch-up step is dropped as well.
- [x] **3b. BUG-015: `abortHistory()` delivers the partial catch-up gap it
      claims to drop** (Medium)
      `client/js/irc/history.ts:350-363`, the append branch of `resolve` at
      `:856-863`; disconnect path `client/js/irc/client.ts:2118-2122`.
      Resolving an append request with `"timeout"` still runs `deliverAppend`
      with the pages gathered so far. That moves `newestRef` and the cursor,
      which is then saved, so the next reconnect never fetches the older part
      of the gap. It happens when at least one page was fetched and the next
      page request is in flight at disconnect. A page still queued is dropped
      correctly.
- [x] **3c. BUG-119: catch-up lines delivered after a live line move
      `newestRef` backwards** (Medium)
      `client/js/irc/client.ts:4294-4296`;
      `client/js/irc/history.ts:593-605`, `:692-710`;
      `client/js/irc/handlers/markread.ts:234-246`. Only gap lines no newer
      than what was held at the JOIN are flagged `old`. Newer gap lines,
      delivered after a live line that arrived during the walk, set
      `newestRef` back to themselves. MARKREAD then stops short of the live
      line, which stays unread on other devices. The gap appended below the
      live line was fixed in d0322ffa7.

## 4. Commands, handlers and input parsing

- [x] **4a. BUG-004: `splitMessage()` can emit an empty chunk** (Medium)
      `client/js/irc/message.ts:469-487`; callers `client/js/irc/client.ts:2717`
      and the QUIT reason at `:1040`. With tsx,
      `splitMessage(0, "   x", 2)` is `["", "x"]` and
      `splitMessage(60, "  " + "a".repeat(600))` has chunk lengths
      `[0, 440, 160]`. It happens when a chunk starts with a whitespace run
      whose only spaces fall within the budget, or when a hard cut lands just
      before a run of spaces. Only the non-multiline path is affected.
- [x] **4b. BUG-008: `/query` with an open window's name does nothing or
      messages it** (Low)
      `client/js/irc/commands/msg.ts:24-34`. `findChannel` returns before the
      `isChannelName` rejection, so `/query #seance hi` with `#seance` open
      sends to `#seance`. The same early return matches the lobby (named after
      the network) and any open window: `/query <open window>` does not
      switch to it. Inherited from upstream.
- [x] **4c. BUG-009: `/say` and plain text in a lobby or special window go to
      the window's title** (Low-Medium)
      `client/js/irc/commands/msg.ts:61-62`; guard
      `client/js/irc/commands/index.ts:204-212`; compare
      `client/js/irc/commands/me.ts:15`. In a lobby, plain text is refused but
      `/say hi` sends `PRIVMSG <network name>`. The guard covers only
      `LOBBY`, so in a special window ("Ignored users", the mode lists) even
      plain text is sent to the translated title, and a title with a space
      becomes `PRIVMSG :Ignored users :hi`.
- [x] **4d. BUG-011: the unhandled-numeric fallback ignores the reply/error
      distinction** (Low)
      `client/js/irc/handlers/index.ts:119-122`;
      `client/js/irc/errors.ts:84-89`. Any 4xx/5xx goes to `numericError`
      without consulting `isErrorNumeric()`. This affects only unlabelled
      replies in 535-537, 542, 545, 546, 548 and 549: from a server without
      `labeled-response`, a raw OPERMOTD, or anything unsolicited.
- [x] **4e. BUG-134: remote `/check <server> <target>` renders an empty card**
      (Low-Medium)
      `client/js/irc/commands/oper.ts:52-61`;
      `client/js/irc/request.ts:182-195`. CHECK is not in nefarious2's
      forwarded-label table, so the server ACKs the label at once. `runCheck`
      resolves with `ack` and no lines, which shows an empty "CHECK …" card,
      and the real 286-291 then arrive unlabelled as unhandled lines. Known in
      `docs/projects/oper-tools.md:435`; the nick menu avoids it by sending
      `CHECK nick`.
      _Seance's half fixed: no empty card, and a labelled remote answer makes
      the card (`test/irc/oper.ts`). Until nefarious2 adds CHECK (291, 292)
      to its forwarded-label table (`ircd/forwarded_label.c`
      `fwd_terminals`), the remote answer still shows as raw lines._

## 5. Saved networks, settings and local storage

- [x] **5a. BUG-016: `/connect` to a saved host wipes its SASL and autojoin**
      (Medium)
      `client/js/irc/commands/connect.ts:43-54`,
      `client/js/irc/manager.ts:87-108`,
      `client/js/irc/saved-networks.ts:787-833`. `/connect <host> [+port]`
      with the current nick matches a saved entry (host, port, nick and
      transport) and merges in `join: ""`, `sasl: ""`, `saslAccount: ""` and
      `saslPassword: ""`, which a tsx run confirmed. A live network then
      reconnects with the blanks and keeps autoconnecting with no SASL and no
      channels. Only deploys that require an account skip it.
- [x] **5b. BUG-018: `migrateGlobalNotify()` re-disables notifications on
      every boot** (Low-Medium)
      `client/js/irc/saved-networks.ts:390-412`, called from
      `client/js/boot.ts:119`. The legacy `desktopNotifications: false` is
      never deleted (its sibling `migrateReadingToLocale` does delete its key),
      so every boot stamps `notifyEnabled: false` on every network until the
      user changes some setting.
- [x] **5c. BUG-021: saved-network normalisation trims the SASL and server
      passwords** (Low)
      `client/js/irc/saved-networks.ts:174-178` (`asString`), `:292-293`,
      `:302`, `:443-446`. The trimmed value is stored and sent, so a password
      with leading or trailing spaces fails. A whitespace-only form password
      keeps the old one.
- [x] **5d. BUG-022: channel order is never pruned when a network is deleted**
      (Low)
      `client/js/irc/saved-networks.ts:697-713` (`remove`), `:764-766`. The
      network's entry stays in `thelounge.sort.channels` and travels in
      settings backups. It is never revived, because uuids are random.
- [x] **5e. BUG-034: ignore lists are not forgotten when a network is
      removed** (Low)
      `client/js/ignore.ts:148-160`,
      `client/js/irc/saved-networks.ts:697-713`. `thelounge.ignore.<uuid>`,
      the in-memory list and the service-worker mirror all survive. The
      report's "revives on re-add" is wrong, since a re-added network gets a
      new random uuid.
- [x] **5f. BUG-051: "Clear history" on a query is undone by the query log**
      (Medium, privacy)
      `client/js/history.ts:11-29`; `client/js/irc/client.ts:984`,
      `:4136-4190` (`restoreQueryLines`); `client/js/irc/querylog.ts:451-460`
      (`forget`, never called here). Only the store is emptied. The lines come
      back on the next page load, and new lines are appended to the old log
      in the meantime. The dialog says "This cannot be undone."
- [x] **5g. BUG-120: query logs are cached per tab and overwritten blindly**
      (Medium, privacy)
      `client/js/irc/querylog.ts:484-490` (`load` caches once), `:524-560`
      (`save` writes the whole cache), `:108-125`;
      `client/js/irc/manager.ts:504-508` (the only `storage` listener, for
      closed queries). Two tabs overwrite each other's history and read
      markers. Turning "keep private conversations" off in one tab is undone
      by another tab's next save.
      _Not patched (rubin, 2026-11-15): superseded by a conversation store that retires `querylog.ts` (branch `seance_conversation_store`, `docs/projects/conversation-store.md`)._
- [x] **5h. BUG-060: malformed collapsed-networks storage throws** (Medium)
      `client/js/helpers/collapseNetwork.ts:4-5`,
      `client/js/socket-events/init.ts:39-41`; written verbatim by
      `client/js/helpers/settingsBackup.ts:301-320`. An unguarded
      `new Set(JSON.parse(...))` throws on `{}` or `5`. The worse case is
      `init`: it throws before `store.commit("networks")` on every
      registration, not only on the collapse toggle.
- [x] **5i. BUG-125: `nickFromAccount` keeps a leading digit or `-`**
      (Low-Medium)
      `client/js/branding.ts:374-377`, used at
      `client/components/Windows/Connect.vue:806-809`; 432 fallback at
      `client/js/irc/handlers/numerics.ts:184-215`. `1alice` stays `1alice`,
      the server answers 432, and the user lands as a random `seanceNNNN` on
      every connect, because the saved nick never changes. An over-long
      account does the same on servers that refuse it (Ergo); nefarious2
      truncates it.
- [x] **5j. BUG-129: settings restore decompresses gzip with no size limit**
      (Low-Medium)
      `client/js/helpers/settingsBackup.ts:368-372` (`pipe`), `:435-448`;
      `client/components/Settings/General.vue:491-503`. Neither the file size
      nor the decompressed bytes are capped before validation, so a small
      crafted `.seance-settings` file can exhaust the tab's memory.
- [x] **5k. BUG-132: the TLS toggle maps 8067/8443 while the default TLS port
      is 9998** (Low-Medium)
      `client/components/NetworkForm.vue:949-983`;
      `client/js/irc/saved-networks.ts:124-131`. The edit form swaps
      `[8067, 8443]` and maps a transport switch to `tls ? 8443 : 8067`, while
      `defaultPort(true)` is 9998 (since 675ba816a). `/connect host +` has its
      own `defaultPort` that also says 8443
      (`client/js/irc/commands/connect.ts:13-16`).
- [x] **5l. BUG-143: the settings-backup docs omit scripts and script
      storage** (Low, docs)
      `docs/resources/settings-backup.md:34-66`,
      `docs/resources/client-features.md:117`; code in
      `client/js/helpers/settingsBackup.ts:45-81`, `:264-285`. The code
      deliberately backs up `thelounge.scripts` and
      `thelounge.script_storage.*`, restores them switched off, and deletes
      them when a version-2 file lacks them. The table leaves both out yet
      says "the restore never writes a key outside the list above", and
      `client-features.md` gives their version as 1, not 2. Fix the docs;
      optionally have the restore confirmation say that scripts get replaced.

## 6. Store, routing and socket events

- [x] **6a. BUG-019: `removeNetwork` splices the last network when the uuid
      is unknown** (Low, latent)
      `client/js/store.ts:405-411`. `splice(findIndex(...) /* -1 */, 1)`
      removes the last network. No current path sends `quit` with an unknown
      uuid (`IrcClient.quit()` is the only sender), so add the guard before a
      second sender appears.
- [x] **6b. BUG-020: `findChannelOnCurrentNetwork` lowercases instead of
      casefolding** (Low)
      `client/js/store.ts:256-259`; callers
      `client/js/commands/join.ts:26`, `client/components/JoinChannel.vue:75`.
      `#foo[bar]` and `#foo{bar}` miss each other, so `/join` sends a JOIN the
      server ignores and the user is never switched to the window. The fix is
      `casefold()` from `client/js/irc/casemap.ts`.
- [x] **6c. BUG-052: `clearHistory` does not reset the IRC layer's unread
      counters** (Medium)
      `client/js/history.ts:11-29`; `client/js/socket-events/msg.ts:64-72`;
      `client/js/irc/client.ts:4337-4372`. Only the store copy is zeroed, so
      the next message brings back the old count plus one from
      `Channel.shared`. It also emits no `history:trim`, so the IRC layer
      keeps the cleared lines' refs and `totalMessages`.
- [x] **6d. BUG-053: stored mutes are not applied to conversations that
      arrive after the announce** (Medium)
      `client/js/mute.ts:77-89`; `client/js/socket-events/join.ts:10-21`.
      `applyStoredMuteStatus` runs only from `init` and `network`. Rejoined
      channels, queries reopened by an incoming PM and channels restored by a
      held session all come in unmuted, alert, and count in the inbox again.
- [x] **6e. BUG-115: JoinChannel resolves an existing channel on the wrong
      network** (Medium)
      `client/components/JoinChannel.vue:74-91`. It looks the name up on the
      active network, not `props.network`. B's join form therefore switches to
      A's channel of that name and never sends the JOIN to B.
- [x] **6f. BUG-135: a failed connect on one network cancels another
      network's landing** (Low-Medium)
      `client/js/socket-events/network.ts:111-126` (`cancelLanding()` at
      `:118`); `client/js/helpers/lastChannel.ts:147-149`. Any
      `network:aborted` (SASL refused, account required, bad server password,
      a deleted bouncer network) clears the single global landing. Cancel only
      when `pendingLanding(data.network)` is set.
- [x] **6g. BUG-137: a notification for a closed conversation on a connected
      network does nothing** (Low)
      `client/js/router.ts:239-249` (`openTarget`). With no matching window it
      only records a pending target, and nothing opens the query or rejoins.
      A join of that target within 60 s then switches the view unprompted.
      Also, as a one-line hardening, the `NetworkTarget` guard
      (`router.ts:183-200`) redirects without `clearPendingTarget()`.
- [x] **6h. BUG-139: the `init` merge drops the client-only `downSince`**
      (Low)
      `client/js/socket-events/init.ts:39-79` (`:73`);
      `client/js/socket-events/network.ts:144-148`;
      `client/js/irc/client.ts:908-916`. Every registration sends `init` for
      all networks, and the merge replaces each `status` wholesale. Every
      other network that is down loses its "down since" time, so the
      connection strip (`client/components/ChatInput.vue:630`) treats it as
      just dropped.

## 7. Context menus and nick actions

- [x] **7a. BUG-066: a nick menu from a mention whose conversation is closed
      acts on the active channel** (Low-Medium)
      `client/components/ContextMenu.vue:279-281`,
      `client/components/Mentions.vue:123-128`. The network is right (fixed
      in 7d28e02da), but `:channel="group.conversation?.channel"` is undefined
      once the conversation is closed. The menu then uses the active channel
      whenever it is on the same network, so Give/Revoke mode, Kick and Ban…
      (`client/js/helpers/contextMenu.ts:497-549`) act on a channel the
      mention never came from. Fall back to the network's lobby.
- [x] **7b. BUG-071: user-menu lookups compare nicks with `===`** (Low)
      `client/components/ContextMenu.vue:287` (target user),
      `client/js/helpers/contextMenu.ts:376` (own user), `:380` (Whois
      switching to an open query), `client/js/helpers/banMenu.ts:55`
      (`canSetBans`). After a case-only nick change, or on a stored or
      replayed row, the lookup misses and the user is treated as unmoded: the
      menu offers "Give op" to an op and shows Kick when it should not. Use
      the network's casefold, as `IrcClient.namesEqual` does.

## 8. Scripting (Lua)

- [x] **8a. BUG-123: `string.rep("", huge)` bypasses the 1 MiB guard and
      freezes the page** (Medium)
      `client/js/irc/scripting/engine.ts:93-105`. The guard is
      `#tostring(s) * count`, which is 0 for an empty string, and Fengari's
      native loop never yields to the instruction hook. Measured: 0.9 s at
      5e7, about 40 s at `math.maxinteger`, per call.
- [x] **8b. BUG-126: an ignored user's JOIN/PART/QUIT/KICK/NICK/TOPIC/MODE
      reach scripts** (Low-Medium)
      `client/js/irc/handlers/join.ts:25-36`, `part.ts:20-29`,
      `quit.ts:20-27`, `kick.ts:37-45`, `nick.ts:20-31`, `topic.ts:33-39`,
      `mode.ts:97-106`. Only `privmsg.ts:93-101` and `tagmsg.ts:48` check the
      ignore list, but `docs/areas/scripting/api.md:40` says lines from
      ignored people never reach scripts. Filter each dispatch, or narrow the
      doc to `message` events.
- [x] **8c. BUG-141: JOIN and MODE fire script events for channels the client
      does not track** (Low)
      `client/js/irc/handlers/join.ts:25-36` (guard `:63-66`), `mode.ts:97-106`
      (guards `:108`, `:126`). Both dispatch before their "channel we track"
      guard. This happens only when the client's channel list and the server
      disagree. QUIT and NICK match the documented scope.
- [x] **8d. BUG-128: the 50-script cap is enforced on load but not on save**
      (Low-Medium)
      `client/js/irc/scripting/storage.ts:179-181` (load), `:201-233`
      (`saveScripts`), `:239-250` (`saveScript` pushes);
      `client/components/Settings/Scripts.vue:288-301`. Reproduced: a 51st
      script is stored, `loadScripts()` returns 50, and the next save of any
      script erases the 51st.
- [x] **8e. BUG-142: `seance.reply` ignores the documented `network` field**
      (Low)
      `client/js/irc/scripting/manager.ts:478-479`; docs
      `docs/areas/scripting/api.md:290-291`. Only `networkUuid` is read, so a
      hand-built table with only `network` replies on the open network.
- [x] **8f. BUG-063: the `/slap` starter template messages the network name
      from a lobby** (Low)
      `client/js/irc/scripting/library.ts:82`. In a lobby,
      `seance.current_channel` is the network name, so `/slap` there sends
      `PRIVMSG <network name> :\001ACTION …`. The cookbook's `/shrug`
      (`docs/areas/scripting/cookbook.md:117-122`) guards with
      `if where == seance.current_network then … return end`; the template
      should too.

## 9. Services and oper tools

- [x] **9a. BUG-024: padded X3 headers parse as a phantom user and a phantom
      alert** (Medium)
      `client/js/irc/services/x3/alerts.ts:103`, `:156` (trace); `:20`, `:52`
      (`stats alerts`). X3 pads `Nick                  User@Host   (Account)`
      and `Name                 Action (by Oper)` (opserv.c:299, :330), but
      the skips compare single-spaced text. With tsx, every trace gains user
      "Nick" and every alerts list gains alert "Name". The fixtures
      (`test/irc/alerts.ts:161`, `:177`) and
      `docs/resources/x3-services.md:143`, `:192` use the single-spaced form,
      which is why the tests miss it.
- [x] **9b. BUG-025: the investigation card sets host = nick on a
      four-parameter 338** (Low-Medium)
      `client/js/irc/investigate.ts:1257-1275`. `handlers/whois.ts` was fixed
      in 878b3612d; `applyWhois` still takes `params[len - 3]`. On a
      ratbox-family ircd the card shows the nick as the host, and its ban
      suggestions use it.
- [x] **9c. BUG-030: malformed IPv4 CIDRs pass the pre-send mask check**
      (Low)
      `client/js/irc/profiles/nefarious/bans.ts:159-200` (`checkIp`).
      `*@1.2.3/24`, `*@1.2/16`, `*@1.2.3.4.5/24` and `*@1.2.*/16` come back
      `{needsForce: true}`. nefarious2's `gline_checkmask` (gline.c:311) and
      `zline_checkmask` (zline.c:242) reject a dotted CIDR without exactly
      three dots, or with a wildcard before the `/`, even when forced.
- [x] **9d. BUG-032: a failed services ban closes every pending service
      lookup** (Low)
      `client/js/irc/services.ts:539-542` (`resetServiceReplies` at
      `:482-493`). It settles every watcher on the client, not just the ban's.
      It is reachable only through a transport `RangeError` on an open
      connection, in practice a NUL in the mask or reason. Settle only the
      ban's own watcher.
- [x] **9e. BUG-033: a failed alert lookup leaves its collector registered**
      (Low)
      `client/js/irc/alerts.ts:70-74`; same pattern in
      `client/js/irc/investigate.ts:556-567` (`askBot`). The watcher is
      registered before `sendQuiet` and not cancelled when the send fails, so
      for 10 s it can swallow O3 lines meant for a later lookup. As with 9d,
      only a `RangeError` (a NUL in a field) reaches it.
- [x] **9f. BUG-048: alerts with under 30 minutes left show as expired**
      (Low)
      `client/components/Oper/OperAlerts.vue:716-721`.
      `Math.round((at - now) / 3_600_000)` is 0 for an `Expires` 20 minutes
      ahead, and `left <= 0` labels the alert "expired".
- [x] **9g. BUG-146: services liveness state survives a switch to another
      network** (Low)
      `client/components/NetworkForm.vue:808-812`, `:879-885`. The uuid
      watcher reloads the package and bots but never bumps `checkSeq` or
      clears `checkText`/`checkOk`/`checkPending`. With the same services
      config (the usual X3 defaults), no watched value changes, so A's verdict
      stays on B's form and A's in-flight check lands there.

## 10. Presence, push, service worker and notifications

- [x] **10a. BUG-026: a confirming shared-presence read can keep the hold
      about 10 s too long** (Low)
      `client/js/irc/presenceShare.ts:151-158`, `:173-177`;
      `client/js/irc/client.ts:3412-3446`. Normally the hold ends when the
      registration burst closes. When no self `metadata` batch came and the
      10 s GET is the read, adopting a newer stamp with the same value returns
      before `syncShared`/`syncPresence`. The account then stays `AWAY *`
      until `MUTE_READ_FALLBACK_MS` (20 s). Reproduced in mocha. An easy
      trigger is `auto` on a device that never chose a mode.
- [x] **10b. BUG-103: page-shown notifications are not closed when the
      conversation is read** (Medium)
      `client/service-worker.js:508-531` (`showPageNotification`),
      `:2553-2580` (`closeForTarget` skips anything not tagged `push-*`);
      `client/js/webpush.ts:444-455`, `:1844-1862`;
      `client/js/socket-events/msg.ts:314-372`. `chan-*` notifications (any
      network without a push subscription on this device, INVITEs, lines
      without a msgid, and the no-worker `new Notification` fallback) stay
      until clicked.
- [x] **10c. BUG-104: service-worker activation deletes every other deploy's
      cache** (Medium)
      `client/service-worker.js:113-138`. Release (`/seance/`), `/develop/`
      and every `/prN/` share the `evilnet.github.io` origin
      (`.github/workflows/pages.yml`), and each worker deletes every cache but
      its own build's. Visiting one breaks the others' offline cold start.
      _Fixed in b638e20c7: caches are named per deploy scope._
- [x] **10d. BUG-105: workers broadcast builds and notification clicks to
      every window on the origin** (Medium)
      `client/service-worker.js:144-150` (`announceBuild`), `:2842`
      (resubscribe), `:3130-3170` (`openApp`), `:1253-1256` (`appWindows`);
      `client/js/pwa.ts:113-117`. Other deploys' tabs are offered "Reload to
      update", which a reload cannot satisfy. `openApp` can hand a click to
      another deploy's (or another github.io project's) tab and never open the
      app. `appWindows()` alone does not fix it, because the release URL is a
      prefix of the previews' URLs. Exclude nested deploy directories, or have
      the page ignore messages from a worker outside its own registration.
      _Fixed in b638e20c7: workers address only their own deploy's windows, and pages ignore other deploys' workers._
- [ ] **10e. BUG-127: the Android shell's native push ignores the ignore list
      and mutes** (Low-Medium, privacy)
      `shells/tauri/src-tauri/gen/android/app/src/main/java/chat/seance/app/PushService.java:107-123`,
      `:156-175`. The service-worker path was fixed in eab4a2237. The Android
      `PushService` shows every PRIVMSG/NOTICE and never consults the page's
      ignore list or this device's muted conversations.
      _Deferred to the native-shell review: `docs/projects/fix_ignored_pushes_native.md`._
- [x] **10f. BUG-140: an empty CTCP ACTION shows raw in a notification**
      (Low)
      `client/js/push/strip.ts:57-61`; the inline fallback in
      `client/service-worker.js:1611-1612`. The `ACTION` regex requires a
      space, so `\x01ACTION\x01` is shown raw with Markdown off, and as the
      word "ACTION" with Markdown on (the default).
- [x] **10g. BUG-062: `showNativeAlert` reports success when the native call
      failed** (Low)
      `client/js/helpers/nativeAlerts.ts:95-122`;
      `client/js/helpers/shell.ts:114-130`. `nativeCall` turns a rejection
      into `null`, but `showNativeAlert` returns `true` regardless, so a
      failed `LocalNotifications.schedule` (iOS/macOS) or `NativePush.show`
      suppresses the fallback ping. A success resolves `{}`, so a null check
      is enough. On Windows and Linux, `alerts.rs` swallows its own errors.
- [x] **10h. BUG-144: the presence/pushMute import cycle is order-dependent**
      (Low, latent)
      `client/js/irc/presence.ts:48`, `:416`;
      `client/js/irc/pushMute.ts:12`, `:20`. `MUTE_READ_FALLBACK_MS` is
      computed at top level from `MUTE_READ_DELAY_MS`. Reproduced: importing
      `pushMute.ts` first throws `ReferenceError` at `presence.ts:416`.

## 11. Message rendering and search

- [x] **11a. BUG-055: an escaped pipe in a table cell still splits the cell**
      (Low)
      `client/js/helpers/ircmessageparser/parseMarkdown.ts:997-1017`,
      `:1040-1055` (`rowCells`); `client/js/helpers/parse.ts:107`, `:121`.
      With tsx, `| 1 \| y | 2 |` gives cells `["1 ", "y", "2"]`. In a header
      row the table is not recognised at all, and `\|` inside a code span
      splits the same way. (An unescaped pipe in a code span splitting the
      cell is GFM's own rule.)
- [x] **11b. BUG-057: identical neighbouring math spans merge into one
      formula** (Low-Medium)
      `client/js/helpers/ircmessageparser/layout.ts:77-82`, `:481-516`,
      `:573-587`. `wrapOf`, `sameWrap` and `groupNodes` carry `codeId` but
      not `mathId`. With tsx, `$$x$$` on two consecutive lines renders as one
      block reading "xx".
- [x] **11c. BUG-058: a reply to an edited message shows "(unknown
      message)"** (Low)
      `client/js/helpers/messageUpdates.ts:164-177`, used at
      `client/components/Message.vue:635-644`. `replyQuote` skips the
      superseded original and does not follow `supersededBy`. While connected
      it also sends a needless CHATHISTORY AROUND. The unit test
      (`test/tests/messageUpdates.ts:180-196`) gives the replacement the
      original's msgid, which never happens on the wire.
- [x] **11d. BUG-138: search matches raw IRC text, so formatting-split words
      are missed** (Low)
      `client/js/searchQuery.ts:324-338` (`matchesFilters`). `hel\x02lo` does
      not match "hello", and `-world` does not exclude `wor\x1dld`. It is used
      for the offline fallback and to re-check extra words against server
      rows (`client/components/Windows/SearchResults.vue:917`, `:991`), while
      the highlight works on rendered text.
- [x] **11e. BUG-147: exception and invite rows with no timestamp show the
      current time** (Low)
      `client/components/Special/ListExcepts.vue:16`, `:46-47`;
      `client/components/Special/ListInvites.vue:16`, `:43`.
      `formatDateTime(undefined)` formats "now". Bans are fine:
      `Windows/BanList.vue:492` guards.

## 12. UI components

- [x] **12a. BUG-038: Escape with the install guide open also leaves
      Settings** (Medium)
      `client/components/InstallGuide.vue:2-7`, `:333-337`;
      `client/js/keybinds.ts:268-293`; `client/components/App.vue:119-128`.
      The overlay has no `data-escape-close`, so `topEscapeLayer()` stays null
      and the global keybind also calls `leavePage()`. The `escapekey(null)`
      broadcast also reaches the "no overlay up" listeners (ChatInput blur,
      the search panel, the sidebar locale menu).
- [x] **12b. BUG-040: the user-list filter survives a channel switch**
      (Medium)
      `client/components/ChatUserList.vue:80-81`, `:90-96`;
      `client/components/Chat.vue:122`; `client/components/RoutedChat.vue:2-7`.
      `<Chat>` is not keyed and nothing watches `props.channel`, so the filter
      text and `activeUser` carry over to the next channel. A switch through a
      query or the lobby clears them.
- [x] **12c. BUG-045: `/search` with the query already shown is a silent
      no-op** (Low)
      `client/js/commands/search.ts:12-25`;
      `client/components/Windows/SearchResults.vue:1427-1444`. The panel's own
      field re-runs an identical query (`:1256-1263`), but the slash command
      does not: vue-router 5.4.0 resolves a duplicate navigation with
      NAVIGATION_DUPLICATED instead of rejecting, so neither the `.catch` nor
      the route watch fires.
- [x] **12d. BUG-041: a late syntax check can revert a reopened script**
      (Low-Medium)
      `client/components/Settings/ScriptEdit.vue:718-740`. After its await,
      `checkSyntax` re-checks only `script.value`, not `unmounted`, then saves
      the whole snapshot. Close the editor while the sandbox is being built,
      reopen and edit (or flip the switch in the list), and the late write
      reverts that change.
- [x] **12e. BUG-042: Up/PageUp in the user-list filter select the first
      user** (Low)
      `client/components/ChatUserList.vue:217-220`. In
      `direction ? first : last`, -1 and -10 are truthy. `activeUser` starts
      null and is cleared on mouseleave, so the first Up does it.
      `client/components/NetworkList.vue:533-535` has the same expression,
      mostly latent because every keystroke auto-selects the first result.
- [x] **12f. BUG-044: "Today"/"Yesterday" markers never update at midnight**
      (Low)
      `client/components/DateMarker.vue:41-49` (emitter
      `client/components/App.vue:229-235`). The `daychange` handler only
      unsubscribes. The Vue 2 code called `$forceUpdate()` there, and the
      Vue 3 conversion (dd05ee3a6) dropped it.
- [x] **12g. BUG-047: a touch starting at screen x or y = 0 never drags the
      sidebar** (Low)
      `client/components/Sidebar.vue:157-164`. The release half was fixed in
      a1b792056. `onTouchMove` still returns on a falsy `screenX`/`screenY`,
      so the pane never follows the finger and the angle and scroller checks
      are skipped. Null-check as `endDrag` does.
- [x] **12h. BUG-133: a fast diagonal flick can toggle the sidebar** (Low)
      `client/components/Sidebar.vue:178-181`, `:237-253`. The
      vertical-gesture branch calls `onTouchEnd()` → `endDrag(true)`, which
      applies the horizontal toggle threshold. It fires when the deciding move
      already carries |dx| > 50 px within 180 ms. ee4a4d8b3 uses
      `endDrag(false)` on its scroller path; use it here too.
- [x] **12i. BUG-059: Tab completion in the middle of a word keeps the rest
      of the word** (Low)
      `client/js/autocompletion.ts:181`, `:198-202`. With the caret at
      `ali|cex`, completing `alice` gives `alicecex`.
- [x] **12j. BUG-116: the toolbar's Edit overwrites and then discards the
      composer draft** (Medium)
      `client/js/helpers/compose.ts:50-67`;
      `client/components/MessageActions.vue:488-491`;
      `client/components/ChatInput.vue:946`. `startEdit` replaces
      `pendingMessage` without saving it, and cancelling or sending the edit
      sets it to "". ArrowUp edits only from an empty composer, so the
      toolbar's Edit button is the way in.
- [x] **12k. BUG-117: Enter handlers outside the composer ignore IME
      composition** (Medium)
      `client/components/ReactionPicker.vue:793-795`,
      `client/components/NetworkList.vue:27`, `client/components/Chat.vue:38`
      (`@keyup.enter="saveTopic"`, which is hit in Chrome as well),
      `client/components/TranslationSheet.vue:171`,
      `client/components/ChatUserList.vue:18`,
      `client/components/Windows/Connect.vue:104`. The composer's own send is
      safe (keypress), but its emoji branch (`ChatInput.vue:509`) checks
      `isComposing` without `keyCode === 229`, which Safari needs. Use the
      guard from `TranslatePanel.vue:364`.
- [x] **12l. BUG-122: the confirm dialog does not trap Tab** (Medium,
      accessibility)
      `client/components/ConfirmDialog.vue:9-18`, `:239-250`, `:331-335`.
      Role, `aria-modal`, the label, initial focus and focus restore landed in
      a311ccbb3. Tab and Shift+Tab still leave into the app behind it, which
      is not `inert`. `docs/projects/accessibility.md:185-187` tracks this but
      still lists the parts that are done as missing.
- [x] **12m. BUG-079: a long press on a link in a message loses its native
      menu** (Medium)
      `client/components/Message.vue:461` (`onContextMenu`). Found on the old
      `test/pr63-pr64` branch; PRs #63/#64 merged, so it is on develop.
      `onTouchStart` (`:413`) leaves `a, button, …` alone, but the bubbled
      `contextmenu` is `preventDefault`ed whenever the last input was touch.
- [x] **12n. BUG-080: a second finger does not cancel the long press** (Low)
      `client/components/Message.vue:391` (`onTouchStart`), `:431`
      (`onTouchMove`). On `touches.length !== 1` it returns without
      `cancelPress()`, and the move check reads only `touches[0]`, so a pinch
      can open the action toolbar.
- [x] **12o. BUG-081: Copy text copies raw IRC formatting codes**
      (Low-Medium)
      `client/components/MessageActions.vue:293`. It copies
      `props.message.text` as received (`\x02`, `\x03NN,MM`, `\x0F`, …). Strip
      formatting first (`cleanIrcMessage` in `shared/irc.ts`, or an
      equivalent that keeps line feeds).

## 13. Build, tooling, tests and docs

- [x] **13a. BUG-086: oxlint ignores every `.mjs`/`.cjs` file** (Medium-Low)
      `.oxlintrc.json:16`. `"ignorePatterns": [..., "**/*.mjs", "**/*.cjs", ...]`
      skips 193 tracked files outside `attic/`: `tools/scenarios/`,
      `tools/browser-drive.mjs`, `tools/heart/`, `shells/tauri/tools/`.
      `tsc -p tools` covers only `.ts`, so these get Prettier and nothing
      else.
      _Won't fix (rubin, 2026-11-15): a wide mechanical cleanup, and the 405 findings held no real bug._
- [x] **13b. BUG-092: the unread-badges scenario asserts a literal `true`**
      (Medium)
      `tools/scenarios/unread-badges.mjs:157`. "landed on #seance" interpolates
      the active channel into the label only; nothing before it waits on the
      active channel, so the check cannot fail. (The other literal-`true`
      checks under `tools/scenarios/` each follow a `waitFor` on the same
      condition.)
- [x] **13c. BUG-093: the last-channel lobby-wait check accepts the opposite
      behaviour** (Medium)
      `tools/scenarios/last-channel.mjs:111-117`.
      `whileWaiting === BUDDY || (…)` passes when the query is already on
      screen right after the reload, which is the opposite of "waits in the
      lobby, then lands".
- [x] **13d. BUG-095: the scroll-settle test leaves the module clock faked**
      (Low, latent)
      `test/helpers/scrollSettle.ts:34-45`;
      `client/js/helpers/scrollSettle.ts:19-26`. There is no `afterEach`
      restore, and the last test leaves `touching = true`. No other mocha file
      imports `scrollSettle` today, but one that did would hang. Restore the
      clock and reset `touching`/`lastScrollAt`.
- [x] **13e. BUG-099: `browser-drive.mjs` selector screenshots are capped at
      1280 px** (Low)
      `tools/browser-drive.mjs:501`.
      `width: Math.min(1280, r.width + pad * 2)` ignores a wider `--width`.
- [x] **13f. BUG-100: the service-worker tests run the source, not the
      registered artifact** (Low)
      `test/tests/service-worker.ts:4-5`, `:34`. The header says "the exact
      artifact the browser registers", but the tests load
      `client/service-worker.js`. The browser gets `public/service-worker.js`,
      which `vite.config.mts` stamps, rewrites and minifies (the tests even
      pin `build=__HASH__`). Fix the comment, or test the built file.
- [x] **13g. BUG-106: the PWA doc names icon files that no longer exist**
      (Low, docs)
      `docs/resources/pwa.md:17`, `:26-29`. It names `img/logo-grey-bg-*.png`
      and says they double as maskable icons. The manifest uses
      `img/icon-192.png`/`icon-512.png` and separate
      `img/icon-maskable-*.png`. `:26-29` also says a plain `pnpm build` is a
      dev build, but Vite 8 sets `NODE_ENV=production` when it is unset.

## 14. Found while fixing

Not in Locke's report; noticed by the agents fixing it.

- [ ] **14a. Android `PushLine.java` mirrors 1c and 10f** (Low)
      Its ACTION regex needs a space after `ACTION`, and `sent` is bounded
      only at 999999. A two-line mirror of the `client/js/push/` fixes; not
      done because nothing here can compile or test the Android code.
- [ ] **14b. A multiline echo nested in a labeled-response batch never settles
      the send queue** (Low)
      `client/js/irc/multiline.ts` `multilineBatch` skips batches with a
      parent, so such an echo leaves the 30 s verdict timeout to settle it.
      nefarious2 labels the opener instead, so it is not hit there.
- [ ] **14c. The connect screen's TLS toggle does not treat 8443 as a TLS
      port** (Low)
      `client/components/Windows/Connect.vue:755` swaps only `defaultPort`
      values; the edit form (5k) now also knows 8443.
- [ ] **14d. `thelounge.sort.networks` keeps a removed network's uuid** (Low)
      Until the next reorder; 5d pruned only the channel order.
- [ ] **14e. CLAUDE.md and the codebase guide say a plain `pnpm build` is not
      a production build** (Low, docs)
      "`pnpm build` (`NODE_ENV=production` for prod)": Vite 8 sets
      `NODE_ENV=production` itself (13g corrected `pwa.md`).
- [ ] **14f. `scripts/generate-emoji.js` still writes `simplemap.json`**
      (Low)
      Nothing has read it since e7b0fbaa4.

- [ ] **14g. Except and invite masks render as Markdown** (Low-Medium)
      `client/components/Special/ListExcepts.vue:13` (and `ListInvites.vue`)
      pass the hostmask to `ParsedMessage`, so `nick!*@*` shows as `nick!`
      with an italic `@`, and `x!*@example.org` becomes a link. Seen in the
      browser check; present before this pass.
- [ ] **14h. "has changed the topic to:" runs into the topic** (Low)
      `client/components/MessageTypes/topic.vue:3-8`: Vue drops the
      whitespace before `<span class="new-topic">`, so the line reads
      "…changed the topic to:first topic".

## Dropped on 2026-11-15

**Fixed since the review (32):**

| ID      | Fixed in         | ID      | Fixed in                        |
| ------- | ---------------- | ------- | ------------------------------- |
| BUG-003 | 977cfb3cf        | BUG-043 | 94b436de8 (#176)                |
| BUG-005 | c5366a17b        | BUG-046 | 6012deb3a (#145)                |
| BUG-012 | b241baa00 (#172) | BUG-049 | ea6919987 (#156)                |
| BUG-013 | 678b84310        | BUG-050 | 5860c9570 (#167)                |
| BUG-017 | 3fe9ddf3d (#280) | BUG-054 | 1bb8d5d5c                       |
| BUG-023 | c75a64f5b (#177) | BUG-082 | `canCopyText` is now `computed` |
| BUG-027 | ea6919987 (#156) | BUG-083 | ed7584a16 (#164)                |
| BUG-028 | c75a64f5b (#177) | BUG-085 | ed7584a16 (#164)                |
| BUG-029 | c75a64f5b (#177) | BUG-089 | 66017bb8f (#160)                |
| BUG-031 | 03b7b5dcb        | BUG-107 | ca0d94e9f (#243)                |
| BUG-035 | 7d28e02da (#186) | BUG-111 | 3706bcd3a (#288)                |
| BUG-036 | 7d28e02da (#186) | BUG-114 | dc2e4a379 (#201)                |
| BUG-037 | dd6e9f188 (#193) | BUG-118 | ea6919987 (#156)                |
| BUG-039 | 94b436de8 (#176) | BUG-121 | d06ef62ce (#168)                |
| BUG-124 | e481224a0 (#205) | BUG-131 | ea6919987 (#156)                |
| BUG-136 | c48bb5ef0 (#212) | BUG-148 | f58b02225                       |

**Code gone, nothing equivalent has the flaw (25):**

- The script context-menu feature was never committed on any branch: BUG-061,
  064, 065, 067, 068, 069, 070, 072, 073, 074, 075, 076, 097, 098.
- Capacitor/Electron (removed in 471388341): BUG-056, 101, 102, 108, 109.
- Webpack/ESLint-era tooling (ed7584a16, 3b88ffdb2, 5811cbe79, a374d8105):
  BUG-084, 087, 088, 090, 091.
- The message search box moved into the search panel (dc2e4a379): BUG-145.

**Not a bug (4):**

- BUG-078: every line is checked before the first send, so a mid-batch
  refusal means the transport is gone.
- BUG-094: the 10 ms continuation always runs before the 50 ms worker timer,
  whatever the load.
- BUG-096: each literal-`true` check follows a `waitFor` that throws on
  timeout. The exception is unread-badges, kept as 13b.
- BUG-130: link matching only upgrades (`net.tls || !suggestion.tls`). A
  `tls=0` link reaches a cleartext network only when it was saved that way
  and no TLS one exists on that host, as `docs/resources/irc-links.md`
  documents.
