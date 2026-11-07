#!/usr/bin/env bash
# Starts the 60-min resource lease BEFORE any Incus object exists (P2-5,
# Xavier: the lease bounds setup too). Arms, on the host user manager:
#   pg3601-lease  (transient timer, OnActiveSec=60min, CLOCK_MONOTONIC) -> teardown.sh lease
#   pg3601-monitor (incus lifecycle events for the project -> $LIFECYCLE_LOG)
#   pg3601-boot-teardown.service (enabled, not started): a host reboot inside
#     the window tears down at the next user-manager start, because a
#     transient timer does not survive a reboot.
# Never re-armed: refuses if any pg3601 unit or object already exists.
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
if systemctl --user list-units --all --no-legend 'pg3601-*' | grep -q .; then die "pg3601 units already exist; no re-arm"; fi
if "${INCUS[@]}" list -f csv -c n | grep -q '^pg3601-'; then die "pg3601 instance exists"; fi
[[ -s $DEBS/SHA256SUMS ]] || die "run prepare-debs.sh first"
( cd "$DEBS" && sha256sum --quiet -c SHA256SUMS ) || die "deb closure changed since prepare"

systemd-run --user --quiet --unit=pg3601-monitor --collect \
  -p StandardOutput="append:$LIFECYCLE_LOG" -p StandardError="append:$RECEIPTS/monitor.err" \
  incus monitor --type=lifecycle --project "$PROJECT" --format=json
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/pg3601-boot-teardown.service" <<UNIT
[Unit]
Description=pg3601 lab: teardown after a host reboot inside the lease
[Service]
Type=oneshot
ExecStart=$here/teardown.sh boot
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --quiet pg3601-boot-teardown.service
systemd-run --user --quiet --unit=pg3601-lease --on-active=60min \
  --timer-property=AccuracySec=1s "$here/teardown.sh" lease
# r4 P3-3: the lease start, measured right after the timer started (so the
# deadline is at most 3600 s after it); handover uses this, never deadline-3600.
python3 -I -c 'import time; print(int(time.clock_gettime(time.CLOCK_MONOTONIC)*1e6))' > "$RECEIPTS/lease-started.us"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.armed"
sleep 1; monitor_identity > "$RECEIPTS/monitor.armed"
[[ $(sed -n 's/^ActiveState=//p' "$RECEIPTS/monitor.armed") == active ]] || die "lifecycle monitor not active"
mark armed
log "arm: lease armed (60min, no extension); monitor on; boot-teardown enabled"
