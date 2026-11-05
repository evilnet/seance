#!/usr/bin/env python3
"""IAuth agent for the Seance dev ircd: SASL PLAIN against one fixed credential.

Nefarious2's IAuth hook spawns this program over stdin/stdout. Wire shape
(ircd -> agent): `<id> <COMMAND> [args...]`, e.g. `<fd> C <remoteip>
<remoteport> <localip> <localport>` on connect, `<fd> A S :PLAIN` when a
client starts SASL, `<fd> a :<base64>` per AUTHENTICATE payload. Replies go
the other way with the command letter glued to the id and the client's
address echoed back (`L<fd> <ip> <port> <account>` — the ircd consumes id,
ip and port before the handler sees the account):

    L<fd> <ip> <port> <account>   logged in (sets the account, sends 900)
    Z<fd> <ip> <port>             SASL complete (sends 903)
    f<fd> <ip> <port> :<reason>   SASL failed (sends ERR_SASLFAIL)

The O line requests the r (account report) and S (SASL handling) policies;
the W line is what makes CAP LS advertise `sasl` when no services link
exists. This exists so the dev rig can exercise the app's SASL paths
(persistence, bouncer, push) without running a services package.
"""
import base64
import os
import sys

# The one credential the rig accepts, and where the wire trace goes. All
# three are environment variables (docs/resources/nefarious2-dev.md): the
# log is written only when IAUTH_DEBUG_LOG names a path, because the agent
# runs for the life of the ircd and its trace carries every SASL exchange.
ACCOUNT = os.environ.get("IAUTH_TEST_USER", "pushtest1")
PASSWORD = os.environ.get("IAUTH_TEST_PASS", "pushtest1-pass")
DEBUG_LOG = os.environ.get("IAUTH_DEBUG_LOG", "")


def out(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main() -> None:
    out("V :seance-iauth 1.0")
    # U: UNDERNET username reports (the ircd sends `U <username>...` and waits
    # for the agent's `U<fd>` verdict — without this every non-SASL
    # registration stalls in the HURRY state); r: account report; S: SASL.
    out("O UrS")
    out("W :PLAIN")

    # fd -> (remote ip, remote port), learned from the C introduction.
    clients: dict[str, tuple[str, str]] = {}

    debug = open(DEBUG_LOG, "a") if DEBUG_LOG else None

    def log(text: str) -> None:
        if debug is None:
            return

        debug.write(text + "\n")
        debug.flush()

    log("=== agent started, pid " + str(os.getpid()))

    for raw in sys.stdin:
        line = raw.rstrip("\n")

        if not line:
            continue

        log("in : " + line)

        parts = line.split(" ")

        # Agent-global lines (V/O/A-config announcements) carry no id.
        if not parts[0].isdigit():
            continue

        fd, cmd = parts[0], parts[1] if len(parts) > 1 else ""

        if cmd == "C" and len(parts) >= 4:
            clients[fd] = (parts[2], parts[3])
            continue

        if cmd == "D":
            clients.pop(fd, None)
            continue

        if cmd == "A":
            # SASL start (`A S :PLAIN`) or abort (`A X`); nothing to do yet.
            continue

        if cmd == "U":
            # The username report (the USER command): the ircd waits for the
            # verdict before it finishes registering — accept it as-is. The
            # reply carries <id> <ip> <port>: without the address the ircd
            # answers "E Missing" and never registers the client. Then the
            # done-checking, which is what actually completes the
            # registration — without it the ircd waits in HURRY forever.
            addr = clients.get(fd, ("0.0.0.0", "0"))
            out(f"U{fd} {addr[0]} {addr[1]}")
            out(f"D{fd} {addr[0]} {addr[1]}")
            continue

        if cmd != "a":
            continue  # hostname lookups, mode reports, config churn…

        b64 = parts[2].lstrip(":") if len(parts) > 2 else ""

        try:
            fields = base64.b64decode(b64, validate=False).split(b"\x00")
            authcid = fields[1].decode("utf-8", "replace") if len(fields) > 1 else ""
            passwd = fields[2].decode("utf-8", "replace") if len(fields) > 2 else ""
        except Exception:
            authcid = passwd = ""

        addr = clients.get(fd, ("0.0.0.0", "0"))

        if authcid == ACCOUNT and passwd == PASSWORD:
            out(f"L{fd} {addr[0]} {addr[1]} {ACCOUNT}")
            out(f"Z{fd} {addr[0]} {addr[1]}")
        else:
            out(f"f{fd} {addr[0]} {addr[1]} :invalid credentials")

        clients.pop(fd, None)


main()
