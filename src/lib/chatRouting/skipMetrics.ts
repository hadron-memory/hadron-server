/** #4101 shape 1: opt-in operator diagnostics, never accounting or a caller-visible surface. */
type FlagKind = 'absent' | 'false' | 'non_boolean';
const empty = (): Record<FlagKind, number> => ({ absent: 0, false: 0, non_boolean: 0 });
const minimumIntervalMs = 60_000;
let skippedDecisions = empty(), skippedRules = empty();
let lastEmission: number | undefined;
const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/**
 * Aggregate only rules actually skipped for a non-true flag (cor:cht:030:02 K2).
 * Kind, never value: no ids, names, message/extraction/prompt plaintext or keys
 * enter the log (cor:sec:040:01). Three fixed buckets keep memory/cardinality bounded.
 * No timer or final flush: pending counts are best-effort and vanish on exit.
 * Counts are decisions, not unique turns: transaction retries may count again.
 */
export function recordSkippedOnComplete(flag: unknown, count: number): void {
  if (process.env.HADRON_CHAT_ON_COMPLETE_SKIP_METRICS !== 'true' || flag === true || count <= 0) return;
  try {
    const kind: FlagKind = flag === undefined ? 'absent' : flag === false ? 'false' : 'non_boolean';
    skippedDecisions[kind] = add(skippedDecisions[kind], 1);
    skippedRules[kind] = add(skippedRules[kind], count);
    const now = performance.now(); // monotonic; wall-clock adjustments cannot produce a burst
    if (lastEmission !== undefined && now - lastEmission < minimumIntervalMs) return;
    // Consume the slot before touching the sink, even if the sink throws.
    lastEmission = now;
    const event = { event: 'chat.on_complete_skipped', minimumIntervalMs, skippedDecisions, skippedRules };
    skippedDecisions = empty(); skippedRules = empty();
    console.info(JSON.stringify(event));
  } catch {
    // Optional observability must never change routing or replace its original error.
  }
}
