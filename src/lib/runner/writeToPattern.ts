/**
 * #2437 — destination patterns for a flow node's `data.output.writeTo`
 * (epic #2435, gap 6; proof case #2411).
 *
 * A `writeTo` may carry a CLOSED token set — `{runId}`, `{runTime}` — that
 * expands per run at WRITE time, so a recurring report writes a new node per
 * run under a destination its owner chose. Ruling on the issue (Vera,
 * 2026-10-25, cor:agt:010:01): the tokens are the run's identity and time
 * ONLY — no eventData, no user text — and the resulting URN is grant-checked
 * after expansion, never the pattern at authoring (`writeTo` is data, not
 * the automation).
 *
 * No path traversal by construction: both token values use only loc-atom
 * characters (`runId` is an id; the stamp is digits and hyphens), so a
 * substitution can never introduce a `:` — the expanded loc's colon
 * structure is exactly the pattern's, and the node lands under the pattern's
 * static prefix. Literal URNs (no `{…}`) pass through unchanged.
 */

/** The run identity a pattern may carry: enough for both tokens, nothing else. */
export interface WriteToRun {
  id: string;
  /** Stamped when execution starts; the fallback only covers synthetic rows. */
  startedAt: Date | null;
}

/** `{runTime}` formatting: UTC `YYYY-MM-DD-HHMM` — #2411's report naming, colon-free. */
export function formatWriteToRunTime(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

/**
 * Expand a `writeTo` destination pattern against one run. A string with no
 * `{…}` is returned as-is (the literal path is byte-identical to before
 * #2437). Any `{…}` that is not exactly `{runId}` or `{runTime}` is a plain
 * refusal naming the allowed tokens — a typo must be explained, never
 * silently written as a literal node.
 */
export function expandWriteTo(writeTo: string, run: WriteToRun): string {
  return writeTo.replace(/\{([^{}]*)\}/g, (_whole, name: string) => {
    if (name === 'runId') return run.id;
    if (name === 'runTime') return formatWriteToRunTime(run.startedAt ?? new Date());
    throw new Error(
      `Unknown output destination token "{${name}}" in "${writeTo}" — allowed tokens are {runId} and {runTime}.`,
    );
  });
}
