import { Prisma } from '../../generated/prisma/index.js';

/**
 * #3899 (#2494): the ONE PostgreSQL expression that fingerprints a node's STORED
 * content bytes, shared by structural capture and the global coverage verifier so
 * the two can never drift apart. cor:sec:040:03 / cor:sec:040:01: the bytes are
 * hashed inside PostgreSQL exactly as stored (sealed ciphertext stays sealed, no
 * key is used, no content is selected into the application). NULL and text are
 * discriminated ('null' vs 'text:' || content), so NULL differs from ''.
 *
 * The column is chosen from a closed set of literals, never caller text, and the
 * result is a fragment with no parameters of its own. R1 dormant helper support:
 * this adds no caller, activation or schema change.
 */
export type StoredContentColumn = 'content' | 'n.content';

export function storedByteFingerprintSql(column: StoredContentColumn): Prisma.Sql {
  const col = column === 'n.content' ? Prisma.raw('n.content') : Prisma.raw('content');
  return Prisma.sql`encode(sha256(convert_to(CASE WHEN ${col} IS NULL THEN 'null' ELSE 'text:' || ${col} END, 'UTF8')), 'hex')`;
}
