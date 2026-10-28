import { Prisma } from '../generated/prisma/index.js';

/**
 * #1612 (cor:dmo:120:06) — whether a live node belongs in the next mint and
 * the next bulk approval: it was never minted, it was minted with no recorded
 * revision (a backfilled row, in scope like an edited node), or its content
 * changed after the revision it was minted at. A tags-only edit does not
 * advance `contentRevSeq`, so it stays out. Mirrors {@link inMintScopeSql}.
 */
export function inMintScope(n: {
  mintedAt: Date | null;
  mintedRevNo: number | null;
  contentRevSeq: number;
}): boolean {
  return n.mintedAt === null || n.mintedRevNo === null || n.contentRevSeq > n.mintedRevNo;
}

/** The SQL twin of {@link inMintScope}, over the `nodes` row of the enclosing query. */
export const inMintScopeSql = Prisma.sql`(minted_at IS NULL OR minted_rev_no IS NULL OR content_rev_seq > minted_rev_no)`;
