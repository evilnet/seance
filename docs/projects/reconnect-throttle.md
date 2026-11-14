# Reconnecting into the server's throttle

Reported 2026-10-22: Seance on a phone gets throttled when it is reopened
often, as happens when the user switches between apps. This page records the
cause, what the client now does, and what only the server can fix. The server
part is a proposal for nefarious2; filing it upstream is the maintainer's call.

## What happens

nefarious2's IPcheck (`ircd/IPcheck.c` `ip_registry_check_local`) runs when a
connection is accepted, before TLS, the WebSocket upgrade and SASL. It counts
connections per address in whole seconds. The count restarts after a gap of
more than `IPCHECK_CLONE_PERIOD` (40 s) since `last_connect`, and the
connection that brings it to `IPCHECK_CLONE_LIMIT` (4) is refused.
`last_connect` is set before the check, so a refused connection still counts as
the last one: a client that keeps dialling inside the window keeps it closed.
It is also set when the address's last connection closes
(`ip_registry_disconnect`), so the gap runs from the moment the phone's
socket dropped, not from when it connected. Over a WebSocket the refusal is a
close with code 1006, the same as an unreachable server.

A phone's OS drops the socket each time the app leaves the screen, so each
return is a new connection. Three returns, each within 40 s of the last
connect or drop, use up the window; the fourth is refused: using the app for
half a minute and leaving it for half a minute does it. Nothing refunds a
connection that then logs in, or that resumes a held bouncer session:
`bounce_setup_local_alias` calls `IPcheck_connect_succeeded`, and
`bounce_revive` hands the ghost's count over with `IPcheck_disconnect`, which
lowers no attempts. A held session (SASL with persistence) is spared the
reset at the drop, since its connection stays counted while the session is
held.

The client made it worse. After a refusal its reconnect schedule retried at
once, then after 1, 2, 4, 8, 16 and 32 s, and each retry renewed the window: a
lockout of a minute and a half where 42 s of quiet would have done.

## What the client does now (2026-11-03)

The client does not model the server's throttle. From 2026-10-22 to
2026-11-03 it did: a dial ledger kept this device's dials and drops, replayed
IPcheck's chain rule and synced the count from the server's registration
notice (`on N ca M(limit)`, #170, #171 closed). It could not see the
other devices behind the address, revives send no notice, and a server with
`IPCHECK_SASL_REFUND` hardly throttles a logged-in client at all (a dozen
relaunches of the phone in two minutes, 2026-11-03, none refused). What it
saved was at most one refused dial before the same 42 s wait. So it is gone,
and the server says when it throttles:

- **The server says so.** An `ERROR` line whose text has the word
  `throttled` is the server's connection throttle
  (`handlers/error.ts` `parseThrottleError` → `IrcClient.noteThrottled` →
  `WsTransport.throttled`). If it says `retry in N` (optionally `s`, `sec`,
  `seconds`), the retry after the close waits N seconds and one more (the
  server counts whole seconds), at most five minutes; any other number in
  the text (a kill reason's) is not a wait. With no `retry in`, as in stock
  nefarious2's `Your host is trying to (re)connect too fast -- throttled`,
  it waits 42 s. The wait is flagged (`status.retryReason` = `"throttled"`): the strip
  says "Reconnecting to <network> in Ns: the server limits quick
  reconnects."
- **A dial that fails before it opens.** Today nefarious2 refuses before the
  WebSocket upgrade, which a page reads as any failed dial (1006), and so is
  a network that is not ready yet (the radio waking as the app comes back, a
  Wi-Fi handoff), which is far more common. So such a dial is retried
  quickly, after 1, 2 and 4 s (`QUICK_RETRY_MS`); once those are spent the
  next automatic dial waits 42 s and up to 5 s of jitter
  (`UNREACHED_RETRY_MS`, `UNREACHED_JITTER_MS`), past IPcheck's 40 s
  window, and every one after it too, until a socket opens, which earns the
  quick retries again. So does a quiet spell: no dial to the host for
  `UNREACHED_RETRY_MS` (`WsTransport.hostQuiet`), then a `connect()` (the
  foreground poke, Connect now) or a retry that comes due a minute or more
  after its time (`WAKE_LATE_MS`: a frozen page, a phone asleep). The dials
  that spent them failed in the background, where the OS takes the network
  away, and the app coming back is the radio waking, which is what they
  are for; with the window closed a burst cannot renew it. Connect now
  within the window does not: a user pressing it during a refusal would
  otherwise get a fresh burst each time. A server's throttle
  spends them as well. The strip counts the long wait down ("Reconnecting
  to <network> in Ns…") without claiming the server said anything. When it
  really was a refusal, the quick retries cost about 7 s more than waiting
  at once (each renews the window).
- **Not a refusal:** a dial that hung until the 15 s connect timeout (a
  refusal comes at once; that was the signal) keeps the usual backoff.
- **Offline** (`navigator.onLine` false; only its false is trustworthy):
  whatever the socket did, nothing is retried on a timer but a 30 s
  backstop (`OFFLINE_RETRY_MS`), since the app's `online` event dials as
  soon as the network is back (`foreground.ts` → `reconnectAll`, which never folds that event into a focus poke a moment before it). The
  lobby says once "You're offline. Will reconnect when the network is
  back." with no certificate hint, later failed tries say nothing, and the
  strip says "You're offline. Will reconnect to <network> when the network
  is back." (`status.retryReason` = `"offline"`). Browser check
  `tools/scenarios/offline.mjs`.
- **The long waits hold** (`WsTransport.holding`): the foreground poke
  (`manager.ts` `reconnectAll`, the app coming back, focus, `online`)
  leaves them be, since dialling would renew a refusal's window. Connect
  now, the sidebar's status icon and a typed `/connect` dial at once
  whatever the wait. Every other wait the poke still cuts. A hold is
  judged by the clock, not by its timer, which stands still while a phone
  sleeps: the server's ends when the time it named has passed, ours when
  the host has been quiet for the window. Before that, a phone back from
  an hour asleep sat out the rest of a wait set before it slept, and a
  first dial that met the radio still waking went straight to 42 s.
- **Unchanged:** a connection that opened and dropped retries on the usual
  schedule (at once after a stable one or after a probe, else the backoff).

The cost: when the server is simply down or unreachable, automatic retries
come every 42–47 s once the quick ones are spent. Connect now still dials
at once.

### What the server is asked for

nefarious2 to finish the WebSocket handshake on a throttled connection and
send the reason as a text frame before closing, for example:

```text
ERROR :Your host is trying to (re)connect too fast -- throttled (retry in 37 seconds)
```

Any text with `throttled` works; the seconds are optional but make the wait
exact. Once that ships, the 42 s fallback only covers servers that do not
send it.

## What the server does now

Implemented 2026-10-27 on the testnet's nefarious2 (branch
`ipcheck-sasl-refund`, from the proposal that stood here: refund on SASL
success, capped per account, refusals not counted). Three features, all off
by default so a stock server behaves as before:

1. **`IPCHECK_SASL_REFUND`** (integer, 0 = off). When a connection that
   logged in with SASL registers — the fresh path in `register_user`, a
   bouncer revive (`bounce_revive`, the phone's case) and a local alias attach
   (`bounce_setup_local_alias`) — `IPcheck_login_refund` gives back the
   attempt the accept charged its address: `ip_registry_connect_fail(…, 0)`,
   the hook WEBIRC and the nick-collision paths already use, which lowers
   `attempts` by one, never below one, and moves neither `last_connect` nor
   `connected`. The window stays; the chain just does not grow. It runs
   before `IPcheck_connect_succeeded`, so the `on N ca A(L) …` notice
   reports the refunded count. At registration rather than at the 903: a
   login that never registers earns nothing.

   The value is the cap: that many refunds per account every
   **`IPCHECK_SASL_REFUND_PERIOD`** (integer, 600) seconds, counted in memory
   by `ircd/ipcheck_refund.c` — a pure module shaped like
   `register_throttle.c` (a fixed table, the oldest window evicted, lazy
   expiry, nothing saved; `ircd/test/ipcheck_refund_cmocka.c`). A failed or
   missing login earns nothing, and the check at the accept is unchanged: a
   client without credentials still gets four connections and a refusal
   before any TLS, and an account holder in a loop still pays a handshake and
   a login per connection, up to the cap.

2. **`IPCHECK_COUNT_REFUSALS`** (boolean, TRUE). FALSE makes a refused
   connection leave no trace — the decision is taken before the counting, so
   neither `attempts` nor `last_connect` moves — and a client in a retry loop
   gets back 40 s after its last accepted connection, as `register_throttle.c`
   already does for REGISTER. TRUE keeps ircu's penalty.

3. **A separate limit for WebSocket ports.** Not done: it relaxes the
   throttle for everything on those ports, logged in or not.

The client no longer models any of this (§ What the client does now): with
the refund on, a logged-in client is rarely throttled, and when it is, the
server's word or the 42 s fallback covers it.

The alternative that needs no server change is a native shell (E.4), which
can hold its socket in the background for longer than a page can.

## Reproducing it

The dev ircd relaxes the throttle (`tools/nefarious-dev/local.conf`: 100 /
1 s / 1 s) because the test suites reconnect a lot. To see the real behaviour,
run a private copy of the conf with the `IPCHECK_CLONE_*` features removed,
and wait out `IPCHECK_CLONE_DELAY`: the throttle is off for 600 s after the
ircd boots. Then dial four times within 40 s gaps
(`node tools/irc-ws-probe.mjs ws://127.0.0.1:8067/ x`); the fourth gets no 101. The client's side is covered by `test/irc/transport.ts`
"the server's throttle", `test/irc/throttleError.ts`, `test/irc/client.ts`
"the server's throttle" and `tools/scenarios/reconnect-throttle.mjs` (which
stands in for the server's ERROR, since the dev ircd does not send it yet).
