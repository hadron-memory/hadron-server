/**
 * hadron-server#5352 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, Edge case "An entry is never written for a deleted owner",
 * Decided, Holger 2026-11-27): an append to the credit ledger that finds its owner deleted when it commits is refused and writes
 * nothing, so no entry ever names a deleted owner and none is written without one.
 *
 * Every append (A1's insert-or-replay for grants and adjustments, a debit, A4's settlements, and through them the period grant)
 * runs its insert in ONE transaction with {@link lockLedgerOwnerForAppend} first. The owner row is taken FOR KEY SHARE, which
 * conflicts with the FOR UPDATE that both deletions take on it (deleteUser's person row; softDeleteOrganizationCore's
 * organization row), so an append that reaches the row while a deletion is open waits for it and, under READ COMMITTED, reads
 * the row as the deletion left it. The other order (the append holds the row and commits while a deletion waits) is the
 * deletion's to handle: under READ COMMITTED its clear sees the committed entry; under SERIALIZABLE it calls
 * {@link assertLedgerSnapshotFresh} after its owner lock.
 *
 * "Deleted" means erased: a person whose row is soft-deleted because they were MERGED into another (a `user_merges` row names
 * them as the source) is not refused. #5014's repoint (repointMergedOwners.ts) exists to move such an append to the survivor,
 * and refusing it would drop a debit or a grant instead (Peter, team chat #154408, on Brooks's Q1 #154404).
 */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { AuthoritySnapshotStale } from '../auth/authorityAnchors.js';
import { ownerColumns, ownerWhere, type OwnerRef } from '../owner.js';

/**
 * The append's owner is deleted (or gone): nothing was written. Carries no id; a GraphQL door maps it to the not-found answer it
 * gives for a deleted owner at resolution, so the race reads exactly as the sequential case.
 */
export class LedgerOwnerDeletedError extends Error {
  constructor() {
    super('The ledger owner is deleted; nothing was written.');
    this.name = 'LedgerOwnerDeletedError';
  }
}

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Take the owner row FOR KEY SHARE and judge it under that lock; throws {@link LedgerOwnerDeletedError} when the owner is deleted
 * (or has no row). The projection is read from the locked row version: under READ COMMITTED, a wait for a deletion's FOR UPDATE
 * returns the row as that deletion committed it. Must run inside the append's transaction, before its insert. A merged-away
 * person is admitted (module comment); the merge record is read in a statement of its own, after the lock, so under READ
 * COMMITTED it sees a merge that committed while this append waited.
 */
export async function lockLedgerOwnerForAppend(tx: RawTx, owner: OwnerRef): Promise<void> {
  const cols = ownerColumns(owner);
  if (cols.organizationId != null) {
    const rows = await tx.$queryRaw<{ live: boolean }[]>`
      SELECT deleted_at IS NULL AS live FROM organizations WHERE id = ${cols.organizationId} FOR KEY SHARE`;
    if (rows[0]?.live !== true) throw new LedgerOwnerDeletedError();
    return;
  }
  const userId = cols.ownerUserId as string;
  const rows = await tx.$queryRaw<{ live: boolean }[]>`
    SELECT deleted_at IS NULL AS live FROM users WHERE id = ${userId} FOR KEY SHARE`;
  if (rows[0]?.live === true) return;
  if (rows[0]) {
    const merged = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM user_merges WHERE source_user_id = ${userId}`;
    if (merged.length > 0) return;
  }
  throw new LedgerOwnerDeletedError();
}

/**
 * Run `write` in one transaction after {@link lockLedgerOwnerForAppend}. A caller already inside a transaction says so with
 * `inTransaction` (said, since test doubles in this codebase hand a `$transaction` to transaction clients too; a client with no
 * `$transaction`, a real transaction client, is one whatever the flag says), and gets the
 * lock and the write in ITS transaction: `settleAndMeasure`, inside `creditBalance`'s REPEATABLE READ snapshot, where a deletion
 * committed after the snapshot makes the lock raise a serialization failure that the read already handles (ruling 10.4).
 */
export async function appendForLiveOwner<T>(
  db: PrismaClient,
  owner: OwnerRef,
  write: (tx: PrismaClient) => Promise<T>,
  opts: { inTransaction?: boolean } = {},
): Promise<T> {
  // A real interactive transaction client has no `$transaction`: that is a transaction too, flag or not.
  if (opts.inTransaction || typeof (db as { $transaction?: unknown }).$transaction !== 'function') {
    await lockLedgerOwnerForAppend(db, owner);
    return write(db);
  }
  return db.$transaction(async (tx) => {
    await lockLedgerOwnerForAppend(tx, owner);
    return write(tx as unknown as PrismaClient);
  });
}

/**
 * For a SERIALIZABLE deletion, called once it holds the owner row FOR UPDATE (#5352): its snapshot was taken at its first
 * statement, so an append that committed after that (and before the lock, or while the lock waited for it) is invisible to the
 * deletion's clear. While the lock is held no new entry can name the owner (every append and the FK check take the row FOR KEY
 * SHARE), so a fresh read on `db` that counts more entries than the snapshot proves the snapshot stale; it throws
 * {@link AuthoritySnapshotStale}, which `retryOnSerializationFailure` re-runs. Precedent: `assertOwnerLimitSnapshotFresh`.
 */
export async function assertLedgerSnapshotFresh(
  tx: Pick<Prisma.TransactionClient, 'creditLedgerEntry'>,
  db: Pick<PrismaClient, 'creditLedgerEntry'>,
  owner: OwnerRef,
): Promise<void> {
  const where = ownerWhere(owner);
  if ((await tx.creditLedgerEntry.count({ where })) !== (await db.creditLedgerEntry.count({ where }))) {
    throw new AuthoritySnapshotStale();
  }
}
