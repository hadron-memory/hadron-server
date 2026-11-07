#!/usr/bin/env bash
# P2-2 detection. All orca1 workers share uid 988 and project user-988, and
# `incus exec` is root inside the instance, so "only Atilla" is POLICY, not a
# technical control. This audit makes a breach visible: it splits the
# lifecycle log for pg3601-* into windows by the handover and run-end marks in
# events.log, and fails (=> the run is INCONCLUSIVE) on
#   - any pg3601 event (exec, config, stop, file, volume, profile) in the run
#     window beyond Atilla's ONE declared launch exec and Hugo's declared
#     client-snapshot execs (declared-execs.log);
#   - any change in the lease timer between arm, handover and end;
#   - the stop timer having fired (the run hit the 30-min wall).
# Usage: audit-lifecycle.sh RUN_END_ISO   (Atilla's posted end-of-run time)
source "$(dirname "$0")/common.sh"
end=${1:?run end ISO time}
start=$(sed -n 's/^\([^ ]*\) .*handover: 30-min hard stop armed.*/\1/p' "$RECEIPTS/events.log" | tail -1)
[[ -n $start ]] || die "no handover mark"
declared=$(( 1 + $(wc -l < "$RECEIPTS/declared-execs.log" 2>/dev/null || echo 0) ))
fails=0
{
echo "# lifecycle audit, run window $start .. $end"
jq -r --arg s "$start" --arg e "$end" '
  select((.metadata.source // "") | test("pg3601-"))
  | select(.timestamp >= $s and .timestamp <= $e)
  | [.timestamp, .metadata.action, .metadata.source] | @tsv' "$LIFECYCLE_LOG" | tee "$RECEIPTS/run-window-events.tsv"
execs=$(awk -F'\t' '$2=="instance-exec"' "$RECEIPTS/run-window-events.tsv" | wc -l)
other=$(awk -F'\t' '$2!="instance-exec"' "$RECEIPTS/run-window-events.tsv" | wc -l)
echo "execs in window: $execs (declared $declared); other pg3601 events: $other"
(( execs == declared )) || { echo "FAIL undeclared exec count"; fails=$((fails+1)); }
(( other == 0 )) || { echo "FAIL non-exec pg3601 events in the run window"; fails=$((fails+1)); }
for f in lease-timer.handover lease-timer.end; do
  [[ -f $RECEIPTS/$f ]] || continue
  if [[ $f == lease-timer.end ]] && grep -q 'teardown: reason=lease' "$RECEIPTS/events.log"; then continue; fi
  diff -q "$RECEIPTS/lease-timer.armed" "$RECEIPTS/$f" >/dev/null || { echo "FAIL lease timer changed ($f)"; fails=$((fails+1)); }
done
grep -q 'stop: 30-min hard stop fired' "$RECEIPTS/events.log" && { echo "FAIL hard stop fired"; fails=$((fails+1)); }
echo "## RESULT fails=$fails ($([[ $fails == 0 ]] && echo CLEAN || echo INCONCLUSIVE))"
} > "$RECEIPTS/lifecycle-audit.txt" 2>&1
sha256sum "$RECEIPTS/lifecycle-audit.txt" | tee -a "$RECEIPTS/SHA256SUMS"
cat "$RECEIPTS/lifecycle-audit.txt" | tail -1
