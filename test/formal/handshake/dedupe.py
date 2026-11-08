"""TLC's Dump lines -> one JSON trace per distinct thing Seance sees.

Usage: python3 dedupe.py traces.jsonl > handshake.traces.json
Only the parts of the world Seance can tell apart are kept (credentials,
whether SASL is required) and how Seance left (outcome); behaviours that differ only in server-side
choices it cannot observe collapse into one."""
import json, sys
seen, out = set(), []
for line in open(sys.argv[1]):
    t = json.loads(json.loads(line))
    if t["env"]["eager"]:
        continue            # not Seance: only the live server pass replays these
    v = {"creds": t["env"]["creds"], "required": t["env"]["required"],
         "trusted": t["env"]["trusted"],
         "got": t["got"], "sent": t["sent"], "outcome": t["outcome"]}
    k = json.dumps(v, sort_keys=True)
    if k not in seen:
        seen.add(k); out.append(v)
json.dump(out, sys.stdout, separators=(",", ":"))
print(f"{len(out)} distinct client views", file=sys.stderr)
