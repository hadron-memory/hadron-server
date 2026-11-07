#!/usr/bin/env bash
# Runs INSIDE the lease (after arm.sh). Creates the three objects, installs the
# pinned .deb closure offline (no NIC, ever), proves the volume quota by
# filling it, creates the cluster on /pgvol, applies the unit sandbox, and runs
# the adapter's reviewed bootstrap SQL. Any refusal or failure: stop, exit 1,
# leave teardown to the operator/lease. No workaround, no retry.
#
# Required env (all values come from the reviewed adapter package, P2-1):
#   HARNESS_ARCHIVE         path to the harness archive (tar)
#   HARNESS_ARCHIVE_SHA256  its sha256 as quoted in the register row
#   HARNESS_MANIFEST        path to the manifest inside the archive (sha256sum format)
#   ADAPTER_ARCHIVE         path to the adapter package (tar)
#   ADAPTER_ARCHIVE_SHA256  its sha256 as quoted in the register row
# The adapter package must contain pg3601.env (WRITER_ROLE, OBSERVER_ROLE,
# DBNAME) and bootstrap.sql (roles, database, grants; run once as postgres).
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
: "${HARNESS_ARCHIVE:?} ${HARNESS_ARCHIVE_SHA256:?} ${HARNESS_MANIFEST:?} ${ADAPTER_ARCHIVE:?} ${ADAPTER_ARCHIVE_SHA256:?}"
systemctl --user is-active --quiet pg3601-lease.timer || die "lease not armed; run arm.sh first"
[[ $(sha256sum "$HARNESS_ARCHIVE" | cut -c1-64) == "$HARNESS_ARCHIVE_SHA256" ]] || die "harness archive hash"
[[ $(sha256sum "$ADAPTER_ARCHIVE" | cut -c1-64) == "$ADAPTER_ARCHIVE_SHA256" ]] || die "adapter archive hash"
( cd "$DEBS" && sha256sum --quiet -c SHA256SUMS ) || die "deb closure hash"

log "setup: create profile"
"${INCUS[@]}" profile create "$PROFILE"
"${INCUS[@]}" profile set "$PROFILE" limits.cpu=1 limits.cpu.allowance=100ms/100ms \
  limits.memory=1GiB limits.memory.enforce=hard limits.memory.swap=false \
  limits.processes=512 boot.autostart=false
"${INCUS[@]}" profile device add "$PROFILE" root disk pool="$POOL" path=/ size=4GiB
log "setup: create volume"
"${INCUS[@]}" storage volume create "$POOL" "$VOLUME" size=1GiB
log "setup: create instance (profile $PROFILE only: no NIC)"
"${INCUS[@]}" init "$IMAGE_FP" "$INSTANCE" --profile "$PROFILE"
"${INCUS[@]}" storage volume attach "$POOL" "$VOLUME" "$INSTANCE" /pgvol
"${INCUS[@]}" start "$INSTANCE"
ix systemctl is-system-running --wait >/dev/null || true

log "setup: quota proof (fill /pgvol until the filesystem refuses)"
ix sh -c 'dd if=/dev/zero of=/pgvol/.fill bs=1M count=1200 conv=fsync 2>&1; echo "dd_rc=$?"; stat -c "fill_bytes=%s" /pgvol/.fill; rm -f /pgvol/.fill; sync' \
  > "$RECEIPTS/quota-fill.txt" || true
grep -qE 'Disk quota exceeded|No space left' "$RECEIPTS/quota-fill.txt" || die "1GiB volume limit did not refuse a 1200MiB write"
bytes=$(sed -n 's/^fill_bytes=//p' "$RECEIPTS/quota-fill.txt")
(( bytes <= 1073741824 )) || die "fill wrote $bytes bytes, over 1GiB"

log "setup: push and verify harness + adapter"
ix mkdir -p /opt/pg3601/harness /opt/pg3601/adapter /root/debs
"${INCUS[@]}" file push "$HARNESS_ARCHIVE" "$INSTANCE/root/harness.tar"
"${INCUS[@]}" file push "$ADAPTER_ARCHIVE" "$INSTANCE/root/adapter.tar"
ix sh -c "echo '$HARNESS_ARCHIVE_SHA256  /root/harness.tar' | sha256sum -c --quiet && tar -C /opt/pg3601/harness -xf /root/harness.tar"
ix sh -c "echo '$ADAPTER_ARCHIVE_SHA256  /root/adapter.tar' | sha256sum -c --quiet && tar -C /opt/pg3601/adapter -xf /root/adapter.tar"
ix sh -c "cd /opt/pg3601/harness && echo '$HARNESS_MANIFEST_SHA256  $HARNESS_MANIFEST' | sha256sum -c --quiet && sha256sum -c --quiet '$HARNESS_MANIFEST'" \
  || die "harness manifest verification"
ix chmod -R a-w /opt/pg3601

log "setup: offline install of the pinned closure"
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

log "setup: journald volatile and bounded"
ix sh -c 'mkdir -p /etc/systemd/journald.conf.d && printf "[Journal]\nStorage=volatile\nRuntimeMaxUse=16M\n" > /etc/systemd/journald.conf.d/pg3601.conf && systemctl restart systemd-journald'

log "setup: cluster on /pgvol"
ix sh -c 'install -d -o postgres -g postgres -m 0700 /pgvol/data /pgvol/log'
ix sh -c 'useradd --system --no-create-home --shell /usr/sbin/nologin runner && install -d -o runner -g runner -m 0700 /pgvol/client'
ix pg_createcluster "$PG_MAJOR" "$CLUSTER" --datadir=/pgvol/data --logfile=/pgvol/log/startup.log \
  --encoding=UTF8 --locale=C
for kv in "listen_addresses ''" "logging_collector on" "log_directory /pgvol/log" \
          "log_rotation_size 10MB" "log_truncate_on_rotation on" "lc_messages C" \
          "track_functions all" "temp_file_limit 512MB" "temp_tablespaces ''"; do
  # shellcheck disable=SC2086
  ix pg_conftool "$PG_MAJOR" "$CLUSTER" set $kv
done
ix sh -c 'mkdir -p /etc/systemd/system/postgresql@17-main.service.d && printf "[Service]\nProtectSystem=strict\nProtectHome=yes\nReadWritePaths=/pgvol/data /pgvol/log /run/postgresql\nPrivateTmp=yes\nLimitCORE=0\n" > /etc/systemd/system/postgresql@17-main.service.d/pg3601.conf && systemctl daemon-reload'

log "setup: peer-only pg_hba and ident map from the adapter env"
ix sh -c '. /opt/pg3601/adapter/pg3601.env
: "${WRITER_ROLE:?}" "${OBSERVER_ROLE:?}" "${DBNAME:?}"
conf=/etc/postgresql/17/main
printf "local all postgres peer\nlocal %s %s,%s peer map=pg3601\n" "$DBNAME" "$WRITER_ROLE" "$OBSERVER_ROLE" > $conf/pg_hba.conf
printf "pg3601 runner %s\npg3601 runner %s\n" "$WRITER_ROLE" "$OBSERVER_ROLE" > $conf/pg_ident.conf'
ix systemctl enable --now "postgresql@$PG_MAJOR-$CLUSTER"
ix su postgres -s /bin/sh -c 'psql -v ON_ERROR_STOP=1 -X -q -f /opt/pg3601/adapter/bootstrap.sql' \
  > "$RECEIPTS/bootstrap.txt" 2>&1 || die "bootstrap.sql"
log "setup: done; run verify.sh before any handover"
