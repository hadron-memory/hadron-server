#!/usr/bin/env bash
# After Atilla posts run-end: copy the client output to a host directory only
# uid 988 can read (0700). Contents are case material: restricted node only,
# never the PR (P2-6). Declared execs only; then the closing heartbeat.
# r4 P3-7: the containment receipt records whether the root stop endpoint
# answered (/run/pg3601/STOP_DONE) and ONLY the final record's classification
# and job counts, so an expected terminal stop is told apart from an abort
# without case details (never stop_reason or any job id).
source "$(dirname "$0")/common.sh"
mark run-end
out=$STATE/collected; install -d -m 0700 "$out"
ix sh -c 'cat /pgvol/client/results.jsonl' > "$out/results.jsonl" || log "collect: no results.jsonl"
chmod 0600 "$out/results.jsonl" 2>/dev/null || true
sha256sum "$out/results.jsonl" | tee -a "$RECEIPTS/SHA256SUMS"
stopdone=$(ix sh -c 'if [ -e /run/pg3601/STOP_DONE ]; then echo stop_done=yes; else echo stop_done=no; fi') || stopdone=stop_done=unknown
python3 -I - "$out/results.jsonl" "$stopdone" > "$RECEIPTS/containment.txt" <<'PY'
import json,sys
recs=[]
try:
    for l in open(sys.argv[1]):
        try: recs.append(json.loads(l))
        except ValueError: pass
except OSError: pass
f=recs[-1] if recs else {}
c=f.get("classification")
print(sys.argv[2])
if c in ("CAMPAIGN_COMPLETE","CAMPAIGN_INCOMPLETE"):
    print(f"final_classification={c}")
    print(f"jobs_run={len(f.get('jobs_run') or [])} jobs_planned={len(f.get('jobs_planned') or [])}")
else:
    print("final_classification=ABSENT (no final completion record: abort or crash)")
print(f"records={len(recs)}")
PY
sha256sum "$RECEIPTS/containment.txt" | tee -a "$RECEIPTS/SHA256SUMS"
ix sh -c 'echo pg3601-heartbeat-close'
monitor_identity > "$RECEIPTS/monitor.close"
stop_timer_identity > "$RECEIPTS/stop-timer.close"
mark collected
