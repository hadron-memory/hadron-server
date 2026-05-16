// Canonical-form-rewrite observability logger — spec 021 FR-031a.
//
// Every time the URN parser (or the resolver layer) rewrites an input URN
// to its canonical form, this module emits one INFO-level structured log
// entry per AliasCategory that fired. The aggregated counts feed
// Q-2026-05-11-001 narrowing decisions: do we keep accepting all four
// D11 alias categories, or do we drop the ones nobody uses?
//
// **Logging volume**:
//   - First 90 days post-launch: 100% (every rewrite logged).
//   - After 90 days: 1% sampled.
//
// The cut-over from 100% to 1% is a single config change. The default
// SAMPLE_RATE is 1.0; operators set `URN_REWRITE_SAMPLE_RATE=0.01` (env)
// on the cut-over date. Code does NOT auto-cut over based on time — the
// 90-day window is a deployment decision, not a code-level one.

import type { AliasCategory } from './urn.js';

/**
 * Optional per-request context attached to each log entry. The parser
 * doesn't know about HTTP requests or user identities, so the caller
 * passes this through. Both fields are optional; omitted ones simply
 * don't appear in the emitted JSON.
 */
export interface CanonicalRewriteContext {
  requestId?: string;
  userId?: string;
}

/**
 * Sample rate for rewrite-log emission. Read once at module-init time.
 * The default (1.0 — log every rewrite) reflects the post-launch 90-day
 * window; operators override to 0.01 via env on the cut-over date. Tests
 * can override at runtime via `setSampleRateForTesting`.
 *
 * **Operator note**: changing `URN_REWRITE_SAMPLE_RATE` in the deployed
 * environment requires a **full process restart** to take effect — once
 * Node imports this module, ESM caches it and the value is fixed for
 * the process lifetime. The "single config change" cut-over described
 * in spec 021 contracts/canonical-form.md is config + restart, not just
 * config. (We deliberately read once at startup rather than per-call to
 * avoid the env-lookup cost on every parse-rewrite hot path.)
 */
let SAMPLE_RATE: number = Number(process.env.URN_REWRITE_SAMPLE_RATE ?? '1');

if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE < 0 || SAMPLE_RATE > 1) {
  // Bad config — fall back to 1.0 (log everything) and warn at startup.
  // eslint-disable-next-line no-console
  console.warn(
    `[urn-rewrite-logger] URN_REWRITE_SAMPLE_RATE=${process.env.URN_REWRITE_SAMPLE_RATE} is not in [0, 1]; falling back to 1.0`,
  );
  SAMPLE_RATE = 1.0;
}

/**
 * Emit one log entry per `AliasCategory` that fired during a rewrite.
 *
 * No-op when:
 *   - `inputUrn === canonicalUrn` (no rewrite actually happened), OR
 *   - `rewriteCategories` is empty, OR
 *   - the sample-rate gate rolls "skip".
 *
 * Otherwise emits one structured JSON line per category at INFO level
 * via `console.log` (matching the existing audit pattern in
 * `src/lib/asset/audit.ts`). The shape matches
 * `contracts/canonical-form.md`'s contract:
 *
 *   { level, event, alias_category, input_urn, canonical_urn,
 *     request_id?, user_id?, timestamp }
 */
export function logCanonicalRewrite(
  inputUrn: string,
  canonicalUrn: string,
  rewriteCategories: AliasCategory[],
  context: CanonicalRewriteContext = {},
): void {
  if (inputUrn === canonicalUrn) return;
  if (rewriteCategories.length === 0) return;
  if (!shouldSample()) return;

  const timestamp = new Date().toISOString();
  for (const category of rewriteCategories) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'urn.canonical-rewrite',
        alias_category: category,
        input_urn: inputUrn,
        canonical_urn: canonicalUrn,
        // Spread context AFTER the structured fields so user-supplied
        // keys can't collide with the contract's reserved keys.
        ...(context.requestId !== undefined && { request_id: context.requestId }),
        ...(context.userId !== undefined && { user_id: context.userId }),
        timestamp,
      }),
    );
  }
}

function shouldSample(): boolean {
  // At 1.0 we always log; at 0.0 we never log; in between, uniform
  // Bernoulli draw. Using Math.random is sufficient — the metric we
  // care about (per-category rewrite distribution) only needs an
  // unbiased sample, not unpredictability.
  if (SAMPLE_RATE >= 1) return true;
  if (SAMPLE_RATE <= 0) return false;
  return Math.random() < SAMPLE_RATE;
}

/**
 * Test-only: override the sample rate for the duration of a test. The
 * production module-init read is captured at import time; tests that
 * need deterministic emission (or no emission) call this.
 *
 * Returns a restore function so tests can clean up; pair it with an
 * `afterEach` or `finally`.
 */
export function setSampleRateForTesting(rate: number): () => void {
  const previous = SAMPLE_RATE;
  SAMPLE_RATE = rate;
  return () => {
    SAMPLE_RATE = previous;
  };
}
