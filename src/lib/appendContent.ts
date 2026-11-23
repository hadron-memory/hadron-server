/**
 * #340 — the join behind `appendContent` / `prependContent` on hadron_update_node.
 *
 * Only the NON-EMPTY parts among the prepended text, the existing body and the
 * appended text are joined, with `separator` (default {@link DEFAULT_APPEND_SEPARATOR},
 * `""` allowed) between them. So a `null` or `""` body gains no stray separator,
 * and an empty `appendContent` / `prependContent` contributes nothing. Empty means
 * `null` or `""` only: a whitespace-only body is content and is kept (Xavier's
 * disposition on the issue). When every part is empty the existing body is
 * returned unchanged, so a `null` body stays `null` (the caller's no-change return).
 *
 * The caller MUST pass the body read under the row lock, never a pre-lock probe:
 * a join built from a probe loses one of two concurrent appends.
 */
export const DEFAULT_APPEND_SEPARATOR = '\n\n';

export function joinAppendedContent(
  existing: string | null,
  parts: { prependContent?: string; appendContent?: string; separator?: string },
): string | null {
  const pieces = [parts.prependContent, existing, parts.appendContent].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  if (pieces.length === 0) return existing;
  return pieces.join(parts.separator ?? DEFAULT_APPEND_SEPARATOR);
}
