------------------------------ MODULE Handshake ------------------------------
(***************************************************************************)
(* Connection registration: IRCv3 CAP 302 negotiation, SASL, and the       *)
(* server's registration gate, as Seance and nefarious2 implement them.    *)
(*                                                                         *)
(* Client = Seance: client/js/irc/caps.ts (CapNegotiator), sasl.ts         *)
(*   (SaslAuth), client.ts (startSasl, saslProgress, abortSasl,            *)
(*   saslFailed, armSaslTimer) and handlers/cap.ts, handlers/sasl.ts.      *)
(* Server = nefarious2 ircv3.2-upgrade: m_cap.c (cap_ls, cap_req, cap_end),*)
(*   m_authenticate.c, m_sasl.c (services replies, abort_sasl),            *)
(*   sasl_auth.c (sasl_complete_login) and the AR_* gate in s_auth.c       *)
(*   (check_auth_finished, auth_sasl_start/done, auth_cap_start/done).     *)
(* Services = a P10 SASL agent (X3): S -> C "+", C data -> L + D S | D F,  *)
(*   D A -> nothing; or down (drops everything).                           *)
(*                                                                         *)
(* Both directions are ordered pipes (one TCP/WebSocket stream).  The      *)
(* environment (what the server offers, which caps it refuses, whether     *)
(* services are up, whether the password is right, whether Seance has     *)
(* credentials and requires SASL) is chosen nondeterministically in Init,  *)
(* so one run covers every configuration.                                  *)
(*                                                                         *)
(* Time is abstract.  A timer may fire only when nothing else is in        *)
(* flight (every pipe empty): the network and services answer well inside  *)
(* the timeouts, so a timer that fires means the protocol is stuck.  The   *)
(* order of the timeouts follows the defaults: server SASL_TIMEOUT 10 s <  *)
(* Seance SASL_TIMEOUT_MS 12 s < registration timeout.                     *)
(*                                                                         *)
(* Left out: PING cookie (Seance sends CAP LS before NICK, so it is never  *)
(*   asked), ident/DNS/iauth (independent holds), cap-notify NEW/DEL,      *)
(*   REQ split over several lines, the local Keycloak and iauth SASL tiers *)
(*   (same gate, different agent), bouncer deferral.                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Order,        \* the order Seance lists caps in (wanted list, sasl last)
    MaxCookie     \* bound on SASL exchanges the server opens

Caps == {Order[i] : i \in 1..Len(Order)}
SeqOf(S) == SelectSeq(Order, LAMBDA c : c \in S)

VARIABLES
    env,          \* the world: record, fixed after Init
    c2s, s2c,     \* client -> server, server -> client
    svcIn, svcOut,\* server -> services, services -> server
    \* --- Seance ---
    cAvail, cEnabled, cOut, cLs, cEnded, cPendEnd, cRetried,
    sasl,         \* "none" (this.sasl null) | "challenge" | "result"
    saslOk, timer, welcomed, cQuit, cEndSent, cSaslStarts,
    outcome,      \* how Seance left: "none" | "rejected" (stops autoconnect) | "retry" (reconnects)
    \* --- nefarious2 ---
    sActive, capPending, nickSet, userSet, saslPending, cookie, nextCookie,
    saslComplete, account, registered, sClosed, regDuringSasl,
    \* --- history, for model-based tests (not read by any action) ---
    sent,         \* every line Seance sent, in order
    got,          \* every event Seance handled: [m, at |-> Len(sent) before it]
    svcNo         \* services refused the credentials (D F) at least once

cvars == <<cAvail, cEnabled, cOut, cLs, cEnded, cPendEnd, cRetried, sasl,
           saslOk, timer, welcomed, cQuit, cEndSent, cSaslStarts, outcome>>
svars == <<sActive, capPending, nickSet, userSet, saslPending, cookie,
           nextCookie, saslComplete, account, registered, sClosed,
           regDuringSasl>>
hist == <<sent, got, svcNo>>
vars == <<env, c2s, s2c, svcIn, svcOut, cvars, svars, hist>>

Msg(t) == [t |-> t]
MsgS(t, s) == [t |-> t, caps |-> s]

----------------------------------------------------------------------------
(* Environment *)
Envs == [ offered   : SUBSET Caps,     \* CAP LS
          refuse    : SUBSET Caps,     \* caps a REQ is NAKed for (another ircd, a rehash or DEL race)
          svcUp     : BOOLEAN,
          pwOk      : BOOLEAN,
          creds     : BOOLEAN,         \* Seance has a mechanism + credentials
          required  : BOOLEAN,         \* saslRequired
          eager     : BOOLEAN,         \* not Seance: a client that may send CAP END
                                       \* at any moment (tests the server's gate)
          timely    : BOOLEAN,         \* network and services answer well inside every timeout
          trusted   : BOOLEAN ]        \* this login has worked on this network (saslTrust.ts)

Wanted == IF env.creds THEN Caps ELSE Caps \ {"sasl"}

\* The world in which a login must succeed.
GoodWorld == ~env.eager /\ env.timely /\ env.creds /\ "sasl" \in env.offered /\ "sasl" \notin env.refuse
             /\ env.svcUp /\ env.pwOk

Init ==
    /\ env \in Envs
    /\ env.refuse \subseteq env.offered
    /\ c2s = << Msg("CAPLS"), Msg("NICK"), Msg("USER") >>   \* onOpen()
    /\ s2c = << >> /\ svcIn = << >> /\ svcOut = << >>
    /\ cAvail = {} /\ cEnabled = {} /\ cOut = {} /\ cLs = FALSE
    /\ cEnded = FALSE /\ cPendEnd = FALSE /\ cRetried = {}
    /\ sasl = "none" /\ saslOk = FALSE /\ timer = FALSE /\ welcomed = FALSE
    /\ cQuit = FALSE /\ cEndSent = 0 /\ cSaslStarts = 0
    /\ sActive = {} /\ capPending = FALSE /\ nickSet = FALSE /\ userSet = FALSE
    /\ saslPending = FALSE /\ cookie = 0 /\ nextCookie = 1
    /\ saslComplete = FALSE /\ account = FALSE /\ registered = FALSE
    /\ sClosed = FALSE /\ regDuringSasl = FALSE
    /\ outcome = "none"
    /\ sent = c2s /\ got = << >> /\ svcNo = FALSE

Quiet == c2s = << >> /\ s2c = << >> /\ svcIn = << >> /\ svcOut = << >>

----------------------------------------------------------------------------
(***************************************************************************)
(* Seance.  Each step consumes one server line and appends what the code   *)
(* would send, in order.  Once QUIT is sent nothing else goes out.         *)
(***************************************************************************)

\* client.ts saslFailed(): TRUE when it dropped the connection.
FailDrops == env.required

\* caps.end() after saslProgress: CAP END once, preceded by nothing we model.
EndLines(ended) == IF ended THEN << >> ELSE << Msg("CAPEND") >>

\* startSasl() as the beforeEnd hook; returns [lines, phase, pendEnd, quit]
\* given the enabled/outstanding sets at the time.  It opens only once sasl
\* is ACKed: pipelineEnd holds it back while sasl is outstanding.
StartSasl(en, out) ==
    IF "sasl" \in en
    THEN [lines |-> << Msg("AUTH") >>, phase |-> "challenge", pend |-> TRUE, quit |-> FALSE]
    ELSE [lines |-> << >>, phase |-> "none", pend |-> FALSE, quit |-> FailDrops]

\* How a cause-"unavailable" failure leaves (no usable sasl, a NAK): retried
\* for a trusted login, final otherwise (client.ts saslRetries).
Unavail == IF env.trusted THEN "retry" ELSE "rejected"

\* Shared tail of onLs's pipelineEnd and maybeEnd.
\* Returns [lines, ended, pend, phase, timer, quit].
EndOrSasl(en, out) ==
    IF env.creds
    THEN LET s == StartSasl(en, out) IN
         IF s.pend
         THEN [lines |-> s.lines, ended |-> FALSE, pend |-> TRUE,
               phase |-> "challenge", timer |-> TRUE, quit |-> FALSE]
         ELSE [lines |-> IF s.quit THEN << Msg("QUIT") >> ELSE << Msg("CAPEND") >>,
               ended |-> TRUE, pend |-> FALSE, phase |-> "none", timer |-> FALSE,
               quit |-> s.quit]
    ELSE [lines |-> << Msg("CAPEND") >>, ended |-> TRUE, pend |-> FALSE,
          phase |-> "none", timer |-> FALSE, quit |-> FALSE]

CountEnd(lines) == Len(SelectSeq(lines, LAMBDA m : m.t = "CAPEND"))
CountAuth(lines) == Len(SelectSeq(lines, LAMBDA m : m.t = "AUTH"))

\* Send what the client produced, respecting "nothing after QUIT".
ClientSend(lines) ==
    /\ c2s' = IF cQuit THEN c2s ELSE c2s \o lines
    /\ cEndSent' = IF cQuit THEN cEndSent ELSE cEndSent + CountEnd(lines)
    /\ cSaslStarts' = IF cQuit THEN cSaslStarts ELSE cSaslStarts + CountAuth(lines)
    /\ sent' = IF cQuit THEN sent ELSE sent \o lines

\* SASL finished (saslProgress with done): ok or not, then caps.end().
\* fail with required => QUIT and stop.  saslFailed() tells the two apart by
\* `timedOut` (Seance's own timer, or a transient 904): a timeout reconnects
\* (transport.abandon), anything else is a refusal that also turns the
\* network's autoconnect off (onSaslRejected).
SaslFinish(ok, extra, timedOut) ==
    LET quit == ~ok /\ FailDrops
        lines == extra \o (IF quit THEN << Msg("QUIT") >> ELSE EndLines(cEnded))
    IN /\ ClientSend(lines)
       /\ sasl' = "none" /\ timer' = FALSE
       /\ saslOk' = ok
       /\ cEnded' = (cEnded \/ ~quit)
       /\ cPendEnd' = (cPendEnd /\ quit)
       /\ cQuit' = (cQuit \/ quit)
       /\ outcome' = IF quit THEN (IF timedOut THEN "retry" ELSE "rejected") ELSE outcome

CRecvLS(m) ==
    LET avail == m.caps
        desired == {c \in Wanted \cap avail : c \notin cEnabled /\ c \notin cOut}
        req == IF desired = {} THEN << >> ELSE << MsgS("REQ", desired) >>
        out == cOut \cup desired
        \* pipelineEnd: with sasl in the REQ, wait for the replies (maybeEnd)
        e == IF env.creds /\ "sasl" \in out
             THEN [lines |-> << >>, ended |-> cEnded, pend |-> cPendEnd,
                   phase |-> sasl, timer |-> TRUE, quit |-> FALSE]   \* onHold
             ELSE EndOrSasl(cEnabled, out)
    IN /\ cAvail' = avail /\ cLs' = TRUE /\ cOut' = out
       \* handlers/cap.ts stops sending result.send once saslFailed() quit
       \* (cEnded here only for the eager client: it already sent CAP END)
       /\ ClientSend(IF e.quit THEN e.lines
                     ELSE req \o (IF cEnded THEN SelectSeq(e.lines, LAMBDA x : x.t # "CAPEND")
                                  ELSE e.lines))
       /\ cEnded' = (cEnded \/ e.ended) /\ cPendEnd' = e.pend /\ sasl' = e.phase
       /\ timer' = e.timer /\ cQuit' = (cQuit \/ e.quit)
       /\ outcome' = IF e.quit THEN Unavail ELSE outcome
       /\ UNCHANGED <<cEnabled, cRetried, saslOk, welcomed>>

\* maybeEnd(): only once LS is complete, nothing outstanding, not ended/pending.
MaybeEnd(en, out) ==
    IF cEnded \/ cPendEnd \/ ~cLs \/ out # {} THEN
        [lines |-> << >>, ended |-> cEnded, pend |-> cPendEnd, phase |-> sasl,
         timer |-> timer, quit |-> FALSE]
    ELSE EndOrSasl(en, out)

CRecvACK(m) ==
    LET en == cEnabled \cup m.caps
        out == cOut \ m.caps
        e == MaybeEnd(en, out)
    IN /\ cEnabled' = en /\ cOut' = out
       /\ ClientSend(e.lines)
       /\ cEnded' = e.ended /\ cPendEnd' = e.pend /\ sasl' = e.phase
       /\ timer' = e.timer /\ cQuit' = (cQuit \/ e.quit)
       /\ outcome' = IF e.quit THEN Unavail ELSE outcome
       /\ UNCHANGED <<cAvail, cLs, cRetried, saslOk, welcomed>>

\* onNak + maybeEnd + handlers/cap.ts (abortSasl when "sasl" is in naked).
CRecvNAK(m) ==
    LET multi == Cardinality(m.caps) > 1
        retry == IF multi THEN {c \in m.caps : c \in cAvail /\ c \notin cRetried} ELSE {}
        naked == m.caps \ retry
        out == (cOut \ m.caps) \cup retry
        reqs == [i \in 1..Len(SeqOf(retry)) |-> MsgS("REQ", {SeqOf(retry)[i]})]
        e == MaybeEnd(cEnabled, out)
        abort == "sasl" \in naked /\ sasl \in {"challenge", "result"}
        quit == abort /\ FailDrops
        abortLines == IF abort
                      THEN << Msg("AUTHABORT") >> \o
                           (IF quit THEN << Msg("QUIT") >>
                            ELSE IF e.ended THEN << >> ELSE << Msg("CAPEND") >>)
                      ELSE << >>
    IN /\ cOut' = out /\ cRetried' = cRetried \cup retry
       /\ ClientSend(IF e.quit THEN e.lines ELSE reqs \o e.lines \o abortLines)
       /\ cEnded' = IF abort THEN ~quit \/ e.ended ELSE e.ended
       \* saslFailed() returning true skips caps.end(), so pendingEnd stays
       /\ cPendEnd' = IF abort THEN quit ELSE e.pend
       /\ sasl' = IF abort THEN "none" ELSE e.phase
       /\ timer' = IF abort THEN FALSE ELSE e.timer
       /\ saslOk' = IF abort THEN FALSE ELSE saslOk
       /\ cQuit' = (cQuit \/ e.quit \/ quit)
       /\ outcome' = IF e.quit \/ quit THEN Unavail ELSE outcome
       /\ UNCHANGED <<cAvail, cEnabled, cLs, welcomed>>

CRecvAuthPlus ==
    IF sasl = "challenge"
    THEN /\ ClientSend(<< Msg("AUTHDATA") >>) /\ sasl' = "result" /\ timer' = TRUE
         /\ UNCHANGED <<cAvail, cEnabled, cOut, cLs, cEnded, cPendEnd, cRetried, saslOk, welcomed, cQuit, outcome>>
    ELSE UNCHANGED <<c2s, cEndSent, cSaslStarts, sent>> /\ UNCHANGED cvars

\* 903 / 904 / 906 / 907: fed to the exchange if one is running, else lobby text.
\* `transient`: whether saslFailed retries (cause "server": a 904 whose text
\* names an outage, "904T", or a 906 the server sent on its own; or a
\* trusted login's "unexplained" bare 904) instead of counting a refusal.
CRecvResult(ok, transient) ==
    IF sasl # "none"
    THEN /\ SaslFinish(ok, << >>, transient)
         /\ UNCHANGED <<cAvail, cEnabled, cOut, cLs, cRetried, welcomed>>
    ELSE UNCHANGED <<c2s, cEndSent, cSaslStarts, sent>> /\ UNCHANGED cvars

ClientRecv ==
    /\ s2c # << >> /\ ~cQuit
    /\ LET m == Head(s2c) IN
       /\ s2c' = Tail(s2c)
       /\ got' = Append(got, [m |-> m, at |-> Len(sent)])
       /\ CASE m.t = "LS"   -> CRecvLS(m)
            [] m.t = "ACK"  -> CRecvACK(m)
            [] m.t = "NAK"  -> CRecvNAK(m)
            [] m.t = "AUTH+" -> CRecvAuthPlus
            [] m.t = "903"  -> CRecvResult(TRUE, FALSE)
            [] m.t = "904T" -> CRecvResult(FALSE, TRUE)
            \* a bare 904 is "unexplained": a trusted login retries it (the first
            \* of SASL_TRUSTED_RETRIES; one connection here)
            [] m.t = "904"  -> CRecvResult(FALSE, env.trusted)
            [] m.t = "906"  -> CRecvResult(FALSE, TRUE)
            [] m.t = "907"  -> CRecvResult(FALSE, FALSE)
            [] m.t = "001"  -> welcomed' = TRUE
                               /\ UNCHANGED <<c2s, cEndSent, cSaslStarts, sent>>
                               /\ UNCHANGED <<cAvail, cEnabled, cOut, cLs, cEnded, cPendEnd, cRetried, sasl, saslOk, timer, cQuit, outcome>>
            [] OTHER        -> UNCHANGED <<c2s, cEndSent, cSaslStarts, sent>> /\ UNCHANGED cvars
    /\ UNCHANGED <<env, svcIn, svcOut, svcNo>> /\ UNCHANGED svars

\* Seance's 12 s timer (armSaslTimer).  In a timely world it fires only when
\* the protocol is stuck, and after the server's 10 s one (which starts a
\* round trip later); otherwise at any moment.
\* With nothing opened yet (waiting for the sasl ACK) there is nothing to
\* abort: it fails as a timeout and ends CAP.
ClientSaslTimer ==
    /\ timer /\ ~cQuit /\ (sasl # "none" \/ ~cEnded)
    /\ ~env.timely \/ (Quiet /\ cookie = 0)
    \* sasl already NAKed while another reply is missing: that NAK is the
    \* answer (cause unavailable), not a slow server
    /\ LET settled == sasl = "none" /\ "sasl" \notin cOut /\ "sasl" \notin cEnabled IN
       SaslFinish(FALSE, IF sasl # "none" THEN << Msg("AUTHABORT") >> ELSE << >>,
                  ~settled \/ env.trusted)
    /\ got' = Append(got, [m |-> Msg("TIMER"), at |-> Len(sent)])
    /\ UNCHANGED <<s2c, env, svcIn, svcOut, cAvail, cEnabled, cOut, cLs, cRetried, welcomed, svcNo>>
    /\ UNCHANGED svars

\* A pipelining client (not Seance) sends CAP END whenever it likes, e.g.
\* right behind its AUTHENTICATE lines.  Seance's own end() then sends nothing.
EagerCapEnd ==
    /\ env.eager /\ ~cEnded /\ ~cQuit
    /\ ClientSend(<< Msg("CAPEND") >>) /\ cEnded' = TRUE
    /\ UNCHANGED <<env, s2c, svcIn, svcOut, cAvail, cEnabled, cOut, cLs, cPendEnd, cRetried, sasl, saslOk, timer, welcomed, cQuit, outcome, got, svcNo>>
    /\ UNCHANGED svars


----------------------------------------------------------------------------
(***************************************************************************)
(* nefarious2.                                                             *)
(***************************************************************************)

\* check_auth_finished(): no hold from 0..AR_LAST_SCAN left, so register.
\* auth_complete_sasl() gives the account a completed SASL proved.
CanReg(n, u, cp, sp) == ~registered /\ n /\ u /\ ~cp /\ ~sp
RegOut(c) == IF c THEN << Msg("001") >> ELSE << >>
\* c: registers in this step; sc: saslComplete after it; ck: cookie after it.
RegVars(c, sc, ck) ==
    /\ registered' = (registered \/ c)
    /\ account' = (account \/ (c /\ sc))
    /\ regDuringSasl' = (regDuringSasl \/ (c /\ ck # 0))
NoReg == UNCHANGED <<account, registered, regDuringSasl>>

SUnchangedSasl == UNCHANGED <<saslPending, cookie, nextCookie, saslComplete>>

SRecvAuth(m) ==
    IF "sasl" \notin sActive THEN                     \* !CapActive(CAP_SASL): dropped
        /\ s2c' = s2c /\ svcIn' = svcIn
        /\ SUnchangedSasl /\ NoReg
    ELSE IF m.t = "AUTHABORT" THEN
        IF cookie # 0 /\ ~saslComplete
        THEN \* abort_sasl(cptr, 0): 906, D A to the agent, then auth_sasl_done
             LET c == CanReg(nickSet, userSet, capPending, FALSE)
             IN /\ cookie' = 0 /\ saslPending' = FALSE
                /\ UNCHANGED <<nextCookie, saslComplete>>
                /\ svcIn' = Append(svcIn, [t |-> "DA", ck |-> cookie])
                /\ s2c' = s2c \o << Msg("906") >> \o RegOut(c)
                /\ RegVars(c, saslComplete, 0)
        ELSE /\ s2c' = s2c /\ svcIn' = svcIn
             /\ SUnchangedSasl /\ NoReg
    ELSE IF cookie = 0 /\ (saslComplete \/ account) THEN   \* ERR_SASLALREADY
        /\ s2c' = Append(s2c, Msg("907")) /\ svcIn' = svcIn
        /\ SUnchangedSasl /\ NoReg
    ELSE IF cookie = 0 THEN                           \* new exchange: S to the agent
        IF nextCookie > MaxCookie THEN FALSE
        ELSE /\ cookie' = nextCookie /\ nextCookie' = nextCookie + 1
             /\ saslPending' = ~registered               \* auth_sasl_start
             /\ svcIn' = Append(svcIn, [t |-> "S", ck |-> nextCookie])
             /\ s2c' = s2c /\ UNCHANGED <<saslComplete, account, registered, regDuringSasl>>
    ELSE                                              \* C data to the agent
        /\ svcIn' = Append(svcIn, [t |-> "C", ck |-> cookie])
        /\ s2c' = s2c /\ SUnchangedSasl /\ NoReg

ServerRecv ==
    /\ c2s # << >> /\ ~sClosed
    /\ LET m == Head(c2s) IN
       /\ c2s' = Tail(c2s)
       /\ CASE m.t = "CAPLS" ->
                 /\ capPending' = (capPending \/ ~registered)
                 /\ s2c' = Append(s2c, MsgS("LS", env.offered))
                 /\ UNCHANGED <<sActive, nickSet, userSet, account, registered, sClosed, regDuringSasl, svcIn>>
                 /\ SUnchangedSasl
            [] m.t = "NICK" ->
                 LET c == CanReg(TRUE, userSet, capPending, saslPending) IN
                 /\ nickSet' = TRUE /\ s2c' = s2c \o RegOut(c) /\ RegVars(c, saslComplete, cookie)
                 /\ UNCHANGED <<sActive, capPending, userSet, sClosed, svcIn>>
                 /\ SUnchangedSasl
            [] m.t = "USER" ->
                 LET c == CanReg(nickSet, TRUE, capPending, saslPending) IN
                 /\ userSet' = TRUE /\ s2c' = s2c \o RegOut(c) /\ RegVars(c, saslComplete, cookie)
                 /\ UNCHANGED <<sActive, capPending, nickSet, sClosed, svcIn>>
                 /\ SUnchangedSasl
            [] m.t = "REQ" ->                         \* all or nothing
                 /\ capPending' = (capPending \/ ~registered)
                 /\ IF m.caps \cap env.refuse # {}
                    THEN s2c' = Append(s2c, MsgS("NAK", m.caps)) /\ sActive' = sActive
                    ELSE s2c' = Append(s2c, MsgS("ACK", m.caps)) /\ sActive' = sActive \cup m.caps
                 /\ UNCHANGED <<nickSet, userSet, account, registered, sClosed, regDuringSasl, svcIn>>
                 /\ SUnchangedSasl
            [] m.t \in {"AUTH", "AUTHDATA", "AUTHABORT"} ->
                 /\ SRecvAuth(m)
                 /\ UNCHANGED <<sActive, capPending, nickSet, userSet, sClosed>>
            [] m.t = "CAPEND" ->                      \* cap_end -> auth_cap_done
                 IF registered
                 THEN UNCHANGED <<s2c, capPending, account, registered, regDuringSasl>>
                      /\ UNCHANGED <<sActive, nickSet, userSet, sClosed, svcIn>> /\ SUnchangedSasl
                 ELSE LET c == CanReg(nickSet, userSet, FALSE, saslPending) IN
                      /\ capPending' = FALSE /\ s2c' = s2c \o RegOut(c) /\ RegVars(c, saslComplete, cookie)
                      /\ UNCHANGED <<sActive, nickSet, userSet, sClosed, svcIn>>
                      /\ SUnchangedSasl
            [] m.t = "QUIT" ->
                 /\ sClosed' = TRUE /\ s2c' = s2c
                 /\ UNCHANGED <<sActive, capPending, nickSet, userSet, account, registered, regDuringSasl, svcIn>>
                 /\ SUnchangedSasl
    /\ UNCHANGED <<env, svcOut>> /\ UNCHANGED cvars
    /\ UNCHANGED hist

\* Replies from the agent (m_sasl.c), matched on the cookie.
ServerSvc ==
    /\ svcOut # << >> /\ ~sClosed
    /\ LET r == Head(svcOut) IN
       /\ svcOut' = Tail(svcOut)
       /\ IF r.ck # cookie \/ cookie = 0 THEN
             UNCHANGED <<s2c, account, registered, regDuringSasl>> /\ SUnchangedSasl
          ELSE CASE r.t = "C" ->
                      s2c' = Append(s2c, Msg("AUTH+"))
                      /\ NoReg /\ SUnchangedSasl
                 [] r.t = "DS" ->                    \* sasl_complete_login, then auth_sasl_done
                      LET c == CanReg(nickSet, userSet, capPending, FALSE) IN
                      /\ saslComplete' = TRUE /\ cookie' = 0 /\ saslPending' = FALSE
                      /\ nextCookie' = nextCookie
                      /\ s2c' = s2c \o << Msg("900"), Msg("903") >> \o RegOut(c)
                      /\ registered' = (registered \/ c)
                      /\ account' = (account \/ registered \/ c)
                      /\ regDuringSasl' = regDuringSasl
                 [] r.t = "DF" ->
                      LET c == CanReg(nickSet, userSet, capPending, FALSE) IN
                      /\ cookie' = 0 /\ saslPending' = FALSE
                      /\ UNCHANGED <<nextCookie, saslComplete>>
                      /\ s2c' = s2c \o << Msg("904") >> \o RegOut(c)
                      /\ RegVars(c, saslComplete, 0)
    /\ UNCHANGED <<env, c2s, svcIn, sActive, capPending, nickSet, userSet, sClosed>>
    /\ UNCHANGED cvars
    /\ UNCHANGED hist

\* The services link splits with an exchange open (list.c exit path):
\* abort_sasl(cptr, 0) sends 906 and the registration hold is dropped.
ServerAgentLost ==
    /\ cookie # 0 /\ ~sClosed /\ ~env.svcUp /\ (~env.timely \/ Quiet)
    /\ LET c == CanReg(nickSet, userSet, capPending, FALSE) IN
       /\ cookie' = 0 /\ saslPending' = FALSE
       /\ UNCHANGED <<nextCookie, saslComplete>>
       /\ s2c' = s2c \o << Msg("906") >> \o RegOut(c)
       /\ RegVars(c, saslComplete, 0)
    /\ UNCHANGED <<env, c2s, svcIn, svcOut, sActive, capPending, nickSet, userSet, sClosed>>
    /\ UNCHANGED cvars
    /\ UNCHANGED hist

\* sasl_timeout_callback: abort_sasl(cptr, 1) then auth_sasl_done.  The 904
\* says ": request timed out" (m_sasl.c, sasl_auth.c); "904T" stands for it.
ServerSaslTimeout ==
    /\ cookie # 0 /\ ~sClosed /\ (~env.timely \/ Quiet)
    /\ LET c == CanReg(nickSet, userSet, capPending, FALSE) IN
       /\ cookie' = 0 /\ saslPending' = FALSE
       /\ UNCHANGED <<nextCookie, saslComplete>>
       /\ svcIn' = Append(svcIn, [t |-> "DA", ck |-> cookie])
       /\ s2c' = s2c \o << Msg("904T") >> \o RegOut(c)
       /\ RegVars(c, saslComplete, 0)
    /\ UNCHANGED <<env, c2s, svcOut, sActive, capPending, nickSet, userSet, sClosed>>
    /\ UNCHANGED cvars
    /\ UNCHANGED hist

\* auth_ping_timeout: a user-controlled hold (CAP, SASL, NICK, USER) is left.
ServerRegTimeout ==
    /\ ~registered /\ ~sClosed /\ (~env.timely \/ (Quiet /\ cookie = 0 /\ ~timer))
    /\ sClosed' = TRUE
    /\ UNCHANGED <<env, c2s, s2c, svcIn, svcOut, sActive, capPending, nickSet, userSet, saslPending, cookie, nextCookie, saslComplete, account, registered, regDuringSasl>>
    /\ UNCHANGED cvars
    /\ UNCHANGED hist

----------------------------------------------------------------------------
(* Services (X3) *)
Services ==
    /\ svcIn # << >>
    /\ LET q == Head(svcIn) IN
       /\ svcIn' = Tail(svcIn)
       /\ svcOut' = IF ~env.svcUp \/ q.t = "DA" THEN svcOut
                    ELSE IF q.t = "S" THEN Append(svcOut, [t |-> "C", ck |-> q.ck])
                    ELSE Append(svcOut, [t |-> IF env.pwOk THEN "DS" ELSE "DF", ck |-> q.ck])
    /\ svcNo' = (svcNo \/ (env.svcUp /\ ~env.pwOk /\ Head(svcIn).t = "C"))
    /\ UNCHANGED <<env, c2s, s2c, sent, got>> /\ UNCHANGED cvars /\ UNCHANGED svars

----------------------------------------------------------------------------
Done == (welcomed /\ Quiet) \/ cQuit \/ sClosed

Next ==
    \/ ClientRecv \/ ClientSaslTimer \/ EagerCapEnd
    \/ ServerRecv \/ ServerSvc \/ ServerSaslTimeout \/ ServerAgentLost \/ ServerRegTimeout
    \/ Services
    \/ (Done /\ UNCHANGED vars)

Fairness ==
    /\ WF_vars(ClientRecv) /\ WF_vars(ServerRecv) /\ WF_vars(ServerSvc)
    /\ WF_vars(Services) /\ WF_vars(ClientSaslTimer)
    /\ WF_vars(ServerSaslTimeout) /\ WF_vars(ServerRegTimeout)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
    /\ sasl \in {"none", "challenge", "result"}
    /\ cEndSent \in 0..3
    /\ outcome \in {"none", "rejected", "retry"}

\* S1: the gate never registers a client with a SASL exchange open.
NoRegisterDuringSasl == ~regDuringSasl

\* S3: CAP END at most once.
\* Not a spec rule: a REQ sent after CAP END but before 001 suspends
\* registration again until another END (capability-negotiation, and
\* nefarious2's cap_req).  It holds here because nothing makes Seance REQ
\* in that window: nefarious2 sends CAP NEW only to registered clients.
CapEndOnce == cEndSent <= 1

\* S4: once settled, both sides agree on the enabled caps ...
CapsAgree == (welcomed /\ Quiet) => cEnabled = sActive

\* S5: ... and on whether we are logged in.
AccountAgrees == (welcomed /\ Quiet /\ ~env.eager) => (saslOk = account)

\* S6: in a world where login can succeed, the client is logged in at 001.
LoggedInWhenPossible == (registered /\ GoodWorld) => account

\* AccountAgrees as it holds today.  It fails when Seance's own timer runs
\* out while services still hold the credentials: the server logs in
\* (900/903 after our AUTHENTICATE *) and Seance has given up.  Only an
\* untimely world lets Seance's 12 s timer beat the server's 10 s one.
\* (README, "Findings".)
AccountAgreesTimely == env.timely => AccountAgrees

\* A login that has worked here never turns the network's autoconnect off.
\* Only the first connection of a trusted login is modelled (trust and the
\* retry count never change here), and 902/905, which forget trust on
\* purpose, are never sent; test/irc/client-sasl.ts covers the lifecycle.
TrustedKeepsNetwork == env.trusted => outcome # "rejected"

\* S7: Seance sends the SASL opener at most once per connection.
OneOpener == cSaslStarts <= 1

\* S8: Seance turns a network's autoconnect off only when the login really
\* cannot succeed: services refused the password, or the server has no
\* usable sasl.  A slow or absent services agent is not a refusal.
NoFalseRejection ==
    outcome = "rejected" => (svcNo \/ "sasl" \notin env.offered \/ "sasl" \in env.refuse)

\* L1: the handshake always ends: 001, or the connection is closed.
Terminates == <>(welcomed \/ cQuit \/ sClosed)

\* L2: in a good world it ends in 001 (no needless reconnect).
WelcomedWhenPossible == GoodWorld ~> welcomed
=============================================================================
