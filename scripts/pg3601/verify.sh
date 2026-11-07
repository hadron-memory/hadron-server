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
  {
    echo "# client unit, $(ts)"
    check client.memory.max 536870912 "$(ix cat /sys/fs/cgroup/system.slice/pg3601-client.service/memory.max)"
    check client.memory.swap.max 0 "$(ix cat /sys/fs/cgroup/system.slice/pg3601-client.service/memory.swap.max)"
    ix systemctl show pg3601-client.service -p User -p ProtectSystem -p PrivateTmp -p LimitCORE -p ReadWritePaths -p RuntimeMaxUSec
  } > "$out" 2>&1
  echo "$(ts) client-snapshot exec" >> "$RECEIPTS/declared-execs.log"
  sha256sum "$out" >> "$RECEIPTS/SHA256SUMS"; grep -c ^FAIL "$out" && exit 1 || exit 0
fi

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
check unit.PrivateTmp yes "$(ix systemctl show "$unit" -p PrivateTmp --value)"
check unit.LimitCORE 0 "$(ix systemctl show "$unit" -p LimitCORE --value)"
pm=$(ix head -1 /pgvol/data/postmaster.pid)
cg=$(ix systemctl show "$unit" -p ControlGroup --value)
check postmaster.core.limit "0 0" "$(ix awk '/Max core file size/{print $5, $6}' "/proc/$pm/limits")"
stray=$(ix bash -c "comm -23 <(pgrep -u postgres | sort) <(sort /sys/fs/cgroup$cg/cgroup.procs)")
check postgres.pids.outside.unit "" "$stray"

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

echo "## V6 write-path audit inside the postmaster mount namespace, as postgres"
w=$(ix nsenter -t "$pm" -m setpriv --reuid=postgres --regid=postgres --init-groups \
  find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /pgvol -o -path /run/postgresql -o -path /tmp -o -path /var/tmp \) -prune -o -writable -print 2>/dev/null | head -50)
check writable.outside.allowed "" "$w"

echo "## V7 binary applicability"
echo "version: $(psqlq 'SELECT version()')"
ix dpkg-query -W 'postgresql-17' 'postgresql-client-17' 'postgresql-common' 'libpq5'
check postgresql-17.version "$PG_VERSION" "$(ix dpkg-query -W -f='${Version}' postgresql-17)"
ix sh -c "/usr/lib/postgresql/17/bin/pg_controldata /pgvol/data | grep -E 'Database block size|WAL block size|Maximum size of a TOAST chunk|Database cluster state'"
echo "deb closure: $(sha256sum "$DEBS/SHA256SUMS")"

echo "## V8 detection: lease timer, monitor, lifecycle log self-test"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic | tee "$RECEIPTS/lease-timer.handover"
check lease.unchanged "$(cat "$RECEIPTS/lease-timer.armed")" "$(cat "$RECEIPTS/lease-timer.handover")"
check monitor.active active "$(systemctl --user is-active pg3601-monitor.service)"
n=$(jq -r 'select(.metadata.source|test("/instances/pg3601-run")) | .metadata.action' "$LIFECYCLE_LOG" 2>/dev/null | grep -c '^instance-exec' || true)
echo "instance-exec events logged so far: $n"
(( n > 0 )) && echo "PASS lifecycle log records execs" || { echo "FAIL lifecycle log records no execs: detection unavailable"; fails=$((fails+1)); }

echo "## RESULT fails=$fails"
} > "$out" 2>&1
sha256sum "$out" | tee -a "$RECEIPTS/SHA256SUMS"
grep -q '^## RESULT fails=0$' "$out" || die "verifiers failed; see $out. No handover; run teardown.sh normal"
log "verify: all PASS ($out)"
