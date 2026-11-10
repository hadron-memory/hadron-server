/**
 * #3845: the graceful stop (`src/index.ts`) folds every step into one exit code. When that code is 1, these helpers let
 * it say WHICH step failed and how, in one `shutdown.step_failed` line per step. Exit codes, graces and timings are not
 * touched here. A line carries only the step name and an outcome token: never an error message, which can carry content,
 * URLs or secrets.
 */

/** `'ok'`, or a short lowercase token naming how a step failed (`grace_timeout`, `bus_stop_rejected`, `rejected:ERR_X`). */
export type StepOutcome = string;

/** Outcomes of the embedding half of the stop, one per step. */
export interface EmbeddingStopOutcomes { worker: StepOutcome; publisher: StepOutcome }

/**
 * The only part of a thrown value that may be logged: a code (`ERR_SERVER_NOT_RUNNING`, `ECONNRESET`) or else the
 * constructor-style name (`TypeError`), and only when it is a plain identifier. Anything else is `unknown`.
 */
export function errorToken(error: unknown): string {
  const pick = (value: unknown) => (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null);
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; name?: unknown };
    return pick(e.code) ?? pick(e.name) ?? 'unknown';
  }
  return 'unknown';
}

/** Log one `shutdown.step_failed` line per step whose outcome is not `ok`; returns how many failed. */
export function logFailedShutdownSteps(steps: ReadonlyArray<readonly [step: string, outcome: StepOutcome]>): number {
  let failed = 0;
  for (const [step, outcome] of steps) {
    if (outcome === 'ok') continue;
    failed += 1;
    console.error(`shutdown.step_failed step=${step} outcome=${outcome}`);
  }
  return failed;
}
