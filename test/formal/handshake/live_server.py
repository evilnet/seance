#!/usr/bin/env python3
"""Server-side conformance: replay the model's behaviours against a live
nefarious2 and check its replies are the model's server replies.

For each behaviour TLC dumped (one JSON line per settled behaviour, from
`MBT.cfg`), this plays the model's Seance: it sends the model's client
lines at the points the model sent them, and after each step compares what
the real ircd sent back, reduced to the model's vocabulary (CAP LS/ACK/NAK,
AUTHENTICATE +, 900/903/904/906/907, 001), with what the model's server
sent.

Environment mapping:
  offered:  the ircd advertises `sasl` only while a services server is
            linked; behaviours without `sasl` offered are run with the fake
            services link down, the others with it up.
  refuse:   a REQ names a cap the ircd does not know in place of each
            refused cap, so the ircd NAKs it as the model's server does.
  svcUp:    behaviours with services down run in a pass where the fake
            services are linked but never answer SASL (--svc-down).
  pwOk:     the fake services accept the password `good` only.

Usage: live_server.py traces.jsonl [--no-sasl | --svc-down] [-j N]
Needs the ircd from README.md on 127.0.0.1:16667 (client) and :14400
(server port, Connect block for svc.example.net, password pw,
SASL_TIMEOUT 2).
"""
import base64, json, socket, sys, threading, time, argparse
from concurrent.futures import ThreadPoolExecutor

CLIENT_PORT, SERVER_PORT = 16667, 14400
CAP = {"x": "server-time", "y": "message-tags", "sasl": "sasl"}
SETTLE = 0.6          # seconds of silence that count as "nothing more is coming"
SASL_TIMEOUT = 2      # the ircd's SASL_TIMEOUT feature in the test config


class Lines:
    def __init__(self, sock):
        self.s, self.buf, self.lines, self.lock = sock, b"", [], threading.Condition()
        self.closed = False
        threading.Thread(target=self._rd, daemon=True).start()

    def _rd(self):
        while True:
            try:
                d = self.s.recv(65536)
            except OSError:
                d = b""
            if not d:
                with self.lock:
                    self.closed = True
                    self.lock.notify_all()
                return
            self.buf += d
            while b"\n" in self.buf:
                l, self.buf = self.buf.split(b"\n", 1)
                l = l.rstrip(b"\r").decode(errors="replace")
                self.on(l)
                with self.lock:
                    self.lines.append(l)
                    self.lock.notify_all()

    def on(self, l):
        if l.startswith("PING "):
            self.send("PONG " + l[5:])

    def send(self, l):
        try:
            self.s.sendall((l + "\r\n").encode())
        except OSError:
            pass


class Services(Lines):
    """A P10 server that answers SASL like X3 (or stays silent)."""

    def __init__(self, silent):
        self.silent = silent
        super().__init__(socket.create_connection(("127.0.0.1", SERVER_PORT)))
        t = int(time.time())
        self.send("PASS :pw")
        self.send(f"SERVER svc.example.net 1 {t} {t} J10 SV]]] +s6 :svc")
        self.send("SV EB")
        self.accounts = {}

    def on(self, l):
        p = l.split(" ")
        if len(p) > 1 and p[1] == "G":
            self.send("SV Z " + " ".join(p[2:]))
        if len(p) > 1 and p[1] == "EB":
            self.send("SV EA")
        if len(p) > 4 and p[1] == "SASL" and not self.silent:
            tok, sub = p[3], p[4]
            srv = tok.split("!")[0]
            if sub == "S":
                self.send(f"SV SASL {srv} {tok} C +")
            elif sub == "C":
                parts = base64.b64decode(p[5]).split(b"\0")
                acct, pw = parts[1].decode(), parts[2].decode()
                if pw == "good":
                    self.send(f"SV SASL {srv} {tok} L {acct} {int(time.time())}")
                    self.send(f"SV SASL {srv} {tok} D S")
                else:
                    self.send(f"SV SASL {srv} {tok} D F")
            # D A: nothing


def model_of(line, nick):
    """The ircd's line in the model's vocabulary, or None."""
    p = line.split(" ")
    if p[0].startswith("@"):
        p = p[1:]
    if p and p[0].startswith(":"):
        p = p[1:]
    if not p:
        return None
    cmd = p[0]
    if cmd == "CAP" and len(p) > 2:
        sub = p[2]
        if sub == "LS":
            return None if p[3] == "*" else "LS"        # continuation lines collapse to one
        if sub in ("ACK", "NAK"):
            names = " ".join(p[3:]).lstrip(":").split()
            inv = {v: k for k, v in CAP.items()}
            caps = sorted(inv.get(n, "refused:" + n) for n in names)
            return f"{sub}({','.join(caps)})"
        return None
    if cmd == "AUTHENTICATE" and p[1:] == ["+"]:
        return "AUTH+"
    if cmd == "904" and "timed out" in line:
        return "904T"
    if cmd in ("900", "903", "904", "906", "907", "001"):
        return cmd
    return None


def show(m, refuse):
    if "caps" in m:
        if m["t"] in ("ACK", "NAK"):
            caps = sorted(c if c not in refuse else "refused:zz-" + c for c in m["caps"])
            return f"{m['t']}({','.join(caps)})"
        return m["t"]
    return m["t"]


def client_line(m, nick, acct, pw, refuse):
    t = m["t"]
    if t == "CAPLS":
        return "CAP LS 302"
    if t == "NICK":
        return f"NICK {nick}"
    if t == "USER":
        return f"USER u 0 * :{nick}"
    if t == "REQ":
        order = ["x", "y", "sasl"]
        return "CAP REQ :" + " ".join(("zz-" + c) if c in refuse else CAP[c]
                                       for c in order if c in m["caps"])
    if t == "AUTH":
        return "AUTHENTICATE PLAIN"
    if t == "AUTHDATA":
        return "AUTHENTICATE " + base64.b64encode(f"{acct}\0{acct}\0{pw}".encode()).decode()
    if t == "AUTHABORT":
        return "AUTHENTICATE *"
    if t == "CAPEND":
        return "CAP END"
    if t == "QUIT":
        return "QUIT :bye"
    raise ValueError(t)


def run(trace, idx):
    env = trace["env"]
    refuse = set(env["refuse"])
    nick = f"m{idx}"
    acct = ("up" if env["svcUp"] else "dn") + str(idx)
    pw = "good" if env["pwOk"] else "bad"
    conn = Lines(socket.create_connection(("127.0.0.1", CLIENT_PORT)))
    expected = [show(g["m"], refuse) for g in trace["got"] if g["m"]["t"] != "TIMER"]
    expected += [show(m, refuse) for m in trace.get("rest", [])]
    sent = 0

    def got():
        with conn.lock:
            return [x for x in (model_of(l, nick) for l in conn.lines) if x]

    def wait_for(n, timeout):
        end = time.time() + timeout
        with conn.lock:
            while time.time() < end and not conn.closed:
                if len([x for x in (model_of(l, nick) for l in conn.lines) if x]) >= n:
                    return True
                conn.lock.wait(0.05)
        return False

    def send_upto(k):
        nonlocal sent
        while sent < k:
            conn.send(client_line(trace["sent"][sent], nick, acct, pw, refuse))
            sent += 1

    n = 0
    for g in trace["got"]:
        send_upto(g["at"])
        if g["m"]["t"] == "TIMER":
            # Seance's 12 s timer: the ircd's own (2 s here) has long fired.
            time.sleep(SASL_TIMEOUT + 0.5)
            continue
        n += 1
        if not wait_for(n, SASL_TIMEOUT + 3):
            break
    send_upto(len(trace["sent"]))
    time.sleep(SETTLE)
    actual = got()
    try:
        conn.send("QUIT :done")
        conn.s.close()
    except OSError:
        pass
    return expected, actual


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("traces")
    ap.add_argument("--no-sasl", action="store_true",
                    help="run the behaviours without sasl offered (services link down)")
    ap.add_argument("--svc-down", action="store_true",
                    help="run the behaviours with services down (linked, silent)")
    ap.add_argument("-j", type=int, default=16)
    a = ap.parse_args()
    traces, seen = [], set()
    for line in open(a.traces):
        t = json.loads(json.loads(line))
        if ("sasl" in t["env"]["offered"]) == a.no_sasl:
            continue
        if not a.no_sasl and t["env"]["svcUp"] == a.svc_down:
            continue
        # an untimely world fires timers mid-exchange, which wall-clock
        # sleeps cannot place; the timely ones cover every server path
        if not t["env"]["timely"]:
            continue
        # an ident/DNS hold (env.hold) cannot be stretched on demand either
        if t["env"].get("hold"):
            continue
        # a services split mid-exchange (ServerAgentLost) cannot be staged
        # with one fake services link; its 906 is the only one not answering
        # our own AUTHENTICATE *
        if (any(g["m"]["t"] == "906" for g in t["got"])
                and not any(m["t"] == "AUTHABORT" for m in t["sent"])):
            continue
        # the real ircd always offers x and y; behaviours without them add nothing
        if not {"x", "y"} <= set(t["env"]["offered"]):
            continue
        k = json.dumps(t, sort_keys=True)
        if k not in seen:
            seen.add(k)
            traces.append(t)
    svc = None if a.no_sasl else Services(a.svc_down)
    time.sleep(1.5)
    fails = 0
    with ThreadPoolExecutor(a.j) as ex:
        results = list(ex.map(lambda it: run(it[1], it[0]), enumerate(traces)))
    for t, (exp, act) in zip(traces, results):
        if exp != act:
            fails += 1
            e = t["env"]
            print(f"MISMATCH env refuse={e['refuse']} svcUp={e['svcUp']} pwOk={e['pwOk']}"
                  f" creds={e['creds']} required={e['required']}")
            print("  client sent:", " ".join(m["t"] for m in t["sent"]))
            print("  model     :", " ".join(exp))
            print("  nefarious2:", " ".join(act))
    print(f"{len(traces) - fails} of {len(traces)} behaviours match")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
