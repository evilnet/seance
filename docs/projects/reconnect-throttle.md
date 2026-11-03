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
  `WsTransport.throttled`). If the text names a wait in seconds — the first
  `N s`, `N sec`, `N secs` or `N second(s)` in it — the retry after the close
  waits that and a second more (the server counts whole seconds); if it names
  none, as stock nefarious2's `Your host is trying to (re)connect too fast -- throttled` does, it waits 42 s. The wait is flagged
  (`status.retryThrottled`): the strip says "Reconnecting to <network> in
  Ns: the server limits quick reconnects." and the lobby says "Waiting Ns:
  the server says it limits how often a device can reconnect".
- **The fallback.** Today nefarious2 refuses before the WebSocket upgrade,
  which a page reads as any failed dial (1006). So a dial that never opened
  waits `UNREACHED_RETRY_MS` (42 s) before the next automatic one: past
  IPcheck's 40 s window, so a refused dial cannot keep it open, and a second
  refusal in a row is impossible once nobody presses anything. The strip
  counts it down ("Reconnecting to <network> in Ns…") without claiming the
  server said anything. A dial made while `navigator.onLine` is false keeps
  the usual backoff: it never reached a server.
- **Unchanged:** a connection that opened and dropped retries on the usual
  schedule (at once after a stable one or during a probe, else the backoff);
  Connect now, the sidebar's status icon and a typed `/connect` dial at once,
  whatever the wait; the foreground poke restarts the schedule.

The cost of the fallback: when the server is simply down or unreachable,
automatic retries come every 42 s instead of on the quick schedule. The
foreground poke and Connect now still dial at once.

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
