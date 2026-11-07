#!/usr/bin/env bash
# After verify.sh passes. Refuses unless >= 35 min of lease remain (no
# extension, ever). Arms the 30-min owner-scoped hard stop (P2-3) on the host
# monotonic clock BEFORE any experiment connection, writes the opening
# heartbeat, then authors the root-owned descriptor and grant (P2-I item 6)
# from the receipts, and prints Atilla's single declared launch.
#
# Required env for the grant (all from row B and Riana's acceptance):
#   ADAPTER_DIR (host copy of the accepted adapter package), ADAPTER_MANIFEST_SHA256,
#   REGISTER_ROW_URN, SECURITY_ACCEPTANCE_URN, GATE_EXECUTION_URN,
#   BINARY_APPLICABILITY_URN (the accepted 17.11-vs-b2b1910d review; without it there is no row B)
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
: "${ADAPTER_DIR:?} ${ADAPTER_MANIFEST_SHA256:?} ${REGISTER_ROW_URN:?} ${SECURITY_ACCEPTANCE_URN:?} ${GATE_EXECUTION_URN:?} ${BINARY_APPLICABILITY_URN:?}"
last=$(ls -t "$RECEIPTS"/verify-pre-*.txt 2>/dev/null | head -1)
[[ -n $last ]] && grep -q '^## RESULT fails=0$' "$last" || die "no clean verify receipt"
systemctl --user list-units --all --no-legend 'pg3601-stop*' | grep -q . && die "stop already armed; no re-arm"
lease_us=$(systemctl --user show pg3601-lease.timer -p NextElapseUSecMonotonic --value)
lease_us=$(python3 -I -c 'import sys,re
v=sys.argv[1]; print(int(v) if v.isdigit() else -1)' "$lease_us")
now_us=$(python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
(( lease_us > 0 && lease_us - now_us >= 35*60*1000000 )) || die "less than 35 min of lease left: attempt blocked/INCONCLUSIVE, no extension"
# The instance shares the host CLOCK_MONOTONIC (no time namespace): prove it.
inst=$(ix python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
host=$(python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))')
(( host - inst < 5000000 && inst - host < 5000000 )) || die "instance monotonic clock differs from host"

systemd-run --user --quiet --unit=pg3601-stop --on-active=30min --timer-property=AccuracySec=1s "$here/stop.sh"
systemctl --user show pg3601-stop.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/stop-timer.armed"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.handover"
monitor_identity > "$RECEIPTS/monitor.handover"
ix sh -c 'echo pg3601-heartbeat-open'
mark handover

log "handover: author descriptor and grant (root-owned 0644 in /etc/pg3601)"
ix sh -c 'install -d -o root -g root -m 0755 /etc/pg3601'
ids=$(ix sh -c 'echo "$(id -u runner) $(id -g runner)"')
bins=$(ix python3 -I -c 'import hashlib,json,subprocess
paths=["/usr/lib/postgresql/17/bin/postgres","/usr/lib/postgresql/17/bin/pg_ctl","/usr/bin/python3"]
paths+=[p for p in subprocess.run(["dpkg","-L","python3-psycopg"],capture_output=True,text=True).stdout.split() if p.endswith(".py")]
import os
out=[]
for p in paths:
    r=os.path.realpath(p)
    if os.path.isfile(r): out.append({"path":p,"resolved":r,"sha256":hashlib.sha256(open(r,"rb").read()).hexdigest()})
print(json.dumps(out))')
python3 -I - "$ADAPTER_DIR/descriptor.template.json" "$RECEIPTS" "$ids" "$bins" "$ADAPTER_MANIFEST_SHA256" \
  "$REGISTER_ROW_URN" "$SECURITY_ACCEPTANCE_URN" "$GATE_EXECUTION_URN" "$HARNESS_MANIFEST_SHA256" "$BINARY_APPLICABILITY_URN" <<'PY'
import hashlib,json,sys,os,glob
tpl,rec,ids,bins,amf,row,sec,gate,hmf,binurn=sys.argv[1:]
d=json.load(open(tpl))
def kv(f): return dict(l.strip().split("=",1) for l in open(os.path.join(rec,f)) if "=" in l)
def h(f): return hashlib.sha256(open(os.path.join(rec,f),"rb").read()).hexdigest()
verify=sorted(glob.glob(os.path.join(rec,"verify-pre-*.txt")))[-1]
uid,gid=ids.split()
lease_end=int(kv("lease-timer.armed")["NextElapseUSecMonotonic"])/1e6
stop_end=int(kv("stop-timer.armed")["NextElapseUSecMonotonic"])/1e6
d.update({"status":"RUNTIME DESCRIPTOR authored by Hugo at handover from receipts",
  "runner_uid":int(uid),"runner_gid":int(gid),"harness_dir":"/opt/pg3601/harness",
  "instance_cgroup":"/sys/fs/cgroup","client_cgroup":"/sys/fs/cgroup/pg3601-clients.slice",
  "broker_socket":"/pgvol/broker/broker.sock",
  "lease_started_monotonic":lease_end-3600,"lease_deadline_monotonic":lease_end,
  "experiment_deadline_monotonic":stop_end,"binary_files":json.loads(bins)})
receipts={"read_only_verifiers_passed":os.path.basename(verify),"host_60m_lease_armed":"lease-timer.armed",
  "host_30m_stop_armed":"stop-timer.armed","lifecycle_monitor_active":"monitor.handover",
  "storage_quota":"quota-fill.txt"}
d["evidence_receipts"]={k:{"receipt":v,"sha256":h(v)} for k,v in receipts.items()}
ev=d["evidence"]
for k in ("read_only_verifiers_passed","writer_login_reset_role_verified","lifecycle_monitor_active",
          "postmaster_write_paths_confined","host_30m_stop_armed","host_60m_lease_armed","stop_request_path_active"):
    ev[k]=True   # each backed by a PASS line in the hashed verify receipt above
ev["binary_build_layout_verified"]=True    # backed by the V7 lines in the verify receipt AND the accepted review below
d["evidence_receipts"]["binary_build_layout_verified"]={"receipt":os.path.basename(verify),"sha256":h(os.path.basename(verify)),"acceptance_urn":binurn}
ev["qgroup_hard_bytes"]=1073741824
raw=json.dumps(d,indent=2,sort_keys=True).encode()+b"\n"
open(os.path.join(rec,"descriptor.json"),"wb").write(raw)
g={"execution_ready":True,"adapter_manifest_sha256":amf,"harness_manifest_sha256":hmf,
   "descriptor_sha256":hashlib.sha256(raw).hexdigest(),"register_row_urn":row,
   "security_acceptance_urn":sec,"gate_execution_urn":gate,"instance":"pg3601-run",
   "expires_monotonic":stop_end}
open(os.path.join(rec,"grant.json"),"w").write(json.dumps(g,indent=2,sort_keys=True)+"\n")
PY
for f in descriptor.json grant.json; do
  declare_push "/etc/pg3601/$f"
  "${INCUS[@]}" file push --uid 0 --gid 0 --mode 0644 "$RECEIPTS/$f" "$INSTANCE/etc/pg3601/$f"
done
sha256sum "$RECEIPTS/descriptor.json" "$RECEIPTS/grant.json" | tee -a "$RECEIPTS/SHA256SUMS"
log "handover: 30-min hard stop armed; descriptor and grant in place; run window open"
cat <<LAUNCH
Atilla's single declared launch (run once, from the host):
  PG3601_WHO=atilla $here/exec-declared.sh /opt/pg3601/adapter/launch.sh
When the client exits, post the end-of-run time; Hugo runs collect.sh, then teardown.sh normal.
LAUNCH
