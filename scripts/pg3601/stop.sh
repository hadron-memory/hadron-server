#!/usr/bin/env bash
# The 30-min owner-scoped hard stop (P2-3), fired by pg3601-stop.timer.
# Kills the client slice members, stops the cluster immediately (backends
# included), and force-stops the instance UNLESS pgrep positively reports no
# postgres process (exit 1). Any exec error, timeout or pg_ctlcluster error
# counts as survivors (P2-C): a wedged instance is exactly the case this is for.
# The run is INCONCLUSIVE when this fires.
source "$(dirname "$0")/common.sh"
mark stop-fired
log "stop: 30-min hard stop fired; run INCONCLUSIVE"
timeout 20 "$(dirname "$0")/exec-declared.sh" systemctl kill --signal=SIGKILL pg3601-client.service pg3601-broker.service 2>/dev/null || true
pgok=0
timeout 20 "$(dirname "$0")/exec-declared.sh" pg_ctlcluster "$PG_MAJOR" "$CLUSTER" stop -m immediate 2>/dev/null || pgok=1
sleep 30
rc=0; timeout 20 "$(dirname "$0")/exec-declared.sh" pgrep -u postgres >/dev/null 2>&1 || rc=$?
if (( pgok != 0 || rc != 1 )); then
  log "stop: survivors or unverifiable (pg_ctlcluster=$pgok pgrep_rc=$rc); force-stopping the instance"
  timeout 60 "${INCUS[@]}" stop --force "$INSTANCE" || log "stop: force stop failed; the 60-min lease remains the backstop"
fi
log "stop: done"
