#!/usr/bin/env bash
# Teardown for every path: normal | lease (60-min timer) | boot (host reboot
# inside the window). Idempotent; deletes the three objects, records the
# monitor and lease identities, disarms every pg3601 unit, writes the proof,
# then runs the lifecycle audit over verify-start .. teardown-done.
source "$(dirname "$0")/common.sh"
reason=${1:-normal}
mark "teardown-start:$reason"
systemctl --user show pg3601-lease.timer -p ActiveState -p NextElapseUSecMonotonic > "$RECEIPTS/lease-timer.end" 2>&1 || true
monitor_identity > "$RECEIPTS/monitor.end" 2>&1 || true
[[ -e $RECEIPTS/stop-timer.handover ]] && { stop_timer_identity > "$RECEIPTS/stop-timer.end" 2>&1 || true; }   # r4 P3-2
"${INCUS[@]}" delete --force "$INSTANCE" 2>&1 | tee -a "$RECEIPTS/events.log" || true
"${INCUS[@]}" storage volume delete "$POOL" "$VOLUME" 2>&1 | tee -a "$RECEIPTS/events.log" || true
"${INCUS[@]}" profile delete "$PROFILE" 2>&1 | tee -a "$RECEIPTS/events.log" || true
sleep 3   # let the monitor write the delete events before it stops
mark teardown-done
systemctl --user stop pg3601-stop.timer pg3601-monitor.service 2>/dev/null || true
systemctl --user disable --quiet pg3601-boot-teardown.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/pg3601-boot-teardown.service"; systemctl --user daemon-reload
[[ $reason == lease ]] || systemctl --user stop pg3601-lease.timer 2>/dev/null || true
{
  echo "# teardown proof ($reason), $(ts)"
  echo "instances:"; "${INCUS[@]}" list -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "volumes:"; "${INCUS[@]}" storage volume list "$POOL" -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "profiles:"; "${INCUS[@]}" profile list -f csv -c n | grep '^pg3601-' || echo "  none"
  echo "units:"; systemctl --user list-units --all --no-legend 'pg3601-*' | grep -v 'pg3601-lease' || echo "  none"
} > "$RECEIPTS/teardown.txt"
sha256sum "$RECEIPTS/teardown.txt" "$LIFECYCLE_LOG" "$DECLARED" "$RECEIPTS/marks.jsonl" "$RECEIPTS/events.log" | tee -a "$RECEIPTS/SHA256SUMS"
log "teardown: done"
"$(dirname "$0")/audit-lifecycle.sh" || true
