#!/usr/bin/env bash
# P2-2 detection, closing r2's P2-A/B/D. Uid 988 is shared and `incus exec`
# is root inside the instance, so access by name is POLICY; this audit makes a
# breach visible. Window = verify-start .. teardown-done (P2-B). The run is
# CLEAN only if ALL of these hold, otherwise INCONCLUSIVE:
#  - every pg3601 instance-exec event matches a declared ledger entry by its
#    exact argv (metadata.context.command), each entry consumed once (P2-D);
#  - every declared exec in the window appears in the log (a silenced or
#    restarted monitor leaves declared execs unlogged: P2-A);
#  - the opening and closing heartbeats are both logged (monitor live at both edges);
#  - the monitor's InvocationID/ActiveEnter/NRestarts are identical at arm,
#    verify, handover, close and end, and it was active (P2-A);
#  - Atilla made exactly ONE exec, the launch;
#  - declared file pushes match instance-file-pushed events by count;
#  - before teardown-start, no other pg3601 lifecycle event (config, stop,
#    volume, profile ...); the lease timer unchanged at arm/verify/handover/end;
#  - the 30-min stop did not fire.
# Times are compared as float epoch seconds (Incus RFC3339Nano parsed; marks
# and ledger written with time.time()).
source "$(dirname "$0")/common.sh"
python3 -I - "$RECEIPTS" "$LIFECYCLE_LOG" "$DECLARED" > "$RECEIPTS/lifecycle-audit.txt" 2>&1 <<'PY'
import json,sys,os,re
from datetime import datetime
from collections import Counter
rec,logf,ledf=sys.argv[1:]
fails=[]
def jl(p):
    out=[]
    for l in open(p):
        try: out.append(json.loads(l))
        except ValueError: pass
    return out
def epoch(ts):
    m=re.match(r"(.*?\.\d{1,6})\d*(Z|[+-]\d\d:\d\d)$",ts) or re.match(r"(.*?)(Z|[+-]\d\d:\d\d)$",ts)
    return datetime.fromisoformat(m.group(1)+("+00:00" if m.group(2)=="Z" else m.group(2))).timestamp()
marks={}
for m in jl(os.path.join(rec,"marks.jsonl")): marks.setdefault(m["mark"],m["t"])
def mk(prefix):
    v=[t for k,t in marks.items() if k.startswith(prefix)]
    return min(v) if v else None
start,tstart,end=mk("verify-start"),mk("teardown-start"),mk("teardown-done")
if start is None or end is None: fails.append("window marks missing (verify-start/teardown-done)")
start=start or 0; end=end or 9e18; tstart=tstart or end
print(f"window {start:.3f} .. {end:.3f} (teardown-start {tstart:.3f})")
led=[e for e in jl(ledf) if start-1<=e["t"]<=end]
want=Counter(tuple(e["argv"]) for e in led if e.get("kind","exec")=="exec")
pushes=sum(1 for e in led if e.get("kind")=="file-push")
atilla=[e for e in led if e.get("who")=="atilla"]
if len(atilla)!=1 or atilla[0]["argv"]!=["/opt/pg3601/adapter/launch.sh"]:
    fails.append(f"Atilla execs: expected exactly the one launch, got {[e['argv'] for e in atilla]}")
got=Counter(); other=[]; pushed=0
for e in jl(logf):
    md=e.get("metadata",{}); src=md.get("source","")
    if "pg3601-" not in src: continue
    t=epoch(e["timestamp"])
    if not (start<=t<=end): continue
    a=md.get("action","")
    if a=="instance-exec":
        cmd=(md.get("context") or {}).get("command")
        got[tuple(cmd) if isinstance(cmd,list) else ("<no argv>",)]+=1
    elif a=="instance-file-pushed": pushed+=1
    elif t<tstart and not ("stop-fired" in marks and a in ("instance-stopped","instance-shutdown")):
        other.append((e["timestamp"],a,src))
undeclared=got-want; unlogged=want-got
if undeclared: fails.append(f"undeclared execs: {dict(undeclared)}")
if unlogged: fails.append(f"declared execs missing from the log (monitor gap): {dict(unlogged)}")
for hb in ("open","close"):
    if got[("sh","-c",f"echo pg3601-heartbeat-{hb}")]<1: fails.append(f"heartbeat {hb} not logged")
if pushed!=pushes: fails.append(f"file pushes: declared {pushes}, logged {pushed}")
if other: fails.append(f"undeclared lifecycle events before teardown: {other}")
def props(f):
    p=os.path.join(rec,f)
    return dict(l.strip().split("=",1) for l in open(p) if "=" in l) if os.path.exists(p) else None
ids=[(f,props(f)) for f in ("monitor.armed","monitor.verify","monitor.handover","monitor.close","monitor.end")]
base=ids[0][1]
for f,p in ids:
    if p is None: fails.append(f"{f} missing"); continue
    if p.get("ActiveState")!="active": fails.append(f"monitor not active at {f}")
    if base and any(p.get(k)!=base.get(k) for k in ("InvocationID","ActiveEnterTimestampMonotonic","NRestarts")):
        fails.append(f"monitor identity changed at {f}")
lease=[props(f) for f in ("lease-timer.armed","lease-timer.verify","lease-timer.handover","lease-timer.end")]
if "teardown-start:lease" not in marks:
    if any(l is None or l!=lease[0] for l in lease): fails.append("lease timer changed or missing")
if "stop-fired" in marks: fails.append("30-min hard stop fired")
print(f"execs logged {sum(got.values())}, declared {sum(want.values())}; pushes {pushed}/{pushes}")
for f in fails: print("FAIL",f)
print(f"## RESULT fails={len(fails)} ({'CLEAN' if not fails else 'INCONCLUSIVE'})")
PY
sha256sum "$RECEIPTS/lifecycle-audit.txt" | tee -a "$RECEIPTS/SHA256SUMS"
tail -1 "$RECEIPTS/lifecycle-audit.txt"
grep -q 'CLEAN)$' "$RECEIPTS/lifecycle-audit.txt"
