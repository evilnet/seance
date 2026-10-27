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

## What the client does now

`client/js/irc/dialLedger.ts` keeps this device's dials, and when each ended,
per server host in `thelounge.state.dials`, so a reloaded or reopened app and
its other tabs share the record. IPcheck counts a connection at the TCP
accept, before TLS and the WebSocket upgrade, so a dial that timed out or was
given up before it opened ends with a drop too (one that never reached the
server only makes the ledger wait a little longer). A drop is kept only for a
session the bouncer does not hold (a held one stays counted on the server,
which then restarts nothing; a KILL ends the hold, since nefarious2 never
holds a killed session), and the drop a page unload makes, which the
transport never sees, is kept at the unload for any connection still open or
dialling (`noteUnload`). One case it cannot see: a QUIT that hands the
session to another of the account's sessions on the same server is a real
disconnect there (`m_quit.c`), which matters only when that other session is
on another address. The
replay is conservative about the server's whole seconds and the clocks' small
difference: a gap restarts the count only at 42 s (162 s after a drop), and a
dial waits for the same. Before any dial (a scheduled retry, the foreground poke, the
user's Connect) the transport asks it whether the server would refuse, and if
so waits out the gap. The strip says "Reconnecting to <network> in Ns: the
server limits quick reconnects.", and Connect now waits too, because dialling
would renew the window. The worst case is one wait of at most 42 s, never a
spiral. It cannot see dials or drops from other devices behind the same
address, nor tell whether another network on the same server still holds a
connection (then the server would not reset at our drop, and the ledger waits
when it need not).

The cost: a dial that fails looks the same whether IPcheck refused it or the
server is simply down (connection refused, DNS failure, both close with 1006),
and only a radio that is off is told apart (`navigator.onLine`; a dial made
then is not recorded unless its socket opens anyway, since `onLine` can be
wrong and an open socket reached the server). So after three
quick failures against a server that is down, the next try waits up to 42 s
instead of the schedule's next step. The wait is never longer than one window,
whatever the record says: a clock that ran ahead and was put back cannot hold
a network. The service worker's own short connections (away on close, mark
read, a reply) count on the server but are not in the record.

That is as far as a client can go. It cannot keep a socket alive while the OS
has suspended the page, and it cannot see dials from other devices behind the
same address. Carrier NAT puts many phones behind one address, so the
per-address count reaches its limit faster for exactly the users this hurts.

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

The client learns of the refund from the deploy, not the server: `config.json`
`defaultNetwork.ipcheckRefund: {limit, periodSeconds}` (branding.md) gives
`ThrottleRule.refund` to the ledger for that host alone, `IrcClient` records a
refund at 001 when this connection's SASL succeeded (`DialLedger.refunded`),
and the replay lowers the count by one for it when the count is above one —
the server gives nothing back below that and spends none of the account's
budget on it. The budget is mirrored more strictly than the server keeps it:
the server counts the refunds it granted in a fixed window from the first;
the replay honours a refund only while fewer than `limit` refunds that would
have lowered the count, honoured or not, fall in the period before it. This
device's count never runs below the server's, so every refund the server
granted is among those, and the replay never honours one the server refused
(`test/irc/dialLedger.ts` checks this over random histories against a model
of the server's rule).

What the replay cannot see is another device on the same account drawing on
the same budget, or on the same address: then this device thinks the count
lower than it is, by at most the refunds the other device drew, and a dial can
meet a refusal. The client records its own refused dial and its end like any
other, so after a refusal it waits out the window itself — the lockout is one
window, not a spiral, either way. `IPCHECK_COUNT_REFUSALS` off makes that
window run from the last accepted connection rather than from the refused
one, so it is the kinder setting to pair with the refund, not a requirement.
A server that has not been told to refund (any other network) is replayed as
before.

The ledger keeps a host's events from where the replay last started the count
over — a chain of short connections can run longer than four windows, since a
drop restarts nothing within 162 s of the last connect, and a refund lets a
dial in — and its refunds a refund period further back, at most 200 of each.

The alternative that needs no server change is a native shell (E.4), which
can hold its socket in the background for longer than a page can.

## Reproducing it

The dev ircd relaxes the throttle (`tools/nefarious-dev/local.conf`: 100 /
1 s / 1 s) because the test suites reconnect a lot. To see the real behaviour,
run a private copy of the conf with the `IPCHECK_CLONE_*` features removed,
and wait out `IPCHECK_CLONE_DELAY`: the throttle is off for 600 s after the
ircd boots. Then dial four times within 40 s gaps
(`node tools/irc-ws-probe.mjs ws://127.0.0.1:8067/ x`); the fourth gets no 101. The client's side is covered by `test/irc/dialLedger.ts`,
`test/irc/transport.ts` "the dial gate" and
`tools/scenarios/reconnect-throttle.mjs`.
