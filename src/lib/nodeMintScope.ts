import { Prisma } from '../generated/prisma/index.js';

/**
 * #1612 — which live nodes a mint (and the bulk approval that clears it) covers
 * (cor:dmo:120:06, :03). A node is in scope when it was never minted, OR it was
 * minted and its content changed since the revision that was certified, OR it
 * was minted with no recorded revision (a backfilled row: it certifies nothing,
 * so it is treated like an edited node and needs one approval, R197).
 *
 * "Changed" is content-only (#1611): `contentRevSeq` does not advance on a
 * tags-only edit, so such an edit leaves a minted node out of scope.
 */
export function inMintScope(n: {
  mintedAt: Date | null;
  mintedRevNo: number | null;
  contentRevSeq: number;
}): boolean {
  return n.mintedAt === null || n.mintedRevNo === null || n.contentRevSeq > n.mintedRevNo;
}

/** SQL twin of {@link inMintScope} over the `nodes` table; the two must agree. */
export const MINT_SCOPE_SQL = Prisma.sql`(minted_at IS NULL OR minted_rev_no IS NULL OR content_rev_seq > minted_rev_no)`;
