#!/usr/bin/env bash
# After verify.sh passes: arm the 30-min owner-scoped hard stop (P2-3) on the
# host monotonic clock, BEFORE Atilla's first connection or DDL, then print
# the exact client launch (P2-4). Hugo owns the stop; it is never re-armed.
source "$(dirname "$0")/common.sh"
here=$(cd "$(dirname "$0")" && pwd)
ls -t "$RECEIPTS"/verify-pre-*.txt >/dev/null 2>&1 || die "no verify receipt"
grep -q '^## RESULT fails=0$' "$(ls -t "$RECEIPTS"/verify-pre-*.txt | head -1)" || die "last verify not clean"
systemctl --user list-units --all --no-legend 'pg3601-stop*' | grep -q . && die "stop already armed; no re-arm"
systemd-run --user --quiet --unit=pg3601-stop --on-active=30min --timer-property=AccuracySec=1s "$here/stop.sh"
systemctl --user show pg3601-stop.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/stop-timer.armed"
log "handover: 30-min hard stop armed; run window opens"
cat <<LAUNCH
Atilla's single client launch (run from the host, once):
  incus --project $PROJECT exec $INSTANCE -- systemd-run --unit=pg3601-client --uid=runner --gid=runner \\
    --pty --wait --collect -p MemoryMax=512M -p MemorySwapMax=0 -p ProtectSystem=strict -p ProtectHome=yes \\
    -p ReadWritePaths=/pgvol/client -p PrivateTmp=yes -p LimitCORE=0 -p RuntimeMaxSec=1800 \\
    -p WorkingDirectory=/opt/pg3601/adapter \\
    /usr/bin/timeout --kill-after=30s 30m <adapter entry point named in the reviewed adapter package>
Guard client_cgroup: /system.slice/pg3601-client.service ; instance cgroup: / (namespace root)
LAUNCH
