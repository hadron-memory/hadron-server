#!/usr/bin/env bash
# The 30-min owner-scoped hard stop (P2-3), fired by pg3601-stop.timer.
# Kills the client unit, stops the cluster immediately (backends included),
# and force-stops the instance if any postgres process survives 30 s. The
# instance otherwise stays up so the client output on /pgvol/client can be
# collected before teardown. The run is INCONCLUSIVE when this fires.
source "$(dirname "$0")/common.sh"
log "stop: 30-min hard stop fired; run INCONCLUSIVE"
ix systemctl kill --signal=SIGKILL pg3601-client.service 2>/dev/null || true
ix pg_ctlcluster "$PG_MAJOR" "$CLUSTER" stop -m immediate 2>/dev/null || true
sleep 30
if ix pgrep -u postgres >/dev/null 2>&1; then
  log "stop: postgres processes survived; force-stopping the instance"
  "${INCUS[@]}" stop --force "$INSTANCE" || true
fi
log "stop: done"
