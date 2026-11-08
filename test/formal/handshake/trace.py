"""Print a TLC JSON trace as the lines on the wire plus key state changes."""
import json, sys
t = json.load(open(sys.argv[1]))
t = t.get("counterexample", t)
states = [x[1] for x in t["state"]]
prev = None
for i, st in enumerate(states):
    s = st
    if prev is None:
        print("env:", s["env"]); prev = s; continue
    diffs = {k: v for k, v in s.items() if prev.get(k) != v and k not in ("c2s","s2c","svcIn","svcOut")}
    def newmsgs(k):
        a, b = prev[k], s[k]
        return b[len(a):] if b[:len(a)] == a else b if len(b) >= len(a) else []
    def fmt(m): return m["t"] + ("(" + ",".join(sorted(m["caps"])) + ")" if "caps" in m else "")
    out = []
    if len(s["c2s"]) < len(prev["c2s"]) or (prev["c2s"] and s["c2s"][:1] != prev["c2s"][:1]): out.append("server reads " + fmt(prev["c2s"][0]))
    if len(s["s2c"]) < len(prev["s2c"]) or (prev["s2c"] and s["s2c"][:1] != prev["s2c"][:1]): out.append("seance reads " + fmt(prev["s2c"][0]))
    for k, who in (("c2s","seance sends"),("s2c","server sends")):
        a, b = prev[k], s[k]
        # appended = suffix beyond the common tail
        drop = 1 if (a and (len(b) < len(a) or b[:1] != a[:1])) else 0
        rest = a[drop:]
        added = b[len(rest):]
        if added: out.append(who + " " + " ".join(fmt(m) for m in added))
    print(f"{i:2}: " + "; ".join(out) + ("   " + str({k: v for k, v in diffs.items()}) if diffs else ""))
    prev = s
