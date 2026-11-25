/**
 * #5014 (Billing A6, local review P2 at 601ab494): a ledger entry written for a person AFTER an account merge committed, or a
 * settlement computed for the merged-away person that inserts after the merge, names the merged-away account: the merge's one
 * UPDATE (`DIRECT_USER_REFERENCES`, mergeUsers.ts) moves only the rows that exist at that moment, and a read-committed insert that
 * resolved the person before the merge is not constrained by it. The money would stay on an account nobody can name, and a
 * settlement pair taken there would keep the survivor's expired credit in its balance for good (cor:dmo:170:10).
 *
 * The append-only trigger (prisma/credit-ledger-invariants.sql) already allows exactly one move of `owner_user_id`: from a person
 * to the person they were merged into, along a `user_merges` row. This re-applies that move to every entry still owned by a merge
 * source, which covers every interleaving: the survivor's own read runs it first (so the survivor's balance is current), and
 * the hourly job runs it for everyone. It writes `owner_user_id` and nothing else (the other columns, `updated_at` included, are
 * frozen by the trigger), and it is idempotent: with nothing stranded it changes no row.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

/** A chain of merges (S into T, then T into U) is followed one hop per pass; this many hops is far beyond any real chain. */
const MAX_HOPS = 8;

/**
 * Re-point entries owned by a merged-away person to their survivor. With `survivor`, only the entries of that survivor's direct
 * merge sources (one indexed range: the survivor's balance read); without it, every stranded entry, hop by hop. Returns the
 * number of entries moved.
 */
export async function repointMergedLedgerOwners(db: PrismaClient, opts: { survivor?: string } = {}): Promise<number> {
  let moved = 0;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const survivorFilter = opts.survivor === undefined ? Prisma.empty : Prisma.sql`AND m.target_user_id = ${opts.survivor}`;
    const n = await db.$executeRaw(Prisma.sql`
      UPDATE credit_ledger_entries e
         SET owner_user_id = m.target_user_id
        FROM user_merges m
       WHERE e.owner_user_id = m.source_user_id
         ${survivorFilter}`);
    moved += n;
    if (n === 0 || opts.survivor !== undefined) break;
  }
  return moved;
}
