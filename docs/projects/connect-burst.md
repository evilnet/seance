# Slow connect: the JOIN-time command burst vs. the server's flood penalty

_Noted 2026-08-27 ("it takes a long time to connect to an existing account…
we should not have a flood of crap to send"). Status: **root cause found and
fixed the same day** (`client/js/irc/catchup.ts`); the pacing was redone
2026-10-19 (see "The clock parked at the ceiling" below); follow-ups below._

## What was happening

Not WHOIS. On registration Seance sent one `JOIN` per saved channel, and as
each JOIN echoed back it immediately sent `MODE #chan`, `CHATHISTORY LATEST #chan * 50` and `MARKREAD #chan`. Measured with the real app in headless
Chromium against the dev ircd (`Network.webSocketFrameSent` timestamps),
15 channels:

- **65 commands in 0.14 s**: 5 for CAP/NICK/USER, 15 JOINs, then 3 per
  channel.
- Server replies stopped at **0.20 s** and nothing else arrived for
  **90 s** (then a PING); the last channels' history never came within the
  measurement window, and anything the user typed would have queued behind
  it.

Why: ircu-family fake lag. nefarious2 (`ircd/parse.c` ~L1620) charges every
command from a non-oper `lag = lagmin + len / lagfactor` seconds
(`2 + len/120` by default) onto `cli_since`, and `ircd/s_bsd.c`
(`read_packet`, ~L1515) stops parsing the client's lines while
`cli_since - CurrentTime >= 10`. It still reads the socket: the lines wait
in the client's receive queue and are tried again on a 2 s timer or the
next read. So after the first ~5 commands the budget is gone; 65 commands
put the client ~2 minutes "ahead", the queued lines (including the user's
first message) are parsed only as wall-clock time catches up, and the same
applies on every reconnect. A receive queue that outgrows the class's
limit meanwhile is "Excess Flood" and a disconnect (~L1511).

## What changed (2026-08-27)

- **One `JOIN` for the autojoin list** (`IrcClient.joinChannels`):
  `JOIN #a,#b,#c key1,key2`, keyed channels first (keys are positional),
  split on `MAX_LINE_BYTES` and `TARGMAX=JOIN:<n>` when advertised. 15
  commands → 1.
- **No `MODE #chan` on JOIN.** The modes are asked for lazily, the first time
  the channel is opened (`IrcClient.open`, `Channel.modesKnown`, reset on
  re-JOIN). It only fed the "Channel modes: +nt" info line.
- **Paced catch-up** (`client/js/irc/catchup.ts`): the history + read-marker
  fetch for a channel is queued when its JOIN echoes. The channel the user is
  looking at is served immediately; the rest one channel every
  `CATCHUP_INTERVAL_MS` (4 s — two commands cost 4 s of lag, so the penalty
  stays flat and the user's own lines go out at once). Opening a waiting
  channel serves it now and restarts the pacing from there. `MARKREAD` is
  skipped when the server already volunteered the marker (nefarious2 does
  for logged-in accounts). The queue drops parted/removed channels and is
  cleared on close.
- Result for the same 15-channel connect: JOIN + the active channel's two
  commands go out at once (~4 commands after registration instead of 65),
  first message can go out immediately, remaining channels fill in over the
  next ~56 s in the background without blocking anything.
- Tests: `test/irc/catchup.ts` (fake timers); `client.ts`/`markread.ts`
  expectations updated (no MODE on JOIN, MODE on first open, single JOIN).

## Pipelining during registration (2026-08-27, suggested by ibutsu)

The lag clock is reset when registration completes (`s_auth.c:1483`
`cli_since = CurrentTime`), so commands sent before `001` are free — the
only cost of the registration exchange is round trips, and each "wait for
the reply before sending the next line" was one. The server processes
lines in order, so anything whose precondition is established by the
previous line can be sent in the same flush:

- `CAP REQ …` → **`CAP END` in the same flush** (`caps.ts`
  `pipelineEnd`). The ACK/NAK still arrive and are tracked; a NAKed
  multi-cap REQ is atomic, so its caps are re-requested one at a time
  (once each; works after `CAP END` too). With SASL configured the
  `AUTHENTICATE <mech>` opener is what follows the REQ instead (the cap
  is enabled by the time the server reads it); a NAK of `sasl` aborts the
  exchange (`AUTHENTICATE *`) and sends `CAP END`.
- `JOIN a,b,c` → **the active channel's `CHATHISTORY` + `MARKREAD` in the
  same flush** (`catchup.ts` `prefetchCatchup`, called from the
  registration hook): membership holds by the time the server reads them.
  The JOIN echo then only adds `MODE` for that channel.
- Not pipelined: the PLAIN payload behind `AUTHENTICATE PLAIN` (needs the
  server to accept data before it sent `AUTHENTICATE +`; untestable here,
  no services), and `CAP END` before the SASL result (registration must
  not complete unauthenticated).

Measured (localhost, 4 channels): socket open → history batch went from
five round trips (LS · REQ · END→001 · JOIN · history) to three
(LS · REQ+END→001 · JOIN+history), all commands for the visible channel
out by 0.07 s. On a 100 ms link that is ~200 ms off every connect and
reconnect.

## The clock parked at the ceiling (2026-10-19)

The 4 s pacing above was wrong in a way the August measurement did not
show: two commands cost 4 s and the interval was 4 s, so the catch-up
drained exactly as fast as it was charged and the server's clock never came
back down. Ten seconds is where the server stops parsing, not a limit on the
wait: every line still in its receive queue adds 2 s more when it is parsed, so each line typed
during the catch-up grew a backlog that only the end of the catch-up
drained. That is the "far more than 10 seconds" opening Seance.

Measured with `tools/scenarios/connect-fakelag.mjs` (12 channels, a line
typed every 4 s for 45 s, `SEANCE_FAKELAG_TYPE=4000`). The dev ircd's image
turns fake lag **off** for users (`fakelagminimum = 0; fakelagfactor = 0`
in its `base.conf-dist`), so it never shows the delay; these runs used a
second container of the same image with those lines removed (ports 18443 /
16667, `SEANCE_IRC_PORT` / `SEANCE_IRC_PLAIN_PORT`). The send → echo time
under `echo-message` is when the server read the line:

|                                  | develop                                                      | this change                 |
| -------------------------------- | ------------------------------------------------------------ | --------------------------- |
| typed lines, fresh connect       | waited 0, 6.1, 14.3, 18.3, 22.4 s; 6 of 11 unread after 45 s | all 11 read within 0.1 s    |
| typed lines, reconnect           | waited 0, 4.1, 8.1, 17.3, 20.3 s; 6 of 11 unread after 45 s  | all 11 read within 0.1 s    |
| server clock peak (with typing)  | 63 s ahead                                                   | 6 s                         |
| clock peak, no typing (dev ircd) | 9.9 s, held at 7.9–9.9 s for the whole catch-up              | 4.0 s                       |
| marker queries on reconnect      | one per channel, every time                                  | none once answered (guests) |

One of three runs of this change saw no echo at all on its connection
(not even for the first line, while the clock was low) — most likely
`echo-message` was not enabled on it; it did not reproduce.

What changed:

- **`client/js/irc/fakelag.ts`.** `FakeLagClock` keeps the server's
  `cli_since` on our side: `IrcClient.send` charges every line after 001
  `2 + bytes/120` s (`parse.c`), pulled up to now as `s_bsd.c` does on each
  read. `BackgroundQueue` (`IrcClient.background`, one per connection)
  holds the work nobody is waiting for and sends a job only once it fits
  under 4 s ahead (`BACKGROUND_BUDGET_MS`), so the user always has three
  lines' room before the 10 s ceiling. The model charges opers too (most
  commands are `MFLG_SLOW`) and counts tags; a server with a gentler rule
  only gets its catch-up a little later than it could have.
- **On the queue:** other channels' catch-up (`catchup.ts`, one job per
  channel; opening a waiting one runs it at once), marker queries (front),
  the open channel's `MODE` (in arrival order, cosmetic), debounced `MARKREAD` sets (front, since the other devices close
  their notifications on them, but a channel's at most once per 10 s,
  `MARKREAD_JUMP_GAP_MS`: in a channel where a line arrives or is typed
  every few seconds, each line's marker at the front starved the catch-up —
  measured on AfterNET 2026-10-20, a channel went 45 s without its history
  while a line was typed every 4 s), and the connect-time `WEBPUSH REGISTER`
  renewal (`renewal: true` on the bus emit; a Settings subscribe still goes
  at once — nefarious2 keeps a registration 90 days, `WEBPUSH_EXPIRE`).
  Steady state is still one channel per ~4 s, but it starts once the burst
  has drained (~10 s in) instead of at 4 s, and a reconnect's channel whose
  marker is already known costs one command, so those go every 2 s.
- **Also on the queue, because each could push the clock far past 10 s on
  its own** (10 s is where the server stops parsing, not a cap: every line
  still in its receive queue adds 2 s more): the reconnect walk's `CHATHISTORY BEFORE` pages (front, one channel's walk at a time — they used to go out
  as each reply landed, ~10 s per busy channel), the `MODE` a channel's
  first open asks for (clicking through channels during the catch-up cost
  ~8 s each), and the oper-up queries (`PRIVS`, the snomask, `GET`s, the
  snomask restore, `MODE <me>`: `IrcClient.whenRoom`, one at a time, ahead of other channels' catch-up — the oper panel waits on them; nearly
  every command is `MFLG_SLOW`, so opers pay too). A `+typing` notice is
  not sent while the clock is past the budget: one read seconds late is
  worse than none.
- **Not sent at all:** the `MARKREAD <chan>` query when the server has
  already answered for that channel, `*` included (`Channel.markerAnswered`;
  `*` used to read as "no answer" and was asked again every connect; a
  logged-in account's `*` is forgotten on disconnect, since it may read the
  channel on another device meanwhile). The
  query is a background job of its own that checks again when its turn
  comes, so on a server that volunteers the marker after JOIN (nefarious2
  for a logged-in account) it is never sent, and a server that does not
  still gets asked. Also `PERSISTENCE SET ON` when the registration
  `STATUS` already says the account's setting is `ON` and in force (`SET ON`
  is what creates a missing session, so `ON OFF` still asks).
- **Moved before `CAP END`:** the away state, under `draft/pre-away`
  (`CapNegotiator.finalLines`, `presence.ts` `registrationAwayLine`, from
  the do-not-disturb work, #122). Pre-registration lines are free (an
  unregistered connection's cached lag rule is 0 until `register_user`
  resets it). This branch had its own version of it, dropped in favour of
  #122's when develop was merged; #122 also says the state again after
  registration, for a server before nefarious2 `d9f806d` that loses it on
  a held session's revive.

Server side, for MrLenin: the lag is per connection class
(`fakelagminimum` / `fakelagfactor` in a `Class` block, `class.c`
`get_lag_min`), so a network can give its WebSocket clients a gentler rule
without a code change. Read-only fetches (`CHATHISTORY`, a `MARKREAD`
query, a `MODE` query) charged less than a `PRIVMSG` would still be the
better fix.

Two charges the clock models apart from the class's rule, and one it
leaves out:

- **A multiline batch's close** is a constant 2 s (`m_batch.c`
  `MULTILINE_COOLDOWN_BASE`, added to the clock in
  `multiline_apply_cooldown`), whatever `fakelagminimum` says and with fake
  lag off too; only `MULTILINE_COOLDOWN_DISCOUNT = 0` skips it. The lines
  inside the batch are not charged. `fakelag.ts` `MULTILINE_CLOSE_MS`.
- **`POSTREG_GRACE`** (nefarious2 `99fdaff`, default 20): a connection that
  registers logged in (SASL) gets a 20 s credit that its first charges
  spend before the clock moves — fresh registration, a revive and an alias
  attach alike; an anonymous one keeps the classic ~5-command burst. The
  server does not advertise it, on purpose, and the clock ignores it on
  purpose: it only ever leaves the server's clock below ours, so the
  catch-up goes a little later than it could, never into the wait.

## Ordered by `CHATHISTORY TARGETS` (2026-10-19)

The background catch-up used to go in JOIN order, so the channel that had
been written to waited behind every quiet one, and a reconnect fetched every
channel whether anything had happened in it or not. Now the first channel
to need the background queue on a connection asks one
`CHATHISTORY TARGETS timestamp=<from> timestamp=<a day past now> <limit>`
(at the front of the queue) and the catch-up of every other channel is
parked until it answers (`catchup.ts`):

- `<from>` is the epoch: nefarious2's index moves only on messages, while
  the newest line we hold can be a later join, topic or redaction, and a
  window starting there leaves the channel out. The far end is a day past
  now because nefarious2 drops a target whose newest message is later than
  it (`filter_targets_window`), and a server clock ahead of ours would lose
  exactly the channel just written to. The limit is 100 (capped by ISUPPORT
  `CHATHISTORY`). nefarious2 lists the channels we may read history of:
  those we are a member of, and `+H` (public history) channels without
  membership (`check_history_access`). So it is asked once the JOINs are
  in, newest first; a listed `+H` channel we are not in is simply not
  among the parked ones.
- The answer (`draft/chathistory-targets` batch, labelled; a batch without
  our label is somebody's typed query and is left alone) orders the parked
  channels: written to since what we hold, newest first; then the ones the
  answer leaves out, in JOIN order; then the ones listed with the newest
  message we already hold. Those last are still fetched, the same walk as
  any other channel: the index is a hint for the order, not proof that
  nothing was missed (see below, 2026-10-21).

  The first version skipped them, trusting the answer when the batch opener
  carried `draft/chathistory-end` (nefarious2 leaves it off a truncated
  federated answer from `a333d81`). The skip was dropped on 2026-10-21: the
  index had been wrong twice (truncated answers tagged complete before
  `a333d81`; REDACT and TOPIC not moving it before `7598622`), and a
  message stamped at or before the one we hold that reached the store late
  is listed under our time, so a skipped channel would have missed it
  silently. On nefarious2 with SASL the skip rarely applied anyway: a
  reconnect is covered by the `PERSISTENCE ATTACH` cursor (no TARGETS at
  all), and a fresh page holds nothing.

- "What we hold" is the newest message the server stamped (one with a
  msgid, `Channel.newestServerRef`) before this JOIN, and only once that
  channel's catch-up has completed (`historyFilled`: cleared when a JOIN's
  catch-up is scheduled, set when its fill or walk is answered in full). A local line is on our clock and can be later
  than lines we never got; a channel whose fill never came holds nothing but
  our own last JOIN; and a catch-up the socket cut short, with a live line
  seen meanwhile, must not read as finished.
- Every channel parked before the answer arrives is answered for, since the
  server reads our lines in order, except those whose JOIN we sent after the
  command (`noteJoinsSent`).
- No answer within `TARGETS_TIMEOUT_MS` (5 s), or a `FAIL`: JOIN order, as
  before. A `FAIL` saying the server does not know the subcommand stops it
  being asked again for the page; our own `FAIL` is not shown. Not asked
  without `batch`, while the persistence cursor replays the gap
  (`serverReplay`), or for fewer than two channels behind the open one.

Measured on the lag rig (12 channels, 60 s per phase,
`SEANCE_FAKELAG_WAIT=60000`), with the skip: a fresh connect fetched the one
channel written to in the last run first; a reconnect with nothing new sent
5 commands after 001 instead of 12 and fetched no history; a reconnect after
a helper wrote three lines to `#lag10` while the page was offline fetched
`#lag10` and nothing else. Without the skip the last two fetch every channel
again, `#lag10` first, the quiet ones behind it. The peak stayed at 4.0 s
throughout.

The cost: one command (2 s on the server's clock) on every connect that has
two or more channels behind the open one, so the first background fetch
starts about 2 s later on a fresh connect. Since the quiet channels are
still fetched, the order is all it buys; what it buys is the channel that
was written to fetched first instead of behind every quiet one.

On a real network: `tools/fakelag-probe.mjs` measures what the server
actually charges (a PING burst after 001, guest or SASL, and a holder mode
that makes the next login an alias attach), and
`tools/scenarios/connect-fakelag-live.mjs` runs a fresh connect and a
reconnect with typing on a real account (both take the password from
`SEANCE_SASL_PASSWORD` only). On AfterNET's fractal (2026-10-21) a guest got
5 commands at once then one per 2 s, a SASL alias attach 15 (the 20 s
`POSTREG_GRACE` credit on top), and a revived held session no fake lag at
all. That is a server bug confined to sessions restored from the bouncer
database after a restart (fractal had restarted the day before): such a ghost's
cached lag factor is 0, which nefarious2 reads as "no fake lag", and a
revive never looks it up again. A session held without a restart in between
is charged as usual. Details in PR #121's server notes.

Also in this round: a queued push renewal is dropped when its endpoint is
unregistered (it would have re-registered it); the open channel's reconnect walk (`CHATHISTORY BEFORE` pages) goes at once while the server's clock stays under 6 s
(`PAGE_NOW_LIMIT_MS`) instead of waiting for the background budget, and
opening a channel runs its queued page (both under that ceiling); and a
walk the socket cuts short between pages is dropped whole, undelivered, so
the next connection walks the same gap from the same floor (landing its
newest pages would have moved the floor past the older part). A walk that
stops at the page cap or on a short page without the end tag does not
vouch for the gap.

## Follow-ups

- **Server side:** read-only fetches (`CHATHISTORY`, `MARKREAD` query,
  `MODE` query) could carry a lower lag charge, or a client with
  `labeled-response`/`draft/chathistory` could get a larger burst budget on
  connect. Worth raising with MrLenin alongside the WebSocket fixes; the
  client-side pacing stays regardless (other ircds, and it is the right
  shape anyway).
- **Queries** are not caught up on connect at all today (no JOIN to hook);
  history for open PMs is fetched when opened (`more`). Fine, but note it.
- **Unread badges** for not-yet-caught-up channels only reflect live traffic
  until their turn comes (2–4 s × position among the channels with
  traffic, since `TARGETS` puts those first).
- **Private conversations in the `TARGETS` answer** are ignored. They are
  exactly the rows that could open a query window for a PM received while
  away (or refresh an open one), which nothing does on connect today.
- Show a subtle "catching up…" state on channels still queued (the UI has
  `moreHistoryAvailable`; a `catchingUp` flag would be the analogue).
