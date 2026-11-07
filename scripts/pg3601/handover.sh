#!/usr/bin/env bash
# After verify.sh passes. Refuses unless >= 35 min of lease remain (no
# extension, ever). Arms the 30-min owner-scoped hard stop (P2-3) on the host
# monotonic clock BEFORE any experiment connection, writes the opening
# heartbeat, then authors the root-owned descriptor and grant (P2-I item 6)
# from the receipts, writes them in as declared stdin execs (r4 P2-E), and prints Atilla's single declared launch.
#
# Required env for the grant (all from row B and Riana's acceptance):
#   ADAPTER_DIR (host copy of the accepted adapter package), ADAPTER_MANIFEST_SHA256,
#   REGISTER_ROW_URN, SECURITY_ACCEPTANCE_URN, GATE_EXECUTION_URN,
#   BINARY_APPLICABILITY_URN (the accepted 17.11-vs-b2b1910d review; without it there is no row B):
#     hrn:node:hadronmemory.com:hadron-dev-team-riana:reviews:3601-binary-applicability-pg17-11 (static accept, V7-conditional)
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
: "${ADAPTER_DIR:?} ${ADAPTER_MANIFEST_SHA256:?} ${REGISTER_ROW_URN:?} ${SECURITY_ACCEPTANCE_URN:?} ${GATE_EXECUTION_URN:?} ${BINARY_APPLICABILITY_URN:?}"
last=$(ls -t "$RECEIPTS"/verify-pre-*.txt 2>/dev/null | head -1)
[[ -n $last ]] && grep -q '^## RESULT fails=0$' "$last" || die "no clean verify receipt"
systemctl --user list-units --all --no-legend 'pg3601-stop*' | grep -q . && die "stop already armed; no re-arm"
lease_us=$(span_us "$(systemctl --user show pg3601-lease.timer -p NextElapseUSecMonotonic --value)") || die "lease timer elapse unreadable"
now_us=$(python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
(( lease_us > 0 && lease_us - now_us >= 35*60*1000000 )) || die "less than 35 min of lease left: attempt blocked/INCONCLUSIVE, no extension"
# The instance shares the host CLOCK_MONOTONIC (no time namespace): prove it.
inst=$(ix python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
host=$(python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
(( host - inst < 5000000 && inst - host < 5000000 )) || die "instance monotonic clock differs from host"

systemd-run --user --quiet --unit=pg3601-stop --on-active=30min --timer-property=AccuracySec=1s "$here/stop.sh"
systemctl --user show pg3601-stop.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/stop-timer.armed"
stop_timer_identity > "$RECEIPTS/stop-timer.handover"   # r4 P3-2: re-read at close and end
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.handover"
armed_lease_us=$(span_of "$RECEIPTS/lease-timer.armed") || die "armed lease receipt unreadable"
armed_stop_us=$(span_of "$RECEIPTS/stop-timer.armed") || die "stop timer receipt unreadable"
monitor_identity > "$RECEIPTS/monitor.handover"
ix sh -c 'echo pg3601-heartbeat-open'
mark handover

log "handover: author descriptor and grant (root-owned 0644 in /etc/pg3601)"
ix install -d -o root -g root -m 0755 /etc/pg3601
ids=$(ix sh -c 'echo "$(id -u runner) $(id -g runner)"')
bins=$(ix python3 -I -c 'import hashlib,json,subprocess
def pkg(n): return subprocess.run(["dpkg","-L",n],capture_output=True,text=True).stdout.split()
paths=["/usr/lib/postgresql/17/bin/postgres","/usr/lib/postgresql/17/bin/pg_ctl","/usr/bin/python3"]
paths+=[p for p in pkg("python3-psycopg") if p.endswith(".py")]
paths+=[p for p in pkg("libpq5") if p.endswith("/libpq.so.5")]   # r4 P3-5: psycopg loads it via ctypes
import os
out=[];seen=set()
for p in paths:
    r=os.path.realpath(p)
    if os.path.isfile(r) and r not in seen:
        seen.add(r); out.append({"path":p,"resolved":r,"sha256":hashlib.sha256(open(r,"rb").read()).hexdigest()})
assert any(b["path"].endswith("/libpq.so.5") for b in out),"libpq.so.5 not resolved"
print(json.dumps(out))')
verify_pre=$(basename "$last")
python3 -I - "$ADAPTER_DIR" "$RECEIPTS" "$verify_pre" "$ids" "$bins" "$ADAPTER_MANIFEST_SHA256" "$armed_lease_us" "$armed_stop_us" \
  "$REGISTER_ROW_URN" "$SECURITY_ACCEPTANCE_URN" "$GATE_EXECUTION_URN" "$HARNESS_MANIFEST_SHA256" "$BINARY_APPLICABILITY_URN" <<'PY'
# Fills a2's templates exactly (adapter a2 manifest 3d99f40d: descriptor, grant,
# runtime-index). Every value comes from a receipt; nothing is estimated.
import hashlib,json,sys,os
adir,rec,vpre,ids,bins,amf,lease_s,stop_s,row,sec,gate,hmf,binurn=sys.argv[1:]
def raw(f): return open(os.path.join(rec,f),"rb").read()
def h(b): return hashlib.sha256(b).hexdigest()
def kv(f): return dict(l.strip().split("=",1) for l in raw(f).decode().splitlines() if "=" in l)
lease_us=int(lease_s)   # the timer's ACTUAL elapse, parsed by span_us from lease-timer.armed
# r4 P3-3: lease start is MEASURED at arm (CLOCK_MONOTONIC read right after the
# timer started), not derived from the deadline, so the Guard's "lease extended"
# check (deadline - started > 3600 s) tests something. Read after systemd-run,
# so deadline - started <= 3600 s; more than 5 s under means a slow or odd arm.
started_us=int(raw("lease-started.us").decode().strip())
assert 3595*1000000<=lease_us-started_us<=3600*1000000,"lease start/deadline not 60 min apart"
stop_us=int(stop_s)     # likewise from stop-timer.armed
assert kv("lease-timer.armed")["ActiveState"]=="active" and kv("stop-timer.armed")["ActiveState"]=="active","a timer was not active"
assert stop_us<lease_us, "stop must precede the lease end"
assert b"## RESULT fails=0\n" in raw(vpre), "verify_pre not clean"
files={"verify_pre":vpre,"lease_timer":"lease-timer.armed","stop_timer":"stop-timer.armed"}
hashes={k:h(raw(f)) for k,f in files.items()}
idx=json.load(open(os.path.join(adir,"runtime-index.template.json")))
idx.update({"verifier_result":"PASS","lease_started_us":started_us,"lease_deadline_us":lease_us,
  "experiment_deadline_us":stop_us,"instance_cgroup":"/sys/fs/cgroup","client_cgroup":"/sys/fs/cgroup/pg3601-clients.slice",
  "raw_receipt_sha256":hashes,"binary_applicability_acceptance_urn":binurn})
ib=json.dumps(idx,indent=2,sort_keys=True).encode()+b"\n"
open(os.path.join(rec,"runtime-index.json"),"wb").write(ib)
hashes["runtime_index"]=h(ib)
dest={"verify_pre":"/etc/pg3601/receipts/verify-pre.txt","lease_timer":"/etc/pg3601/receipts/lease-timer.armed",
      "stop_timer":"/etc/pg3601/receipts/stop-timer.armed","runtime_index":"/etc/pg3601/receipts/runtime-index.json"}
d=json.load(open(os.path.join(adir,"descriptor.template.json")))
uid,gid=ids.split()
d.update({"status":"RUNTIME DESCRIPTOR authored by Hugo at handover from receipts",
  "runner_uid":int(uid),"runner_gid":int(gid),"harness_dir":"/opt/pg3601/harness",
  "instance_cgroup":idx["instance_cgroup"],"client_cgroup":idx["client_cgroup"],
  "lease_started_monotonic":idx["lease_started_us"]/1000000,"lease_deadline_monotonic":idx["lease_deadline_us"]/1000000,
  "experiment_deadline_monotonic":idx["experiment_deadline_us"]/1000000,"binary_files":json.loads(bins),
  "receipts":{k:{"path":dest[k],"sha256":hashes[k]} for k in dest}})
assert d["broker_socket"]=="/pgvol/broker/broker.sock" and d["evidence"]["qgroup_hard_bytes"]==1073741824
db=json.dumps(d,indent=2,sort_keys=True).encode()+b"\n"
open(os.path.join(rec,"descriptor.json"),"wb").write(db)
g=json.load(open(os.path.join(adir,"grant.template.json")))
g.update({"execution_ready":True,"adapter_manifest_sha256":amf,"harness_manifest_sha256":hmf,"descriptor_sha256":h(db),
  "register_row_urn":row,"security_acceptance_urn":sec,"gate_execution_urn":gate,"expires_monotonic":idx["experiment_deadline_us"]/1000000,
  "receipt_sha256":dict(hashes)})
open(os.path.join(rec,"grant.json"),"w").write(json.dumps(g,indent=2,sort_keys=True)+"\n")
PY
cp "$RECEIPTS/$verify_pre" "$RECEIPTS/verify-pre.txt"
ix install -d -o root -g root -m 0755 /etc/pg3601/receipts
# r4 P2-E: each file goes in as a declared exec with the bytes on stdin (never
# `incus file push`, which is SFTP and unlogged); the in-instance sha256 must
# equal the host's or handover stops.
xfer() { local src=$RECEIPTS/$1 dst=$2 mode=$3 want got
  want=$(sha256sum "$src" | cut -c1-64)
  got=$(put_file "$src" "$dst" "$mode" | cut -c1-64)
  [[ $got == "$want" ]] || die "transfer of $1: in-instance sha256 [$got] != host [$want]"; }
for f in verify-pre.txt lease-timer.armed stop-timer.armed runtime-index.json; do
  xfer "$f" "/etc/pg3601/receipts/$f" 0444
done
for f in descriptor.json grant.json; do xfer "$f" "/etc/pg3601/$f" 0644; done
sha256sum "$RECEIPTS/descriptor.json" "$RECEIPTS/grant.json" "$RECEIPTS/runtime-index.json" | tee -a "$RECEIPTS/SHA256SUMS"
log "handover: 30-min hard stop armed; descriptor and grant in place; run window open"
cat <<LAUNCH
Atilla's single declared launch (run once, from the host):
  PG3601_WHO=atilla $here/exec-declared.sh /opt/pg3601/adapter/launch.sh
When the client exits, post the end-of-run time; Hugo runs collect.sh, then teardown.sh normal.
LAUNCH
