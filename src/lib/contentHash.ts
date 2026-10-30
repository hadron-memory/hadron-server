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

/**
 * Spec 032 FR-010 — is this node's abstract UNCONFIRMED against its current
 * content? The one home for the `Source: abstract-stale` / `[stale-abstract]`
 * predicate, shared by `hadron_get_node`, `hadron_find_nodes` and
 * `hadron_validate` (#1128). It was written out three times before, which is
 * the drift this repo already warns about for access gates: three copies of a
 * rule stay in step only until someone edits one.
 *
 * True when the node HAS both an abstract and content, and the fingerprint
 * either DISAGREES with the content or is ABSENT.
 *
 * The absent case is the #1128 change, and it is a correction rather than a
 * widening. The old predicate required a non-null hash, so it could not fire
 * for an abstract written before the body existed: FR-007 gives such an
 * abstract a null hash, a later content-only update preserves that null, and
 * the guard then read the null as "nothing to check". The result was that the
 * ordering most likely to produce a mismatched abstract — write the summary,
 * add the body afterwards — was the one ordering that raised no signal, and a
 * missing marker there was indistinguishable from a verified one.
 *
 * That guard was correct when spec 032 shipped, because every row predated it
 * and would have fired. Its premise then drained away: every write since
 * re-stamps the hash, so the unfingerprinted population fell to a rounding
 * error, and the rows that remained genuinely DID have unverified abstracts —
 * arming on them is accurate, not noise. A gate can outlive its premise; this
 * one did. (Counts as measured are on #1128 rather than here, since they move.)
 *
 * Deliberately NOT a second marker string. The reader's action is identical
 * either way — open both and compare — so `abstract-stale` keeps its meaning
 * of "do not trust this abstract until you have checked it" and gains no
 * competing vocabulary that clients would have to learn and parse.
 *
 * Callers keep their own ENCRYPTION gates: this compares plaintext, and
 * whether plaintext is in hand is a property of the call site (an unlocked
 * session, a non-encrypted memory), not of the node.
 */
export function isAbstractUnverified(node: {
  abstract: string | null;
  content: string | null;
  abstractOriginHash: string | null;
}, contentPresent?: boolean): boolean {
  if (node.abstract == null || node.abstract.length === 0) return false;
  // A missing fingerprint can only be unconfirmed, never hash-verified. A
  // read holding the node lock may supply plaintext presence without materializing its body.
  // A real fingerprint always keeps the existing plaintext hash comparison.
  if (node.abstractOriginHash == null && contentPresent !== undefined) return contentPresent;
  if (node.content == null || node.content.length === 0) return false;
  return node.abstractOriginHash !== computeContentHash(node.content);
}
