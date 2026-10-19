/** S5: metadata-only uncovered wait (cor:agt:050:26, Proposed exception timing). */
export const DELIVERY_EXCEPTION_CAUSES = ['no-live-session', 'isolated', 'team-paused', 'team-halted', 'wake-paused', 'standby', 'wake-budget'] as const;
export type DeliveryExceptionCause = typeof DELIVERY_EXCEPTION_CAUSES[number];
export type DeliveryMessage = { workerId: string; channelId: string; channelIncarnation: number; seq: number; dueSince: Date };
export type WaitCoverage = { kind: 'worker' } | { kind: 'range'; channelId: string; channelIncarnation: number; fromSeq: number; throughSeq: number };
export type WaitException = { workerId: string; cause: DeliveryExceptionCause; startedAt: Date; endedAt: Date | null; coverage: WaitCoverage };
export type WaitTracking = { trackedFrom: Date; observedThrough: Date };
export type DeliveryWait = { waitedMs: number; waitAsOf: Date; suppressed: boolean };

const instant = (d: Date) => {
  const n = d.getTime();
  if (!Number.isFinite(n)) throw new Error('DELIVERY_WAIT_INVALID');
  return n;
};
const covers = (m: DeliveryMessage, e: WaitException): boolean => e.workerId === m.workerId &&
  (e.coverage.kind === 'worker' || (e.coverage.channelId === m.channelId && e.coverage.channelIncarnation === m.channelIncarnation && e.coverage.fromSeq <= m.seq && m.seq <= e.coverage.throughSeq));

/** Missing producer coverage is unavailable, never an implicit zero deduction. */
export function deliveryWait(m: DeliveryMessage, exceptions: readonly WaitException[], tracking: WaitTracking, now: Date): DeliveryWait {
  const end = instant(now);
  const tracked = instant(tracking.trackedFrom);
  if (instant(tracking.observedThrough) < end || tracked > end) throw new Error('DELIVERY_WAIT_INCOMPLETE');
  const start = Math.max(instant(m.dueSince), tracked);
  const intervals: [number, number][] = [];
  let suppressed = false;
  for (const e of exceptions) {
    if (!covers(m, e)) continue;
    const lo = instant(e.startedAt);
    const hi = e.endedAt ? instant(e.endedAt) : Infinity;
    if (hi < lo) throw new Error('DELIVERY_WAIT_INVALID');
    if (lo <= end && end < hi) suppressed = true;
    if (lo < end && hi > start) intervals.push([Math.max(lo, start), Math.min(hi, end)]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let excluded = 0;
  let frontier = start;
  for (const [lo, hi] of intervals) {
    excluded += Math.max(0, hi - Math.max(frontier, lo));
    frontier = Math.max(frontier, hi);
  }
  return { waitedMs: Math.max(0, end - start - excluded), waitAsOf: now, suppressed };
}

const windowMs = (seconds: number): number => {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('DELIVERY_WINDOW_INVALID');
  return seconds * 1000;
};

/** Caller supplies the S1/S4 reached set above max(read,delivered); never reparse bodies here. */
export function oldestStuckMessage(messages: readonly DeliveryMessage[], exceptions: readonly WaitException[], tracking: WaitTracking, now: Date, stuckWindowSeconds: number): { message: DeliveryMessage; waitedMs: number } | null {
  const threshold = windowMs(stuckWindowSeconds);
  const workers = new Set(messages.map((m) => m.workerId));
  if (workers.size > 1) throw new Error('DELIVERY_WORKER_MISMATCH');
  const ordered = [...messages].sort((a, b) => instant(a.dueSince) - instant(b.dueSince) || a.channelId.localeCompare(b.channelId) || a.channelIncarnation - b.channelIncarnation || a.seq - b.seq);
  for (const message of ordered) {
    const wait = deliveryWait(message, exceptions, tracking, now);
    if (!wait.suppressed && wait.waitedMs >= threshold) return { message, waitedMs: wait.waitedMs };
  }
  return null;
}

export function nextDeliveryOwnerDue(wait: DeliveryWait, previousWokenWaitMs: number, stuckWindowSeconds: number, acknowledged: boolean): boolean {
  return !acknowledged && !wait.suppressed && wait.waitedMs - previousWokenWaitMs >= windowMs(stuckWindowSeconds);
}
