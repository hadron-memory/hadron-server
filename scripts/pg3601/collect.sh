#!/usr/bin/env bash
# After Atilla posts run-end: copy the client output to a host directory only
# uid 988 can read (0700). Contents are case material: restricted node only,
# never the PR (P2-6). One declared exec; then the closing heartbeat.
source "$(dirname "$0")/common.sh"
mark run-end
out=$STATE/collected; install -d -m 0700 "$out"
ix sh -c 'cat /pgvol/client/results.jsonl' > "$out/results.jsonl" || log "collect: no results.jsonl"
chmod 0600 "$out/results.jsonl" 2>/dev/null || true
sha256sum "$out/results.jsonl" | tee -a "$RECEIPTS/SHA256SUMS"
ix sh -c 'echo pg3601-heartbeat-close'
monitor_identity > "$RECEIPTS/monitor.close"
mark collected
