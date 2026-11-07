# shellcheck shell=bash
# Shared constants for the server#3601 bounded-PostgreSQL lab (proposal
# hrn:node:hadronmemory.com:hadron-dev-team-hugo:proposals:3601-bounded-pg r2).
# Sourced by every pg3601 script. Nothing here acts.
set -euo pipefail

PROJECT=user-988
INCUS=(incus --project "$PROJECT")
PROFILE=pg3601-bounded
VOLUME=pg3601-data
POOL=default
INSTANCE=pg3601-run
IMAGE_FP=985e718b7cea0c07e979020c12f56cb48713d08850139970fe1373989c8c4982
PG_MAJOR=17
PG_VERSION=17.11-0+deb13u1
CLUSTER=main
HARNESS_MANIFEST_SHA256=8b132fa42ac4bb2bba0c27906121503537f1505462828a7698763bf9eadb5a69

# Host-side state: the .deb closure, receipts, lifecycle log. Never inside /tmp.
STATE=${PG3601_STATE:-$HOME/.local/state/pg3601}
DEBS=$STATE/debs
RECEIPTS=$STATE/receipts
LIFECYCLE_LOG=$RECEIPTS/lifecycle.jsonl
mkdir -p "$DEBS" "$RECEIPTS"

ts() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
mono() { awk '{print $1}' /proc/uptime; }
log() { printf '%s mono=%s %s\n' "$(ts)" "$(mono)" "$*" | tee -a "$RECEIPTS/events.log" >&2; }
# Every exec into the instance goes through the declared-exec ledger (P2-B/D):
# one JSON line per exec with its exact argv, written BEFORE the exec, so the
# audit can match each lifecycle instance-exec event by metadata.context.command.
DECLARED=$RECEIPTS/declared-execs.jsonl
declare_exec() { python3 -I -c 'import json,sys,time; print(json.dumps({"t":time.time(),"who":sys.argv[1],"argv":sys.argv[2:]}))' "${PG3601_WHO:-hugo}" "$@" >> "$DECLARED"; }
ix() { declare_exec "$@"; "${INCUS[@]}" exec "$INSTANCE" -- "$@"; }
declare_push() { python3 -I -c 'import json,sys,time; print(json.dumps({"t":time.time(),"who":"hugo","kind":"file-push","path":sys.argv[1]}))' "$1" >> "$DECLARED"; }
mark() { python3 -I -c 'import json,sys,time; print(json.dumps({"t":time.time(),"mark":sys.argv[1]}))' "$1" >> "$RECEIPTS/marks.jsonl"; log "mark: $1"; }
monitor_identity() { systemctl --user show pg3601-monitor.service -p InvocationID -p ActiveEnterTimestampMonotonic -p NRestarts -p ActiveState -p MainPID; }
die() { log "FAIL: $*"; exit 1; }
