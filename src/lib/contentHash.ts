import { createHash } from 'crypto';

/**
 * Compute the canonical content fingerprint used by
 * `Node.abstractOriginHash` and by spec 032's read-time staleness check.
 * SHA-256 truncated to the first 8 hex chars (32-bit fingerprint).
 *
 * Returns `null` for null / undefined / empty input so the column-level
 * "no content → no hash" invariant holds without callers having to
 * branch on emptiness.
 *
 * The hash is computed over the **plaintext** content. On encrypted
 * memories, callers MUST surface plaintext content before invoking
 * this helper (spec 032 FR-009). For `hadron_get_node`, `decryptNodesBatch`
 * runs before the staleness check. For `hadron_validate`, the staleness
 * check is gated on `!memory.isEncrypted` in v1 (the validator doesn't
 * decrypt); the encryption-parity follow-up will lift that gate.
 *
 * Width / collision rationale: 32 bits is plenty for change-detection
 * at the row counts this database handles (memories with at most ~tens
 * of thousands of nodes). Birthday-bound collision becomes probable
 * around `2^16 ≈ 65,000` distinct content versions; the worst-case
 * failure mode is one stale abstract treated as fresh → one misleading
 * RAG embedding (recoverable). See spec 032 Edge Cases for the
 * quantification and the migration path to 64 bits if/when needed.
 *
 * The width matches `Node.contentHash`'s existing convention but the
 * two columns live in DIFFERENT hash domains: `contentHash` is
 * `SHA256(yaml+md)` set by external producers; `abstractOriginHash`
 * is `SHA256(content)` set by this helper. They are NEVER compared
 * against each other — see spec 032 data-model.md "What is NOT".
 */
export function computeContentHash(content: string | null | undefined): string | null {
  if (content == null || content === '') return null;
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
}
