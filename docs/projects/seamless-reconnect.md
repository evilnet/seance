# Seamless reconnect (mobile): no join/topic replay, back the moment the app is

_Noted 2026-08-27 ("when on mobile, it disconnects right the instant you
switch away… it almost is [seamless] but I'm seeing topic posted on channels
again, and a session message from nef"). Status: **fixed the same day**;
follow-ups below._

## What was happening

Three things stacked up on every return to the app:

1. **Late reconnect.** Mobile browsers drop the WebSocket the instant the
   app is backgrounded (or the OS kills it without a close event). The
   transport then waits out its backoff (1 s → 60 s), and while the page is
   hidden its timers are throttled anyway. Only the Capacitor shells poked
   the connection on foreground (`native.ts` `appStateChange`); the PWA and
   plain browser had no hook at all.
2. **The server's restoration burst shown as activity.** AfterNET's
   nefarious2 runs the built-in bouncer (`draft/persistence`, see
   `docs/resources/nefarious2-websocket.md` § Session persistence): a
   logged-in user's session is held across the drop, and the reconnect
   resumes it. Right after the MOTD the server replays the membership it
   kept — a `BATCH draft/persistence` of JOIN (original `@time`/`msgid`),
   332, 333, MARKREAD and NAMES per channel. Seance rendered those like a
   fresh join: "Rubin … has joined the channel", "The topic is: …", "Topic
   set by …".
3. **A second topic burst.** On top of the restoration Seance sent its own
   `JOIN #a,#b,…` at 376. Resumed as the primary the server ignores it;
   attached as an _alias_ (another client of the same account — the
   desktop — is still the primary) `m_join.c` answers each channel with a
   synthetic 332/333/NAMES burst: the third "The topic is" line.

Without persistence (hold expired, another ircd) the plain re-JOIN after a
drop showed the same join/topic lines as well.

## What changed (2026-08-27)

- **Foreground hooks for the browser build** (`client/js/foreground.ts`,
  installed from `boot.ts`): `visibilitychange` → visible, `online` and a
  back/forward-cache `pageshow` call `reconnectAll()`, which now de-bounces
  (one poke per second; the native `appStateChange` fires alongside).
  Networks waiting to reconnect dial immediately; open ones are probed.
- **Socket probe** (`WsTransport.probe()`, `Transport.probe?`): sends
  `PING :probe`; if nothing at all arrives within 10 s the socket is dropped
  and reported as an unclean close, so the normal reconnect follows. Any
  inbound data cancels it. Replaces the bare `PING :resume` that could sit
  on a dead socket for minutes.
- **Quiet re-join** (`Channel.rejoining`): set for every channel we were in
  when the connection dropped (not on our own QUIT), cleared by the end of
  the re-JOIN's NAMES (366). While set, `join.ts` does not show our own
  JOIN and `topic.ts` hides a 332 whose topic we already show (and its
  333). A topic that changed while we were away is shown as before.
- **`draft/persistence`** (`client/js/irc/persistence.ts`,
  `handlers/persistence.ts`): the cap is requested; the registration-time
  `PERSISTENCE STATUS ON` sets `client.persistenceHold` and, at 376, the
  autojoin is held back (`awaitRestoration`) until the `draft/persistence`
  batch has been applied — or `RESTORE_WAIT_MS` (1 s) passed without one.
  The batch is run through the normal handlers with `client.restoring` set:
  JOIN/332/333/NAMES update the model, show nothing (a topic we did not
  know yet — fresh page load — is still shown), and each restored JOIN
  starts the usual paced catch-up (`CHATHISTORY LATEST`, then `BEFORE` back to the newest line we
  hold). Afterwards only the channels the server did _not_ restore are
  JOINed. `STATUS OFF`, no STATUS, or no cap: JOIN at 376 as before. A
  `PERSISTENCE` reply the user asked for (`/persistence status`) is shown in
  the lobby.
- Tests: `test/irc/persistence.ts` (fake timers; both paths),
  `test/irc/transport.ts` § probe, `caps.ts` updated.

## Round two: it was still repeated (2026-08-28)

What a reconnect on the phone actually looked like after the first round
(the JOIN lines were gone — the topic was not):

```
07:46 *** The topic is: Not Just Linux - All OS & Hardware. …
07:46 ***  Topic set by Rubin on 28 May 2026, 10:19:49
07:46 ***  Channel mode is +tn
07:47 BOUNCER: Attached to session AZ7Rzi… as alias on FractalRealities.AfterNET.Org [NOTE ALIAS_ATTACHED]
07:47 *** The topic is: Not Just Linux - All OS & Hardware. …
07:47 ***  Topic set by Rubin on 28 May 2026, 10:19:49
```

So the reattach delivered **two** channel-state bursts: the first one
restored the session (its JOIN was correctly silent, and the topic was news
because the page had been reloaded — the app is killed in the background),
then the bouncer attached this connection as an _alias_ of the account's
session and sent the whole burst again behind its `NOTE BOUNCER ALIAS_ATTACHED`. The first round only silenced topics inside the
`draft/persistence` batch, so the second burst printed the topic again.

Anything that keys off "which burst is this" is guessing at a sequence the
server does not announce, so the rule is now about the _content_:

- **An unchanged topic is never printed** (`handlers/topic.ts`): a 332 is
  shown when the topic differs from the one the channel already displays,
  and its 333 follows it or is dropped with it. Whatever produces the
  repeat — session restore, re-JOIN, the alias burst, a third burst — it is
  silent. `/topic` sets `Channel.topicAsked` so a query still answers (and
  now says "No topic is set." on 331 instead of nothing).
- **A JOIN for a channel we are already in is a no-op**: no join line
  (`handlers/join.ts`), and no second `CHATHISTORY`/`MARKREAD`/`MODE`
  either (`IrcClient.handleMessage` only starts a catch-up when the JOIN
  actually moved the channel from PARTED to JOINED). That is also what
  stops the repeat burst from spending ~6 s of fake lag.
- **The autojoin waits for a burst that is still arriving**: the wait after
  `PERSISTENCE STATUS ON` is 2 s, but every sign of a restoration in
  progress — one of the server's JOINs, a bouncer NOTE — extends it to
  `RESTORE_QUIET_MS` (750 ms) of quiet, capped at `RESTORE_MAX_WAIT_MS`
  (8 s) from registration. An unbatched burst (no `batch` cap, or the
  second burst) is covered as well as a batched one, and a JOIN we send
  into a restoration is what makes nefarious2 answer with the extra topic +
  NAMES burst in the first place.
- **The routine attach note is not shown**: `NOTE BOUNCER ALIAS_ATTACHED`
  inside the settling window (`inRestorationWindow`, the same 8 s) is setup
  chatter that would arrive on every switch back to the app. The same note
  later — or any other bouncer NOTE — is shown as before. (Round four: that
  window is opened by every registration, not only by `STATUS ON`.)

## Round three: the server does the catch-up (2026-08-28)

`PERSISTENCE ATTACH <profile> [<msgid>]` (nefarious2 `9bc57d4`) replaces our
`TARGETS` + N × `CHATHISTORY` (LATEST then BEFORE, the spec's gap-filling loop) with one server-driven replay. What the
client does now:

- **Track the cursor.** `IrcClient.cursor` is the newest msgid we have shown
  on the network, over every channel and query, picked by `@time`
  (`IrcClient.noteCursor`, called wherever a message gets its id — live,
  appended catch-up, and the prepended history pages, which by definition
  cannot move it backwards). Only messages that carry a msgid count.
- **Persist it.** `saved-networks.ts` keeps `cursor: {msgid, time}` next to
  the network in `thelounge.networks` (`setCursor`, normalised and preserved
  by `save()` like `lastUsed`), written at most once a second and flushed
  synchronously when the transport closes. The phone's PWA is killed between
  sessions, so memory is not enough. A network the user never saved simply
  gets no cursor.
- **Offer it.** After a _successful_ SASL, in the same flush as `CAP END` and
  before it (`client.ts` `offerAttachCursor` → `persistence.ts`
  `attachCursorLine`): `PERSISTENCE ATTACH default <msgid>`. Only when the
  `draft/persistence` CAP 302 value carries the `attach-cursor` token and the
  msgid fits the server's 64-byte buffer. Never without SASL — the server
  answers `FAIL PERSISTENCE ACCOUNT_REQUIRED` — and never after 001.
- **Read the answer.** `:server PERSISTENCE ATTACH default` sets
  `client.serverReplay`; every `FAIL PERSISTENCE … ATTACH …` clears it
  silently and the old dance takes over. `FAIL PERSISTENCE CURSOR_UNKNOWN <msgid>` is _not_ a failure: the msgid aged out of the server's index and it
  replays from its own derived point instead, so it is swallowed too
  (`console.debug` at most).
- **Take the replay as news.** The server wraps it in an outer
  `BATCH +ref evilnet.github.io/bouncer-replay` around one
  `BATCH +ref chathistory <target>` per channel and then per PM counterparty.
  `history.ts` `chathistoryBatch` recognises an inner batch inside that
  wrapper — or an unsolicited one arriving while `serverReplay` is set, for a
  server that replays without the wrapper — and **appends** it as
  ordinary `msg` events — no `more`, no highlight, no unread — instead of
  prepending it as older history, deduplicating on msgid against what the
  channel already shows. A PM from someone we have no window for opens one.
- **Stand down.** With the cursor accepted, a channel the server restores
  does not get a catch-up walk of its own (`persistence.ts`
  `serverReplayCovers`, consulted by `IrcClient.handleMessage` before
  `enqueueCatchup`): that is exactly what the cursor replaces. A channel this
  page load holds nothing for still gets its `CHATHISTORY LATEST` fill — the
  replay only carries the gap, which is often empty — and a channel the
  autojoin had to JOIN itself was not in the session when the replay ran, so
  it catches up as before. `MARKREAD` comes from the server inside the
  restoration batch; `MODE` stays lazy.
- **Hide the closing chatter.** The replay ends with a plain
  `NOTICE … :Session resumed. Replayed N message(s) …` outside the wrapper.
  Inside the settling window (`inRestorationWindow`, the same 8 s that hides
  `NOTE BOUNCER ALIAS_ATTACHED`) it is not shown; the same text later is.
- Tests: `test/irc/attach-cursor.ts` (20, fake timers + an in-memory storage
  backend).

Nothing changes when the server does not offer the token, SASL is not
configured or fails, or there is no stored cursor: the paced per-channel
catch-up of `catchup.ts` runs exactly as before.

## Round four: the leftovers on the phone (2026-08-30)

Reported from the field: an hour of `#linux` on the phone showed five
`BOUNCER: Attached to session … [NOTE ALIAS_ATTACHED]` lines and two
`Channel mode is +tn`, all of them from switching back to the app. Two holes,
both the same shape — a repeat silenced by _context_ that the context did not
actually cover:

- **The settling window depended on `PERSISTENCE STATUS`.** `inRestorationWindow`
  only opened when the effective hold was known to be ON at the end of
  registration, and `IrcClient.persistenceHold` is reset on every `onOpen`. On
  the alias-attach path the unsolicited STATUS line only exists since
  nefarious2 `41f34b7` (2026-05-21), so against a server without it — or any
  future path that skips it — the window never opened and everything gated on
  it (the attach note, the `Session resumed…` summary) was reported once per
  foreground. `persistence.ts` `beginSettling` now runs on _every_
  registration; `awaitRestoration` (which also holds the autojoin) is still
  only for a session we know is being restored — now including one whose
  `PERSISTENCE ATTACH` cursor the server took (`client.serverReplay`), which
  previously autojoined straight into the replay.
- **324 was printed unconditionally.** The modes are asked for after every
  (re)JOIN — lazily on first open, or with the active channel's catch-up —
  so every reconnect brought `Channel mode is +tn` back. `handlers/mode.ts`
  now compares against `Channel.modeText` and only shows a 324 that differs,
  with `Channel.modesAsked` (set by a bare `/mode [#chan]`) as the escape
  hatch — the same shape as `topicAsked` for 332.

## What the ircd offers next (read 2026-08-28)

MrLenin's design guide — [gist 8d644eb…](https://gist.github.com/MrLenin/8d644eb37878d7bcaa91d1a68ae23d94),
"Seamless Mobile Sessions Over Nefarious" — describes the intended shape of
all this, and `origin/ircv3.2-upgrade` is **17 commits ahead** of our
`tmp/nefarious2` checkout with the pieces already in it. What it changes for
us, in the order it is worth doing:

1. **`PERSISTENCE STATUS` is two arguments now** — done, see above; without
   this fix the hold is never detected against a current server, which is
   what let our JOIN land inside a reattach in the first place.
2. **`PERSISTENCE ATTACH <profile> [<msgid>]`** (`9bc57d4`) — done, see
   "Round three" above: the cursor is tracked, persisted, offered in the
   `CAP END` flush after SASL, and the server's replay is appended instead
   of being asked for channel by channel.
3. **Web push is wired** (`414b147` PMs, `9fbcb3b` channel highlights, via
   `ircd_relay.c`): the trigger our notifications note calls missing exists
   now, with per-account payload tiers (`ping`/`route`/`full`). D.11 is
   unblocked — see `notifications.md`.
4. **Post-registration fake-lag grace** (`a1215e6`, `9c9c89a`): ~15 free
   commands after registration for authenticated clients. It does not make
   `catchup.ts` unnecessary (other ircds, and the burst is still charged),
   but the 4 s pacing could start after a small free burst once we target a
   server that has it.
5. Our own WebSocket fixes were **merged upstream** (`fceb160`, PR #101), so
   the dev image no longer needs the local patch — re-pull and rebuild.

## Follow-ups

- **The replay is capped and says so to nobody.** `replay_next_channel` /
  `replay_next_pm` ask the store for at most `FEAT_BOUNCER_AUTO_REPLAY_LIMIT`
  (default 100) messages **per target**, and the closing NOTICE only counts
  what was sent — there is no truncation marker, no `draft/chathistory-end`
  on those batches, nothing a client can test. A busy gap therefore comes
  back silently short, and the client cannot tell "you missed 40 lines" from
  "you missed 40 of 900". Worth asking MrLenin for a signal (a gap marker at
  the head of a truncated batch, or a `WARN`/`NOTE` with the count); until
  then the user's escape hatch is the ordinary "show older messages" button.
  Per-channel read markers can also move the start point forward
  (`replay_next_channel` prefers a marker newer than the cursor), so a
  channel read on another device replays less than the cursor asks for — by
  design, but worth remembering when a gap looks too small.
- **A reattach can still produce a real JOIN, and services greet it.** The
  field report also showed one `-X3- (#Operations) <greeting>` line. X3 sends
  a channel's greeting from `handle_join` whenever it sees a JOIN outside a
  netburst (`send_message_type(4, user, chanserv, "(%s) %s", …)`,
  `chanserv.c`), so that line means the network really saw us join. Neither
  restore path broadcasts one — `bounce_send_channel_state` sends the JOIN to
  the attaching client only, a held session keeps the membership (`s_bsd.c`,
  "suppresses QUIT, keeps channels") and `m_join.c` returns early for a
  channel we are already on — but **both skip `IsZombie`/`IsDelayedJoin`
  memberships**: on a `+D` channel the alias is never added to the channel
  (`bounce_setup_local_alias` step 7) and the client is never told about it,
  so the autojoin JOINs it for real on every reattach, visibly to services
  (greeting, autoop) and to the channel. The client cannot do anything about
  a membership the server hides from it; worth asking MrLenin either to copy
  delayed-join memberships to the alias (still delayed) or to name them in
  the restoration batch so the autojoin can skip them.
- **Cold start still trickles.** With the cursor accepted, channels the page
  holds nothing for are filled with the usual paced `CHATHISTORY LATEST`
  (one per 4 s) so a quiet channel is not empty on a fresh load. That is the
  one case the cursor does not make cheaper; a server-side "replay N latest
  per channel as well as the gap" option would.
- **Settings toggle for the hold** (`PERSISTENCE SET ON|OFF|DEFAULT`): today
  `/persistence set off` works raw and the reply is shown; a switch in the
  network settings would be the friendly place, with the STATUS shown next
  to it.
- **Restoration later than the 8 s cap.** Then the autojoin goes out anyway
  and, attached as an alias, the server answers with another topic + NAMES
  burst — now invisible and cheap, but still bytes. The clean fix is
  server-side: an explicit "resumed / restoring N channels" signal before
  the MOTD end (a `NOTE`, or the STATUS line saying so), or sending the
  restoration before 376 so a client can simply not JOIN. Worth raising
  with MrLenin with the WebSocket fixes.
- **Why two bursts at all** (resume, then alias attach) is worth asking
  about too: from the client's side one would do.
- **`no-implicit-names`**: `Channel.rejoining` is cleared by 366. If that
  cap is ever requested, clear it elsewhere (the batch end, or MARKREAD).
- **Lobby noise on every reconnect** (close report, "Reconnecting in…",
  MOTD, "Enabled capabilities…") is fine on a desktop and clutter on a
  phone; consider collapsing repeats or hiding the MOTD on a resume.
- **iOS**: `visibilitychange` is reliable there, `online` is not; verify on
  a device that the foreground poke is enough (it should be — the socket
  close is what matters and Safari reports it on return).
- The hold is what makes the background time cheap: messages while away
  live in CHATHISTORY and come back via the catch-up. Push notifications
  for that window are the open item in `notifications.md`.

## Round five: the dev-origin zombie session (2026-09-02)

Symptom: the client loops "SASL authentication successful → Connection closed
during IRC registration" forever; iauthd even passes every attempt, but no
001 ever arrives. Restarting the ircd clears it instantly.

Cause: the session limit. nefarious2 allows one active bouncer session per
account per network; a second connection as the same account gets a clean
WS close (code 1000, `Account already has an active session on this network`). The dev-origin proxy (`tmp/dev-origin.mjs`) used to forward
`error` but not `close`/`end`, so a browser tab closing or reloading left
the backend socket — and with it the ircd's "active session" — alive
forever. Every reconnect then hit the session limit; the zombie only died
when someone restarted the ircd.

Fixes and traps worth remembering:

- dev-origin now tears down both sockets when either side closes or ends;
  restart it after editing (kill the `node tmp/dev-origin.mjs` pid first —
  an old instance holds port 8000 and a fresh one fails silently).
- The ircd sends a raw `PING :<cookie>` before registration to clients that
  send NICK before CAP LS (the cookie is skipped for CAP-negotiating
  clients — seance's client.ts sends `CAP LS 302` first for exactly this
  reason, and its transport answers any PING anyway). A hand-rolled probe
  that ignores the cookie stalls at registration forever — which mimics the
  zombie-session symptom perfectly. Always answer `PING :<cookie>` with
  `PONG :<cookie>` in probes, or send CAP LS before NICK.
- A "SASL OK, still alive after CAP END" probe proves nothing: without
  NICK/USER there is no registration to complete. Wait for `001` (or the
  396/MODE tail) before believing any registration test.
- The one-session limit is per account per network: diagnosing "can't
  connect" as a second client while the first is genuinely connected shows
  the same close — check for a live session before suspecting the server.

## Round six: the foreground reconnect on a phone (2026-09-04)

Symptom: bringing the PWA back to the foreground felt slow — a frozen tab
thawing took ~2 s to be registered again, most of it waiting.

Measured with `tmp/sw-reply-probe2.mjs reconnect` (freeze the page via
DevTools, drop its socket at the dev-origin's `POST /__drop` hook, thaw,
watch the store): the close event and the foreground poke arrive in
either order on thaw, and both paths ended in the transport's normal first
backoff (0.5–1 s with jitter) before anything dialled.

Rules now in `transport.ts` (tests in `test/irc/transport.ts`):

- A connection that stayed up ≥ 30 s (the backoff-reset mark) retries **at
  once** when it drops; a young one still backs off (flapping stays gentle).
- A socket that dies **while a probe is in flight** retries at once too —
  that is the poke running before the OS delivered the close.
- Only the first retry is immediate; if it fails the usual schedule
  resumes from attempt 2.
- `probe(timeoutMs)`: the foreground poke passes 4 s instead of the
  default 10 s.
- A dial stuck in CONNECTING is abandoned after 15 s
  (`CONNECT_TIMEOUT_MS`), and `reconnectAll` redials one older than 3 s at
  foreground time (`redial()`) — `connect()` alone is a no-op while
  connecting.
- `foreground.ts` also pokes on `resume` (Page Lifecycle thaw) and `focus`.

Result: thaw → registered in 218 ms (was 2036 ms), with a real second SASL
login in the ircd's chain log. The lobby says `Reconnecting now (attempt 1)…`
for an immediate retry.

Open: two `You are not connected to the IRC network…` lines appear in the
lobby in the ~5 ms between the redial and the new socket opening. Something
sends twice at that moment; it is not the catch-up (guarded and cancelled
on close), not the `connecting` listener, not `connect()`/`onOpen()`.
Pre-existing and cosmetic; attribute with a breakpoint on `client.send`
when the lobby noise is next worked on.

## Round seven: back after a long absence, and the socket a quick switch loses (2026-09-06)

Reported from the phone: after the app had been away for a long time,
bringing it back did not reconnect ("it might be due to a really slow
backoff on retries"), and the socket seemed to drop the instant the app lost
focus, so every switch cost a reconnect. No device in the loop this time;
what follows is read from `transport.ts`, `client.ts` and `manager.ts`, and
each rule is pinned by a unit test.

What the code allowed:

- **The retries that piled up while the app was away decided the wait
  after the poke.** A hidden page keeps running for a while (Android's
  Chrome freezes it after ~5 min; a desktop tab never stops), and every
  retry that failed there stepped the schedule up — 1, 2, 4 … 60 s. The
  counter only reset after a connection that stayed up 30 s. The foreground
  poke did dial at once, but when that one dial failed (radio still coming
  up, the 15 s connect timeout) the _next_ wait was the cap: 30–60 s of
  "Reconnecting in 47s…" with nothing to re-poke it, which is what "does not
  reconnect" looks like to someone who checks for half a minute. The
  immediate retry after a probe was also gated on `attempt === 1`, which a
  phone whose connections are each shorter than 30 s never has.
- **A SASL timeout was final.** The 12 s timer ended in `disconnect()` —
  QUIT plus a deliberate close, which the transport treats as the user's
  decision: state `closed`, and `reconnectAll` leaves `closed` alone (it
  cannot tell it from a network the user disconnected). Services slow on
  return, and the network sat there until the user reconnected by hand.
- **Nothing in the client closes the socket on blur or hidden.** The OS
  does: iOS suspends the page within seconds of a switch and the socket
  with it; Android drops it when Chrome freezes the page or Doze cuts the
  network. A web page cannot ask for a grace period there — a native shell
  could (an iOS background task is worth ~30 s, Android a foreground
  service), which makes it an E.4 item, not a client fix. The one
  client-side QUIT that could hit a page that comes back was `pagehide`
  with `persisted` (back/forward cache).

What changed:

- **A request to connect restarts the schedule.** `WsTransport.connect()`
  from outside — the foreground poke on a `reconnect-wait` network, a click,
  `redial()` — zeroes the attempt counter (the timer's own retry goes
  through a private `dial()`), so a failed foreground dial waits 1 s, then
  2, 4 …, not the cap. A socket lost while `probe()` was waiting zeroes it
  too, so the immediate retry no longer depends on the count. Only that
  first retry is immediate; a failure resumes the schedule from attempt 2.
  Tests: `test/irc/transport.ts` § "a request to connect restarts the
  schedule".
- **A SASL timeout QUITs and retries** (`saslFailed(reason, timedOut)`):
  the lobby says "Not connecting to … without the login you asked for;
  trying again.", the QUIT goes out, and `transport.abandon("SASL timed out")` drops the socket as _lost_ (close 1006, `willReconnect`), so the
  schedule and the foreground poke keep working on it; `closeExplained`
  keeps `onClose` from reporting that close a second time. Rejections —
  904, a NAK, no usable cap, no credentials — still end in `disconnect()`:
  a retry cannot fix those, and looping on a wrong password would be worse.
  The `isQuitting` guard in `handlers/cap.ts` is not needed on this path:
  the socket is gone before the negotiator can queue anything. Test:
  `test/irc/client-sasl.ts` § "QUITs and retries when the exchange times
  out".
- **`WsTransport.abandon(reason)`** (optional on `Transport`): give up the
  socket, keep the connection — what the probe and connect timeouts already
  did internally, now for callers above the transport.
- **Waits at the cap stay at or above 45 s.** Jitter is `[3/4, 1] × base`
  instead of `[1/2, 1]`. nefarious2's IPcheck (`ircd/IPcheck.c`
  `ip_registry_check_local`; `IPCHECK_CLONE_LIMIT` 4, `IPCHECK_CLONE_PERIOD`
  40 s by default) refuses the fourth connection from an address when each
  gap is 40 s or less, and every refusal renews the window, so a client
  cycling faster than that could never get back in — and the refusal is
  invisible, the browser sees 1006 like any unreachable server. Only
  _accepted_ connections count, a dial that never reaches the server is
  free, which is why the fast start of the schedule is safe and only its
  tail needs the floor. See `docs/resources/nefarious2-websocket.md`
  § Connection throttle.
- **No QUIT on a `persisted` pagehide** (`manager.ts`): a page going into
  the back/forward cache may come back as it is, and `pageshow` pokes it.

On a return after a long absence this now reads: poke → dial now; if that
fails, 1 s, 2 s, 4 s … while the user watches, instead of one dial and a
minute of nothing. A SASL timeout on return: "trying again" and the
schedule, instead of a network that needs a tap. A quick switch on Android
keeps its socket (it always did; the probe confirms it); on iOS the OS
takes it and the reattach is immediate and quiet.

Measured in a real browser with `tools/scenarios/reconnect-after-backoff.mjs`
(the page connects through a TCP proxy the scenario runs; the proxy cuts the
socket and refuses every dial for 36 s, then the scenario fires a window
`focus` and reads the lobby): the retries reach `Reconnecting in 30s (attempt 6)…`, the focus signal dials at once on both builds, and after that
dial fails the develop build schedules `Reconnecting in 31s (attempt 7)…`
and misses the 10 s window in which the proxy lets dials through again,
while this branch schedules `Reconnecting in 1s (attempt 1)…` and is
registered on that retry. Run it against a served build with an ircd on
`ws://127.0.0.1:8067`:

```sh
node tools/browser-drive.mjs tools/scenarios/reconnect-after-backoff.mjs --chrome=…
SEANCE_URL=https://127.0.0.1:8000 node tools/browser-drive.mjs tools/scenarios/reconnect-after-backoff.mjs   # another deploy
```

Worth confirming on the phone: the lobby after a long absence should show
`Connecting to …` within a second of the app coming back, and never a
`Reconnecting in <tens of seconds>…` right after a switch.

Follow-ups: the lobby noise on a resume (open since round two); a
background grace period in the native shells (E.4); the
`Reconnecting in …` line could count down or offer a "now" tap for the rare
wait a user does have to sit through.

## Round eight: the conversation while the network is down (2026-09-07)

Asked for: the send button disabled while the network is disconnected (typing
still allowed), a visual cue on a disconnected channel or query that clears on
reconnect, and a reconnecting indicator a phone user actually notices with the
sidebar collapsed — nothing pushy or in the way.

- **Send gate** (`ChatInput.vue` `canSend`): in a channel or query, while
  `network.status.connected` is false, the send button is disabled (its
  tooltip says "Not connected") and Enter keeps the draft. A draft that starts
  with `/` is sendable regardless, because `/connect` and friends have to
  work from a disconnected network — that is why the submit had no gate at
  all before. The lobby is never gated: its input is for commands, and it is
  where the connection reports.
- **Faded conversation** (`Chat.vue` `isDisconnected`): the chat content —
  messages and user list — fades to the pending-message opacity (0.55, with
  a 0.3 s transition) while the network is down, and the sidebar rows of that
  network's channels and queries fade the same way (`ChannelWrapper.vue`
  `network-down`); the lobby row turns red as it always did. All of it is
  computed from `network.status`, which `socket-events/network.ts` updates on
  every `network:status`, so it clears the moment the network registers.
- **Connection strip** (`ChatInput.vue` `showConnectionBar`, `.connection-bar`):
  a row above the input in the family of the reply and upload strips. While
  the transport waits for its next retry it counts the wait down —
  `Reconnecting to <network> in 12s…` — with a "Connect now" button; while a
  dial is in flight it shows a turning sync glyph and
  `Connecting to <network>…`; when nothing is being tried (the user cancelled
  with `/disconnect`, or a rejection ended it) it shows
  `Disconnected from <network>.` and a Connect button. Both buttons send the
  same `/connect` as the sidebar's status icon, which restarts the schedule
  (round seven). It is `role="status" aria-live="polite"`, so assistive
  technology announces the change once; no sound, no vibration, nothing
  modal. On a phone it sits right above the keyboard, whatever the sidebar is
  doing; the header spinner stays as well.
- **`network:status.retryAt`** (bus-contract § 1.1): the close that schedules
  a retry carries the transport's `delayMs` as an epoch time, and the status
  the retry's start sends drops it again — so it is set exactly while there
  is a wait to count, never during a dial, after registration or once
  `/disconnect` cancelled the retry. `IrcClient.status` builds every
  `network:status` from the same fields (`announceStatus`), and the store
  consumer deletes the key when it is absent, so a snapshot without a pending
  retry has no `retryAt` at all. `ChatInput.vue` keeps a half-second ticker
  while the strip shows and reads the seconds off it. Test:
  `test/irc/client.ts` § "says when the retry is due".

Not done, and why: a vibration or sound (pushy, and the OS decides whether a
background page may).

Browser check: `tools/scenarios/disconnected-channel.mjs` (20 checks: the
three states, the countdown and its "Connect now", the draft kept through
Enter, `/connect` sendable, the Connect button dialling, everything clearing
on registration and a message going out), through
`tools/scenarios/lib/irc-proxy.mjs` — the proxy of round seven, now shared.
Run it on the phone layout as well:

```sh
node tools/browser-drive.mjs tools/scenarios/disconnected-channel.mjs --chrome=…
node tools/browser-drive.mjs tools/scenarios/disconnected-channel.mjs --chrome=… --mobile --width=390 --height=844
```

## Round nine: the server's SASL timeout read as a wrong password (2026-10-27, re-cut 2026-11-04)

Reported again: on a phone, after a long time away, bringing the app
back does not reconnect. Found by reading nefarious2's source, not on a
device; pinned by unit tests.

Round seven made our 12 s SASL timeout retry instead of giving up. But
nefarious2 gives up first, at 10 s (`SASL_TIMEOUT`, `m_sasl.c`
`abort_sasl`), and says so with `904 :SASL authentication failed:
request timed out`, and the client took every 904 as a refusal: QUIT,
the network down for good, and autoconnect turned off — so a later cold
start (iOS discards a home-screen app after a long time in the
background) did not even dial. Services unreachable (`904 :… service
unavailable`), services splitting mid-exchange (906) and services not
linked at all (nefarious2 then leaves `sasl` out of `CAP LS`) ended the
same way. A phone coming back after a long time meets exactly the slow
path: a cold Keycloak, a lagging services link. Now (`SaslFailureCause`
in `client.ts`, `isServerSideFailure` in `sasl.ts`):

- the server's own timeout, `unavailable`, and a 906 it sent
  mid-exchange are the server's problem: QUIT, `transport.abandon()`,
  the usual schedule;
- a missing cap or a NAK is the server's problem on a network where this
  account has logged in before (`irc/saslTrust.ts`,
  `thelounge.state.saslOk`, uuid → account, forgotten when the
  credentials are edited, the refusal is final or the network is
  removed; never in the backup), a server without SASL anywhere else;
- a bare 904 — nefarious2 sends it for a wrong password and for a
  Keycloak it cannot reach alike — gets `SASL_TRUSTED_RETRIES` (3) more
  connections in a row for a login that has worked here, then counts as
  a refusal;
- missing credentials, 902, 905, 907 stay final.

What this does not undo: a network whose autoconnect a past 904 already
turned off stays off. Switch it back on in the network's settings.

The round's first cut also restarted the retry schedule when the
foreground poke found the thawing page's own overdue retry in flight,
forgot a dial that failed while the device said it was offline, and
held a 25 s background task in the Capacitor iOS shell. Those went with
the reworks that landed meanwhile: the dial ledger is gone and the
server names its throttle (#170, #172: `online` dials at once, an
offline wait has no timed retries, the long waits hold against the
poke), and the Capacitor shells with them (#155). A grace period in the
background would be the Tauri shell's to give.

Tests: `test/irc/client-sasl.ts` "the server could not check the
login", `test/irc/sasl.ts` "isServerSideFailure".
