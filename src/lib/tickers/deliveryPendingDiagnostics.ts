/** Footer telemetry is process-local and contains only finite classes, never raw errors or identities. */
const reasons = ['failure', 'deadline', 'pool', 'transaction', 'statement', 'read-only', 'unsafe-count', 'unavailable-app'] as const;
type Reason = typeof reasons[number];
const knownCodes: Record<string, Reason> = {
  P2024: 'pool', P2028: 'transaction', '57014': 'statement', '25006': 'read-only',
  FOOTER_UNSAFE_COUNT: 'unsafe-count', FOOTER_APP_UNAVAILABLE: 'unavailable-app',
};

export function footerFailureReason(error: unknown): Reason {
  try {
    if (!error || typeof error !== 'object') return 'failure';
    const { code, meta } = error as { code?: unknown; meta?: { code?: unknown } };
    // Prisma wraps PostgreSQL raw-query errors. Read only the structured code, never message/detail/prose.
    const candidate = code === 'P2010' ? meta?.code : code;
    return typeof candidate === 'string' && Object.hasOwn(knownCodes, candidate) ? knownCodes[candidate] : 'failure';
  } catch { return 'failure'; }
}

export function createFooterOmissionReporter(
  write: (line: string) => void = line => console.warn(line),
  now: () => number = () => Date.now(),
): (reason: string) => void {
  // Bounded cardinality: one entry per finite class, never per worker/session/error.
  const last = new Map<Reason, { at: number; suppressed: number }>();
  return input => {
    try {
      const reason: Reason = reasons.includes(input as Reason) ? input as Reason : 'failure';
      const at = now();
      const previous = last.get(reason);
      if (previous && at - previous.at < 30_000) {
        previous.suppressed = Math.min(previous.suppressed + 1, Number.MAX_SAFE_INTEGER);
        return;
      }
      last.set(reason, { at, suppressed: 0 });
      write(JSON.stringify({ event: 'delivery.pending.omitted', reason,
        ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}) }));
    } catch { /* Diagnostics cannot change the successful operation, even if the sink fails. */ }
  };
}
