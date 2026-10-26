/**
 * #2026 capacity bound for the optional footer. Each footer opens its own transaction on a second pooled
 * connection, so a burst of successful calls would double pool pressure on the primary path. A slot is taken
 * BEFORE any connection is requested and is never waited for: a saturated footer is simply omitted.
 * The cap is per process, not per principal, so one principal can crowd out others' footers; only optional
 * metadata is lost, and absence always means "unknown", never zero.
 */
export const FOOTER_MAX_CONCURRENT = 4;

export function createFooterSlots(limit: number) {
  let used = 0;
  return {
    /** A release function when a slot is free, otherwise null. Never queues. Release is idempotent. */
    tryAcquire(): (() => void) | null {
      if (used >= limit) return null;
      used++;
      let released = false;
      return () => { if (!released) { released = true; used--; } };
    },
    inUse: () => used,
  };
}
