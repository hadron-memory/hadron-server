import { z } from 'zod';

/**
 * Lenient `tags` input for the node-write MCP tools — h-add-node,
 * h-update-node, h-add-parent-node (hadron-server#246).
 *
 * LLM/MCP callers (and humans hand-writing tool args) very commonly pass a
 * comma-separated *string* for this array-of-strings field, e.g.
 * `"portal,nodelist,pagination"`. The strict `z.array(z.string())` rejects
 * that with a clear-but-avoidable validation error; `tags` is the field
 * most likely to be fed loosely. So coerce: a string is split on commas,
 * each entry trimmed, and empty/whitespace-only entries dropped before
 * validation. Arrays pass through untouched, and genuinely malformed input
 * (number, object, array-with-non-string) still fails with the strict
 * array error.
 *
 * Deliberately NOT applied to `edges` — those are structured objects where
 * the same leniency would mask real mistakes.
 *
 * Note the interaction with the partial-update contract (hadron-cli#37):
 * the schema is used as `tagsInputSchema.optional()`, so an *omitted* tags
 * stays `undefined` (→ preserve on h-update-node). A string that reduces to
 * nothing (`""`, `" , "`) coerces to `[]`, i.e. an explicit clear.
 */
export const tagsInputSchema = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : v,
  z.array(z.string()),
);
