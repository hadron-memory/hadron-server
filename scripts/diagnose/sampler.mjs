// Diagnosis-only sampler for #2589 (MCP churn / RSS). Counts and sizes only:
// no session ids, principals, tokens or URLs ever reach the output.
export const NOT_SAMPLED = 'not sampled';
export const RSS_ABORT_BYTES = 5 * 1024 ** 3;
export const WALL_ABORT_MS = 20 * 60_000;

export function reduceTransportState(state) {
  const entries = Object.values(state.entries);
  return {
    sessions: state.sessionIds.length,
    inFlight: entries.reduce((n, e) => n + e.inFlight, 0),
    principals: new Set(entries.map((e) => e.principalKey)).size,
    reservations: state.reservations,
    sweepTimerRunning: state.sweepTimerRunning,
    sideMaps: Object.fromEntries(Object.entries(state.sideMapKeys).map(([k, v]) => [k, v.length])),
  };
}

// Fields this process cannot observe (pool waiters: no $metrics) are NOT_SAMPLED, never 0.
export function sampleProcess(proc = process) {
  const m = proc.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, poolWaiters: NOT_SAMPLED };
}

export function shouldAbort({ rss, elapsedMs }) {
  if (rss >= RSS_ABORT_BYTES) return 'rss';
  if (elapsedMs >= WALL_ABORT_MS) return 'time';
  return null;
}

const SECRET_SHAPES = [/postgres(ql)?:\/\/[^\s"]*:[^\s"]*@/i, /hdr_[a-z]+_[A-Za-z0-9]+/, /Bearer\s+\S+/i, /mcp-session-id\s*[:=]\s*\S+/i];
export function assertSecretFree(text) {
  for (const re of SECRET_SHAPES) if (re.test(text)) throw new Error('diagnose output refused: secret-shaped content');
}

// Only allowlisted numeric/boolean V8 flags are recorded; raw NODE_OPTIONS can carry URLs or paths (#2596 LOCAL P2).
const SAFE_FLAG = /^--(max-old-space-size|max-semi-space-size|stack-size)=\d+$|^--(expose-gc|expose_gc)$/;
export function safeNodeOptions(raw) {
  return String(raw ?? '').split(/\s+/).filter((t) => SAFE_FLAG.test(t));
}

// Counts of Prisma pool timeout codes in a chunk of log text; the text itself is never kept.
export function countTimeouts(text) {
  return { P2024: (text.match(/P2024/g) ?? []).length, P2028: (text.match(/P2028/g) ?? []).length };
}

// Coverage markers: a field is measured only for what actually ran; everything else stays 'not exercised', never zero.
export function coverageLine({ w2, heap }) {
  const NOT = 'not exercised';
  const pos = (x) => Number.isSafeInteger(x) && x > 0;
  return { kind: 'coverage',
    w2SyntheticActivity: w2 ? { embed: pos(w2.embeddedNodes) ? 'measured' : NOT, matcher: pos(w2.tasksQueued) ? 'queued only' : NOT, stall: pos(w2.stallAlarms) ? 'measured' : NOT } : NOT,
    heapSnapshotReductions: heap ? 'measured' : NOT };
}

// A snapshot request is a file named snap-<label>.trigger; the label is allowlisted so a filename can never steer the output path.
export function snapshotLabel(name) {
  const m = /^snap-([a-z0-9-]{1,20})\.trigger$/.exec(name);
  return m ? m[1] : null;
}
