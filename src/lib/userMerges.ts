/**
 * #1715 — merge-aware identity (decisions S2, #1641).
 *
 * `mergeUsers` soft-deletes the source account and records the merge in
 * `user_merges` (source → target). Most user references are rewritten by the
 * merge, but some sit inside authenticated data that must never be rewritten:
 * a decision's asker and deciders, a decision log's default and eligible
 * deciders. Their hashes (and, from #1614, signatures) cover those ids.
 *
 * So readers follow a stored id through the merges instead, transitively: A
 * merged into B, then B into C, resolves A to C. Chains can't loop, because a
 * merged-away account is soft-deleted and a merge refuses a deleted target.
 *
 * Two directions, for two kinds of question:
 * - {@link identitiesOf}: every id that now means this user (the user plus
 *   every account merged into it). For gates that ask "is the caller named
 *   here?": the caller is named when any of these ids is.
 * - {@link mergeLinksFrom}: the merge links reachable from some stored ids, to
 *   find who each now is ({@link survivorOf}) and to show the merge.
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

type Db = Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient;

/** One merge: `sourceUserId` was merged into `targetUserId`. */
export type UserMergeLink = {
  sourceUserId: string;
  targetUserId: string;
  mergedAt: Date;
};

/**
 * Every id that now means `userId`: itself, plus every account merged into
 * it, directly or through a chain. Read on the given client, so a gate inside
 * a transaction sees the merges as of that transaction.
 */
export async function identitiesOf(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE ids(id) AS (
      SELECT ${userId}::text
      UNION
      SELECT m.source_user_id FROM user_merges m JOIN ids ON m.target_user_id = ids.id
    )
    SELECT id FROM ids`;
  return new Set(rows.map((r) => r.id));
}

/** The merge links reachable from `ids`: each id's merge, its target's merge, and so on. */
export async function mergeLinksFrom(db: Db, ids: readonly string[]): Promise<UserMergeLink[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ source_user_id: string; target_user_id: string; merged_at: Date }>>`
    WITH RECURSIVE links AS (
      SELECT source_user_id, target_user_id, merged_at FROM user_merges
      WHERE source_user_id = ANY(${[...new Set(ids)]}::text[])
      UNION
      SELECT m.source_user_id, m.target_user_id, m.merged_at
      FROM user_merges m JOIN links l ON m.source_user_id = l.target_user_id
    )
    SELECT source_user_id, target_user_id, merged_at FROM links ORDER BY merged_at, source_user_id`;
  return rows.map((r) => ({ sourceUserId: r.source_user_id, targetUserId: r.target_user_id, mergedAt: r.merged_at }));
}

/** The account `id` now is: the end of its merge chain in `links`, or itself. */
export function survivorOf(links: readonly UserMergeLink[], id: string): string {
  const next = new Map(links.map((l) => [l.sourceUserId, l.targetUserId]));
  let current = id;
  // Bounded by the number of links, so a corrupt cycle can't spin.
  for (let i = 0; i <= next.size && next.has(current); i++) current = next.get(current)!;
  return current;
}

/**
 * Each id mapped to the account it now is, deduplicated in first-seen order.
 * For a NEW write that names users: it stores who they are now, so a merged-away
 * id never enters a fresh record. Existing records are never rewritten.
 */
export async function survivorsOf(db: Db, ids: readonly string[]): Promise<string[]> {
  const links = await mergeLinksFrom(db, ids);
  return [...new Set(ids.map((id) => survivorOf(links, id)))];
}
