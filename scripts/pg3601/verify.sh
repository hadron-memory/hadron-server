#!/usr/bin/env bash
# Read-only containment, privilege and binary verifiers. `verify.sh` runs
# before handover (any FAIL: no handover, teardown follows). `verify.sh client`
# reads the live client unit during the run (P2-4). Every output lands in
# $RECEIPTS with its sha256; nothing here writes inside the instance.
source "$(dirname "$0")/common.sh"
out=$RECEIPTS/verify-${1:-pre}-$(date -u +%H%M%S).txt
fails=0
check() { local name=$1 want=$2 have=$3
  if [[ $have == "$want" ]]; then echo "PASS $name = $have"; else echo "FAIL $name: want [$want] have [$have]"; fails=$((fails+1)); fi; }
psqlq() { ix su postgres -s /bin/sh -c "psql -X -A -t -q -c \"$1\""; }

if [[ ${1:-pre} == client ]]; then
  # ONE exec per snapshot (P2-D); the ledger records its exact argv.
  ix sh -c 'cd /sys/fs/cgroup/pg3601-clients.slice && echo "memory.max=$(cat memory.max)" && echo "memory.swap.max=$(cat memory.swap.max)" && systemctl show pg3601-client.service pg3601-broker.service -p Id -p User -p Slice -p ProtectSystem -p PrivateTmp -p LimitCORE -p ReadWritePaths -p RuntimeMaxUSec' > "$out" 2>&1
  { check slice.memory.max 536870912 "$(sed -n 's/^memory.max=//p' "$out")"
    check slice.memory.swap.max 0 "$(sed -n 's/^memory.swap.max=//p' "$out")"; } >> "$out"
  sha256sum "$out" >> "$RECEIPTS/SHA256SUMS"; grep -q ^FAIL "$out" && exit 1 || exit 0
fi

mark verify-start
{
echo "# pg3601 pre-handover verifiers, $(ts)"
echo "## V1 instance and profile (hashed)"
"${INCUS[@]}" config show "$INSTANCE" --expanded > "$RECEIPTS/config-expanded.yaml"
"${INCUS[@]}" profile show "$PROFILE" > "$RECEIPTS/profile.yaml"
sha256sum "$RECEIPTS/config-expanded.yaml" "$RECEIPTS/profile.yaml"
check devices "$VOLUME root" "$("${INCUS[@]}" query "/1.0/instances/$INSTANCE?project=$PROJECT" | jq -r '.expanded_devices|keys|sort|join(" ")')"
check nic.count 0 "$("${INCUS[@]}" query "/1.0/instances/$INSTANCE?project=$PROJECT" | jq '[.expanded_devices[]|select(.type=="nic")]|length')"
check base_image "$IMAGE_FP" "$("${INCUS[@]}" config get "$INSTANCE" volatile.base_image)"
check boot.autostart false "$("${INCUS[@]}" query "/1.0/instances/$INSTANCE?project=$PROJECT" | jq -r '.expanded_config["boot.autostart"]')"

echo "## V2 instance cgroup"
check memory.max 1073741824 "$(ix cat /sys/fs/cgroup/memory.max)"
check memory.swap.max 0 "$(ix cat /sys/fs/cgroup/memory.swap.max)"
check cpu.max "100000 100000" "$(ix cat /sys/fs/cgroup/cpu.max)"
check cpuset.ncpus 1 "$(ix nproc)"
check pids.max 512 "$(ix cat /sys/fs/cgroup/pids.max)"

echo "## V3 postgres unit sandbox and process placement"
unit=postgresql@17-main.service
ix systemctl show "$unit" -p ProtectSystem -p ProtectHome -p PrivateTmp -p LimitCORE -p ReadWritePaths -p ControlGroup
check unit.ProtectSystem strict "$(ix systemctl show "$unit" -p ProtectSystem --value)"
check unit.PrivateTmp no "$(ix systemctl show "$unit" -p PrivateTmp --value)"
check unit.LimitCORE 0 "$(ix systemctl show "$unit" -p LimitCORE --value)"
pm=$(ix head -1 /pgvol/data/postmaster.pid)
cg=$(ix systemctl show "$unit" -p ControlGroup --value)
check postmaster.core.limit "0 0" "$(ix awk '/Max core file size/{print $5, $6}' "/proc/$pm/limits")"
stray=$(ix bash -c "comm -23 <(pgrep -u postgres | sort) <(sort /sys/fs/cgroup$cg/cgroup.procs)")
check postgres.pids.outside.unit "" "$stray"

check stopreq.path.enabled enabled "$(ix systemctl is-enabled pg3601-stopreq.path)"
check stopreq.RemainAfterExit yes "$(ix systemctl show pg3601-stopreq.service -p RemainAfterExit --value)"
check stopreq.marker.dir "root:root 755" "$(ix stat -c '%U:%G %a' /run/pg3601)"
check broker.dir "postgres:runner 750" "$(ix stat -c '%U:%G %a' /pgvol/broker)"
check client.dir "runner:runner 700" "$(ix stat -c '%U:%G %a' /pgvol/client)"
check adapter.units.installed.inactive "inactive inactive" "$(ix sh -c 'systemctl is-active pg3601-clients.slice; systemctl is-active pg3601-broker.service' | tr '\n' ' ' | sed 's/ $//')"
check adapter.units.match.package "ok" "$(ix sh -c 'cmp -s /etc/systemd/system/pg3601-clients.slice /opt/pg3601/adapter/pg3601-clients.slice && cmp -s /etc/systemd/system/pg3601-broker.service /opt/pg3601/adapter/pg3601-broker.service && echo ok')"
check stopreq.path active "$(ix systemctl is-active pg3601-stopreq.path)"
check stopreq.trigger /pgvol/client/STOP_REQUEST "$(ix systemctl show pg3601-stopreq.path -p Paths --value | sed 's/^PathExists=//')"

echo "## V4 volume and quota identity"
"${INCUS[@]}" storage volume show "$POOL" "$VOLUME"
check volume.size 1GiB "$("${INCUS[@]}" storage volume get "$POOL" "$VOLUME" size)"
ix findmnt -n -o SOURCE,FSTYPE,TARGET /pgvol
ix df -B1 --output=size,used,avail /pgvol
cat "$RECEIPTS/quota-fill.txt"
ix findmnt -n -o TARGET,FSTYPE,SIZE /run /tmp /dev/shm || true

echo "## V5 cluster configuration, tablespaces, privileges"
for g in data_directory log_directory temp_tablespaces temp_file_limit lc_messages track_functions listen_addresses logging_collector block_size wal_block_size server_encoding; do
  echo "$g = $(psqlq "SHOW $g")"; done
check data_directory /pgvol/data "$(psqlq 'SHOW data_directory')"
check log_directory /pgvol/log "$(psqlq 'SHOW log_directory')"
check listen_addresses "" "$(psqlq 'SHOW listen_addresses')"
check lc_messages C "$(psqlq 'SHOW lc_messages')"
check track_functions all "$(psqlq 'SHOW track_functions')"
check temp_tablespaces "" "$(psqlq 'SHOW temp_tablespaces')"
check tablespaces "pg_default,pg_global" "$(psqlq "SELECT string_agg(spcname, ',' ORDER BY spcname) FROM pg_tablespace")"
check superusers postgres "$(psqlq "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolsuper")"
check file.roles.members "" "$(psqlq "SELECT string_agg(m.rolname||'>'||r.rolname, ',') FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname IN ('pg_write_server_files','pg_execute_server_program','pg_read_server_files') AND m.rolname <> 'postgres'")"
echo "role census:"; psqlq "SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1"
echo "memberships:"; psqlq "SELECT m.rolname||' member of '||r.rolname||' admin='||a.admin_option||' inherit='||a.inherit_option||' set='||a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member ORDER BY 1"
echo "hba rules:"; psqlq "SELECT type, database, user_name, auth_method, options FROM pg_hba_file_rules ORDER BY rule_number"
echo "ident map:"; psqlq "SELECT map_name, sys_name, pg_username FROM pg_ident_file_mappings ORDER BY 1,2,3"
# r4 P3-4: the hba rules are checked exactly, not just printed.
check hba.rules "local|all|postgres|peer|;local|pg3601|lab_writer|peer|map=pg3601" "$(psqlq "SELECT string_agg(type||'|'||array_to_string(database,',')||'|'||array_to_string(user_name,',')||'|'||auth_method||'|'||coalesce(array_to_string(options,','),''), ';' ORDER BY rule_number) FROM pg_hba_file_rules")"
check hba.errors 0 "$(psqlq 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')"
check adapter.env "pg3601 lab_writer" "$(ix sh -c '. /opt/pg3601/adapter/pg3601.env; echo "$DBNAME $WRITER_ROLE"')"
check ident.map "pg3601|runner|lab_writer" "$(psqlq "SELECT string_agg(map_name||'|'||sys_name||'|'||pg_username, ',') FROM pg_ident_file_mappings")"

echo "## V6 write-path audit inside the postmaster mount namespace, as postgres"
w=$(ix nsenter -t "$pm" -m setpriv --reuid=postgres --regid=postgres --init-groups \
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /pgvol -o -path /run/postgresql \) -prune -o -writable -print 2>/dev/null | head -50)
check writable.outside.allowed "" "$w"

echo "## V7 binary applicability"
echo "version: $(psqlq 'SELECT version()')"
ix dpkg-query -W 'postgresql-17' 'postgresql-client-17' 'postgresql-common' 'libpq5'
check postgresql-17.version "$PG_VERSION" "$(ix dpkg-query -W -f='${Version}' postgresql-17)"
ctl=$(ix sh -c "/usr/lib/postgresql/17/bin/pg_controldata /pgvol/data | grep -E 'Database block size|WAL block size|Maximum size of a TOAST chunk|Database cluster state'")
echo "$ctl"
# r4 P3-6: checked, not printed. The binary applicability acceptance
# (riana:reviews:3601-binary-applicability-pg17-11) is conditional on these.
cdv() { awk -F: -v k="$1" '$1==k{gsub(/[ \t]/,"",$2); print $2}' <<<"$ctl"; }
check controldata.block_size 8192 "$(cdv 'Database block size')"
check controldata.wal_block_size 8192 "$(cdv 'WAL block size')"
check controldata.toast_chunk 1996 "$(cdv 'Maximum size of a TOAST chunk')"
echo "deb closure: $(sha256sum "$DEBS/SHA256SUMS")"

echo "## V8 detection: lease timer, monitor identity, lifecycle self-test"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.verify"
check lease.unchanged "$(cat "$RECEIPTS/lease-timer.armed")" "$(cat "$RECEIPTS/lease-timer.verify")"
monitor_identity > "$RECEIPTS/monitor.verify"
check monitor.unchanged "$(cat "$RECEIPTS/monitor.armed")" "$(cat "$RECEIPTS/monitor.verify")"
# Self-test: setup's execs must be in the log WITH their argv (metadata.context.command);
# without the argv the audit cannot match declared execs, so no handover.
python3 -I - "$LIFECYCLE_LOG" <<'PY' && echo "PASS lifecycle log records exec argv" || { echo "FAIL lifecycle exec argv unavailable: detection absent"; fails=$((fails+1)); }
import json,sys
n=0
for line in open(sys.argv[1]):
    try: e=json.loads(line)
    except ValueError: continue
    m=e.get("metadata",{})
    if m.get("action")=="instance-exec" and "pg3601-run" in m.get("source","") and isinstance((m.get("context") or {}).get("command"),list): n+=1
print("instance-exec events with argv:",n)
sys.exit(0 if n>0 else 1)
PY
# r4 P2-E(b): what the log shows for setup's `incus file push` calls (SFTP in
# Incus 6.0.4). Recorded, not gated: no file transfer happens in the window,
# so the audit treats any logged file event there as undeclared.
python3 -I - "$LIFECYCLE_LOG" "$RECEIPTS/marks.jsonl" <<'PY' || true
import json,sys
from datetime import datetime
import re
def jl(p):
    for l in open(p):
        try: yield json.loads(l)
        except ValueError: pass
t0=min((m["t"] for m in jl(sys.argv[2]) if m.get("mark")=="setup-start"),default=0)
def epoch(ts):
    m=re.match(r"(.*?\.\d{1,6})\d*(Z|[+-]\d\d:\d\d)$",ts) or re.match(r"(.*?)(Z|[+-]\d\d:\d\d)$",ts)
    return datetime.fromisoformat(m.group(1)+("+00:00" if m.group(2)=="Z" else m.group(2))).timestamp()
acts={}
for e in jl(sys.argv[1]):
    md=e.get("metadata",{})
    if "pg3601-run" in md.get("source","") and "file" in md.get("action","") and epoch(e["timestamp"])>=t0:
        acts[md["action"]]=acts.get(md["action"],0)+1
print(f"file lifecycle events since setup-start (setup made 3 push invocations): {acts or 'none'}")
PY
echo "COVERAGE: file access over the Incus SFTP API is not lifecycle-logged in Incus 6.0.4; the audit covers execs and instance, config and storage lifecycle only."
echo "NOTE: lifecycle.jsonl, the ledger and the timers are uid-988-writable: policy, not a control."

echo "## RESULT fails=$fails"
} > "$out" 2>&1
sha256sum "$out" | tee -a "$RECEIPTS/SHA256SUMS"
grep -q '^## RESULT fails=0$' "$out" || die "verifiers failed; see $out. No handover; run teardown.sh normal"
log "verify: all PASS ($out)"
