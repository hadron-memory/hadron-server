#!/usr/bin/env bash
# Runs INSIDE the lease (after arm.sh). Creates the three objects, proves the
# volume quota, installs the pinned closure offline (no NIC, ever), verifies
# the frozen harness and the adapter against their JSON manifests, creates the
# cluster on /pgvol, applies the unit sandboxes, installs (does not start) the
# adapter's slice and broker units, and runs the adapter's bootstrap SQL.
# Any refusal or failure: stop, exit 1. No workaround, no retry.
#
# Required env:
#   HARNESS_ARCHIVE         full frozen harness archive (tar.gz)
#   HARNESS_ARCHIVE_SHA256  f75e2de6eed908b4e62f117e6d133200c37513d3f2cc1f322104c9835dd3878d (Atilla #87493)
#   ADAPTER_ARCHIVE         adapter package (tar.xz) as accepted by Riana
#   ADAPTER_ARCHIVE_SHA256  its sha256 as quoted in row B
#   ADAPTER_MANIFEST_SHA256 sha256 of the adapter's manifest.json
source "$(dirname "$0")/common.sh"
: "${HARNESS_ARCHIVE:?} ${HARNESS_ARCHIVE_SHA256:?} ${ADAPTER_ARCHIVE:?} ${ADAPTER_ARCHIVE_SHA256:?} ${ADAPTER_MANIFEST_SHA256:?}"
systemctl --user is-active --quiet pg3601-lease.timer || die "lease not armed; run arm.sh first"
[[ $(sha256sum "$HARNESS_ARCHIVE" | cut -c1-64) == "$HARNESS_ARCHIVE_SHA256" ]] || die "harness archive hash"
[[ $(sha256sum "$ADAPTER_ARCHIVE" | cut -c1-64) == "$ADAPTER_ARCHIVE_SHA256" ]] || die "adapter archive hash"
( cd "$DEBS" && sha256sum --quiet -c SHA256SUMS ) || die "deb closure hash"
mark setup-start

log "setup: create profile"
"${INCUS[@]}" profile create "$PROFILE"
"${INCUS[@]}" profile set "$PROFILE" limits.cpu=1 limits.cpu.allowance=100ms/100ms \
  limits.memory=1GiB limits.memory.enforce=hard \
  limits.processes=512 boot.autostart=false
"${INCUS[@]}" profile device add "$PROFILE" root disk pool="$POOL" path=/ size=4GiB
log "setup: create volume"
"${INCUS[@]}" storage volume create "$POOL" "$VOLUME" size=1GiB
log "setup: create instance (profile $PROFILE only: no NIC)"
"${INCUS[@]}" init "$IMAGE_FP" "$INSTANCE" --profile "$PROFILE"
"${INCUS[@]}" storage volume attach "$POOL" "$VOLUME" "$INSTANCE" /pgvol
"${INCUS[@]}" start "$INSTANCE"
ix systemctl is-system-running --wait >/dev/null || true

log "setup: quota proof (incompressible fill of /pgvol until the filesystem refuses)"
ix sh -c 'dd if=/dev/urandom of=/pgvol/.fill bs=1M count=1200 conv=fsync 2>&1; echo "dd_rc=$?"; stat -c "fill_bytes=%s" /pgvol/.fill; rm -f /pgvol/.fill; sync' \
  > "$RECEIPTS/quota-fill.txt" || true
grep -qE 'Disk quota exceeded|No space left' "$RECEIPTS/quota-fill.txt" || die "1GiB volume limit did not refuse a 1200MiB write"
bytes=$(sed -n 's/^fill_bytes=//p' "$RECEIPTS/quota-fill.txt")
(( bytes <= 1073741824 )) || die "fill wrote $bytes bytes, over 1GiB"

log "setup: offline install of the pinned closure (postgresql-17, python3, python3-psycopg)"
ix mkdir -p /root/debs
"${INCUS[@]}" file push "$DEBS"/*.deb "$DEBS/SHA256SUMS" "$INSTANCE/root/debs/"
ix sh -c 'cd /root/debs && sha256sum -c --quiet SHA256SUMS'
ix sh -c 'mkdir -p /etc/postgresql-common && printf "create_main_cluster = false\n" > /etc/postgresql-common/createcluster.conf'
# Install only what the image lacks or carries older: never downgrade an image package.
ix sh -c 'cd /root/debs && set -- && for f in ./*.deb; do p=$(dpkg-deb -f "$f" Package); v=$(dpkg-deb -f "$f" Version)
  have=$(dpkg-query -W -f="\${Version}" "$p" 2>/dev/null || true)
  if [ -z "$have" ] || dpkg --compare-versions "$have" lt "$v"; then set -- "$@" "$f"; fi; done
  echo "installing $# of $(ls ./*.deb | wc -l) debs"
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-download "$@"' \
  > "$RECEIPTS/apt-install.txt" 2>&1 || die "offline install (see apt-install.txt)"
ix rm -rf /root/debs

log "setup: push harness and adapter; verify both JSON manifests (every payload, nothing unlisted)"
ix mkdir -p /opt/pg3601/harness /opt/pg3601/adapter
"${INCUS[@]}" file push "$HARNESS_ARCHIVE" "$INSTANCE/root/harness.tar.gz"
"${INCUS[@]}" file push "$ADAPTER_ARCHIVE" "$INSTANCE/root/adapter.tar.xz"
ix sh -c "echo '$HARNESS_ARCHIVE_SHA256  /root/harness.tar.gz' | sha256sum -c --quiet && tar -C /opt/pg3601/harness -xzf /root/harness.tar.gz"
ix sh -c "echo '$ADAPTER_ARCHIVE_SHA256  /root/adapter.tar.xz' | sha256sum -c --quiet && tar -C /opt/pg3601/adapter -xJf /root/adapter.tar.xz"
ix rm -f /root/harness.tar.gz /root/adapter.tar.xz
for pair in "harness:$HARNESS_MANIFEST_SHA256" "adapter:$ADAPTER_MANIFEST_SHA256"; do
  dir=/opt/pg3601/${pair%%:*}; want=${pair#*:}
  ix python3 -I -c 'import hashlib,json,os,sys
d,want=sys.argv[1],sys.argv[2]
raw=open(os.path.join(d,"manifest.json"),"rb").read()
assert hashlib.sha256(raw).hexdigest()==want,"manifest.json hash"
m=json.loads(raw)["sha256"]
files={f for f in os.listdir(d) if f!="manifest.json"}
assert files==set(m),"unlisted or missing payloads: %r"%sorted(files^set(m))
for f,h in m.items():
    assert hashlib.sha256(open(os.path.join(d,f),"rb").read()).hexdigest()==h,f
print("manifest ok",d,len(m))' "$dir" "$want" >> "$RECEIPTS/manifests.txt" || die "manifest verification: $dir"
done
ix chown -R root:root /opt/pg3601
ix chmod -R a-w,go-w /opt/pg3601

log "setup: journald volatile and bounded"
ix sh -c 'mkdir -p /etc/systemd/journald.conf.d && printf "[Journal]\nStorage=volatile\nRuntimeMaxUse=16M\n" > /etc/systemd/journald.conf.d/pg3601.conf && systemctl restart systemd-journald'

log "setup: identities and directories"
ix sh -c 'useradd --system --no-create-home --shell /usr/sbin/nologin runner
install -d -o root -g root -m 0755 /pgvol
install -d -o postgres -g postgres -m 0700 /pgvol/data /pgvol/log
install -d -o runner -g runner -m 0700 /pgvol/client
install -d -o postgres -g runner -m 0750 /pgvol/broker
printf "d /run/pg3601 0755 root root -\n" > /etc/tmpfiles.d/pg3601.conf && systemd-tmpfiles --create /etc/tmpfiles.d/pg3601.conf'

log "setup: cluster on /pgvol"
ix pg_createcluster "$PG_MAJOR" "$CLUSTER" --datadir=/pgvol/data --logfile=/pgvol/log/startup.log \
  --encoding=UTF8 --locale=C
for kv in "listen_addresses ''" "logging_collector on" "log_directory /pgvol/log" \
          "log_rotation_size 10MB" "log_truncate_on_rotation on" "lc_messages C" \
          "track_functions all" "temp_file_limit 512MB" "temp_tablespaces ''"; do
  # shellcheck disable=SC2086
  ix pg_conftool "$PG_MAJOR" "$CLUSTER" set $kv
done
log "setup: workload slice (r5: in-instance no-swap; the profile cannot carry limits.memory.swap)"
# Same bounds as the instance profile, set where in-instance root owns the
# cgroup: memory 1GiB hard, swap 0, 1 CPU, 512 tasks. Residual (stated, not
# isolation): processes OUTSIDE this slice (the instance's init, journald,
# the stop-request unit) may still swap within the instance's 1GiB.
ix sh -c 'printf "[Unit]\nDescription=pg3601 workload: postgres and the client slice\n[Slice]\nMemoryMax=1G\nMemorySwapMax=0\nCPUQuota=100%%\nTasksMax=512\n" > /etc/systemd/system/pg3601.slice'
ix sh -c 'mkdir -p /etc/systemd/system/postgresql@17-main.service.d && printf "[Service]\nSlice=pg3601.slice\nProtectSystem=strict\nProtectHome=yes\nReadWritePaths=/pgvol/data /pgvol/log /run/postgresql\nPrivateTmp=no\nLimitCORE=0\n" > /etc/systemd/system/postgresql@17-main.service.d/pg3601.conf'

log "setup: root-owned stop-request endpoint (the confined adapter's only stop lever)"
# runner may create /pgvol/client/STOP_REQUEST; root answers with SIGKILL of the
# client slice members and an immediate cluster stop, and writes its marker in
# root-owned /run/pg3601 (never in a runner-writable directory). RemainAfterExit
# keeps the service active and the service then stops the path unit, so a
# persisting request file can never re-trigger it (a2 REVIEW P3-1).
ix sh -c 'cat > /etc/systemd/system/pg3601-stopreq.path <<UNIT
[Path]
PathExists=/pgvol/client/STOP_REQUEST
Unit=pg3601-stopreq.service
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/pg3601-stopreq.service <<UNIT
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c "systemctl kill --signal=SIGKILL pg3601-client.service pg3601-broker.service; pg_ctlcluster 17 main stop -m immediate; date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ > /run/pg3601/STOP_DONE; systemctl --no-block stop pg3601-stopreq.path"
UNIT'

log "setup: install (do not start) the adapter slice and broker units"
ix install -o root -g root -m 0644 /opt/pg3601/adapter/pg3601-clients.slice /opt/pg3601/adapter/pg3601-broker.service /etc/systemd/system/
ix systemctl daemon-reload

log "setup: peer-only pg_hba; runner maps to the writer login only"
ix sh -c '. /opt/pg3601/adapter/pg3601.env
: "${WRITER_ROLE:?}" "${DBNAME:?}"
conf=/etc/postgresql/17/main
printf "local all postgres peer\nlocal %s %s peer map=pg3601\n" "$DBNAME" "$WRITER_ROLE" > $conf/pg_hba.conf
printf "pg3601 runner %s\n" "$WRITER_ROLE" > $conf/pg_ident.conf'
ix systemctl enable --now "postgresql@$PG_MAJOR-$CLUSTER" pg3601-stopreq.path
ix su postgres -s /bin/sh -c 'psql -v ON_ERROR_STOP=1 -X -q -f /opt/pg3601/adapter/bootstrap.sql' \
  > "$RECEIPTS/bootstrap.txt" 2>&1 || die "bootstrap.sql"
chmod 0600 "$RECEIPTS/bootstrap.txt"
mark setup-done
log "setup: done; run verify.sh before any handover"
