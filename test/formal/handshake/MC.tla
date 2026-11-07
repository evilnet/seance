---- MODULE MC ----
EXTENDS Handshake, TLC, Json
MCOrder == <<"x", "sasl">>
MCOrder3 == <<"x", "y", "sasl">>
\* One JSON line per settled behaviour, for replay.ts and live_server.py:
\* the server has read everything and no server timer is left to fire.
\* `rest` is what the server sent after Seance stopped reading (QUIT), which
\* only live_server.py compares.
Settled == Done /\ c2s = << >> /\ svcIn = << >> /\ svcOut = << >> /\ cookie = 0
           /\ (cQuit \/ s2c = << >>)
Dump == Settled => PrintT(ToJson([env |-> env, sent |-> sent, got |-> got, rest |-> s2c, outcome |-> outcome]))
====
