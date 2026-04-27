/**
 * Validation for ExtractionSpec arrays — rejects entries whose `field`
 * collides with the reserved namespace `message.data.exception(s)`.
 *
 * Per spec FR-013: the platform must reject any extraction-spec save
 * attempting to write into `message.data.exception` or
 * `message.data.exceptions[]`. These names are reserved for the future
 * agent-exceptions feature (separate spec).
 *
 * The check applies at the level of `field` names because the extraction
 * spec writes each entry into `message.data.<field>` at ingestion time —
 * so an entry with `field: "exception"` would land under
 * `message.data.exception`, which is exactly what we forbid.
 */

import type { EvaluationError } from './errors.js';

/** Shape of one extraction-spec entry as it appears in node data. */
export interface ExtractionSpecEntry {
  field: string;
  description?: string;
  shape?: string;
}

export type ExtractionSpecValidateResult =
  | { ok: true }
  | { ok: false; error: EvaluationError };

/**
 * Reject extraction-spec arrays whose entries write into the reserved
 * exception namespace.
 *
 * The check matches a field name that:
 *   - is exactly "exception" or "exceptions", or
 *   - starts with "exception." or "exceptions." (a sub-path), or
 *   - starts with "exception[" or "exceptions[" (an array index).
 *
 * The dot-path / array-index forms aren't expected from the existing
 * extraction-spec format — entries are normally bare field names — but
 * we guard them defensively in case the format grows.
 */
export function validateExtractionSpec(
  entries: ReadonlyArray<ExtractionSpecEntry>,
): ExtractionSpecValidateResult {
  for (const entry of entries) {
    if (!entry || typeof entry.field !== 'string') continue;
    const f = entry.field;
    const reserved = ['exception', 'exceptions'];
    for (const r of reserved) {
      if (
        f === r ||
        f.startsWith(r + '.') ||
        f.startsWith(r + '[')
      ) {
        return {
          ok: false,
          error: {
            code: 'RESERVED_NAME',
            message: `extraction-spec entry field '${f}' writes into reserved namespace 'message.data.${r}'`,
            detail: { field: `message.data.${f}` },
          },
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Convenience: scan a node-data object for extraction-spec arrays
 * (`agentExtractionSpec` for agent-config nodes, `extractionSpec` for
 * conversation- and stage-level nodes) and validate each. Returns the
 * first error found.
 */
export function validateNodeDataExtractionSpecs(
  data: unknown,
): ExtractionSpecValidateResult {
  if (data === null || typeof data !== 'object') return { ok: true };
  const d = data as Record<string, unknown>;
  for (const key of ['agentExtractionSpec', 'extractionSpec']) {
    const v = d[key];
    if (Array.isArray(v)) {
      const result = validateExtractionSpec(v as ExtractionSpecEntry[]);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}
