# Handshake model

A TLA+ model of connection registration: IRCv3 CAP 302 negotiation, SASL
PLAIN and the server's registration gate. It covers Seance's client and
nefarious2's server (`ircv3.2-upgrade`), with a P10 SASL agent between them
and an ordered pipe each way. The file header of `Handshake.tla` lists
which functions each action follows and what is left out.

## What it checks

`MC.cfg` holds what passes today; `Findings.cfg` holds `AccountAgrees`
unrestricted, which fails on the open gap below.

| Property               | Meaning                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `NoRegisterDuringSasl` | the server never sends 001 with a SASL exchange open                          |
| `CapEndBounded`        | Seance sends CAP END at most twice: once more only behind a late REQ          |
| `LateReqEnded`         | every REQ sent after CAP END and before 001 has a CAP END after it            |
| `CapsAgree`            | once settled, Seance's enabled caps equal the server's                        |
| `OneOpener`            | Seance sends `AUTHENTICATE PLAIN` at most once per connection                 |
| `NoFalseRejection`     | Seance turns autoconnect off only when the login really cannot succeed        |
| `TrustedKeepsNetwork`  | a login that has worked on this network never turns autoconnect off           |
| `AccountAgrees`        | once settled, both agree on whether Seance is logged in (`…Timely` in MC.cfg) |
| `LoggedInWhenPossible` | sasl offered and accepted, services up, right password: logged in at 001      |
| `Terminates`           | every handshake ends in 001 or a closed connection                            |
| `WelcomedWhenPossible` | in that same world it ends in 001                                             |
| `WelcomedWithoutSasl`  | without SASL a timely handshake ends in 001 (`Stall.cfg`, three caps)         |

The environment (caps offered, caps the server refuses, services up or
down, password right or wrong, credentials, whether SASL is required, a
non-Seance client that sends CAP END early, whether the network and
services answer well inside every timeout, and whether the login has
worked on this network before) is chosen in `Init`, so one run
covers every combination. In an untimely world both SASL timers may fire at
any moment.

These properties were written by hand from what a working handshake should
do. The model is of the code, not of the IRCv3 text, so a misreading of
the spec shared by Seance and nefarious2 would not show here.

## Findings

- **Fixed: a server-side SASL outage turned autoconnect off.** nefarious2
  gives up on slow or silent services after 10 s (`FEAT_SASL_TIMEOUT`)
  with `904 :SASL authentication failed: request timed out`, before
  Seance's own 12 s timer, and sends `906` when the services link splits
  mid-exchange. Seance took both for a wrong password: with SASL required
  it quit and called `onSaslRejected`, so the network stopped connecting
  by itself. `NoFalseRejection` found it. A 904 whose text names an outage
  (`timed out`, `service unavailable`) or a 906 Seance did not ask for now
  reconnects like Seance's own timeout (cause `server`, from upstream
  #180, which reached the same rule); the model stands for the first with
  `904T` and the second with `ServerAgentLost`. A login that has worked
  on the network before (`saslTrust.ts`) also retries a NAK or a missing
  `sasl` (cause `unavailable`) and, a few times, a bare 904 (`unexplained`);
  `env.trusted` covers it. A 904 before the credentials went out counts no
  differently: Atheme and Anope refuse EXTERNAL without a certificate that
  way.
- **Fixed: a NAKed REQ lost the SASL opener.** Seance sent
  `AUTHENTICATE PLAIN` in the same flush as the `CAP REQ` that asked for
  `sasl`. A NAK of that REQ makes the server drop the opener, and Seance
  re-requested the caps one at a time without sending it again: it waited
  12 s and reconnected into the same NAK (`LoggedInWhenPossible`,
  `WelcomedWhenPossible`). sasl-3.1 also says the client MUST enable `sasl`
  before using AUTHENTICATE. The opener now waits for the ACK; it costs one
  round trip and no extra command. nefarious2 today never NAKs a REQ built
  from its own LS, but sasl-3.2 says a server MUST NAK `sasl` when the
  authentication layer is gone, so a server that follows it reaches this.
- **Fixed: a REQ after CAP END left registration held.** A `CAP REQ`
  during registration suspends it until the next `CAP END`
  (capability-negotiation), which nefarious2 enforces. Seance sends
  `CAP END` behind its first REQ, so when that REQ was NAKed and retried
  cap by cap while ident or DNS still held registration, no second END
  came and the server closed the connection at its registration timeout.
  The model left those holds out, so it missed this; `env.hold` now stands
  for them, and `WelcomedWithoutSasl` (`Stall.cfg`) fails without
  `caps.ts` `reEnd` and passes with it, and so does `LateReqEnded`. Found
  live, by trace-checking nefarious2 against the IRCv3 spec model. The
  model assumes the hold always ends well and that the registration
  timeout cannot fire while it is pending; a lookup or iauth that times
  out or refuses is out of scope. `live_server.py` skips held behaviours
  (it cannot make the ircd's ident or DNS wait on cue), so the held
  traces are checked against Seance's code by `replay.ts` only, with no
  live evidence from the ircd.
- **Limits of the outage rule.** Retrying is a policy, not
  proof that the next try will work: a misconfigured server that sends
  `906` (Solanum with no `sasl_service`) or times out every time is
  retried every 45 to 60 s for as long as the page is open. And some real
  outages look like a wrong password on the wire: nefarious2's local PLAIN
  path when it cannot reach Keycloak, and Ergo's failed auth scripts, both
  send the bare 904. Only a trusted login rides those out, and only for
  `SASL_TRUSTED_RETRIES` connections; telling them apart needs the server
  to say so.
- **Open, minor: Seance's timer can beat services.** In an untimely world
  Seance aborts while services still hold the credentials, and the server
  logs in anyway (900, 903). `client.account` is still set from 900, but
  `PERSISTENCE ATTACH` and the metadata sent before CAP END are skipped.

## Running it

```sh
# check the properties (tla2tools.jar 1.8+ from github.com/tlaplus/tlaplus)
java -cp tla2tools.jar tlc2.TLC -config MC.cfg MC.tla
# a REQ retried after CAP END, with three caps (WelcomedWithoutSasl)
java -cp tla2tools.jar tlc2.TLC -config Stall.cfg MC.tla
# the unrestricted AccountAgrees, which fails on the open finding
java -cp tla2tools.jar tlc2.TLC -config Findings.cfg MC.tla
# regenerate the traces the tests replay
TLA2TOOLS=/path/to/tla2tools.jar ./gen.sh
# print a counterexample (-dumpTrace json cex.json) as wire lines
python3 trace.py cex.json
```

## How it is tied to the code

- **Seance:** `replay.ts` (run by `pnpm test:mocha`) replays every
  behaviour of the model into the real `IrcClient` through a fake
  transport. It fails if Seance sends a line the model's Seance would not,
  or misses one, or if it leaves differently: refused (`onSaslRejected`),
  retrying (`transport.abandon`) or neither, which the same QUIT line
  cannot tell apart. `handshake.traces.json` is generated by `gen.sh`; do not
  edit it by hand. When Seance's handshake changes, change the model, run
  `gen.sh`, and the test checks the code against it.
- **nefarious2:** `live_server.py` plays the model's client against a
  running ircd and checks that the ircd's replies are the model's server
  replies. It needs `handshake.raw.jsonl` from `gen.sh` and an ircd with
  the config in its docstring. Run it three times: no flag (services up),
  `--svc-down`, and `--no-sasl` (services not linked, so `sasl` is not
  offered). Behaviours from untimely worlds are skipped, since wall-clock
  sleeps cannot place a timer mid-exchange. Behaviours with a services split mid-exchange are skipped too: one fake
  services link cannot stage it. On 2026-11-07 all 1728
  behaviours (696, 648 and 384) matched `ircv3.2-upgrade`.
