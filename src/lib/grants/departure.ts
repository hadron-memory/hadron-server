/**
 * #3690 (S2a-h): a grant ENDS when its holder goes, and the record stays (cor:acl:140:03 Moves and How It Ends; :01
 * Relationships; ruling 0255 item 3, and 0259 for `retireWorker` and every agent delete, soft delete included).
 *
 * Two halves, one rule. A HARD delete of a holder row (an erasure's cascade, `deleteWorker`, a tombstone reclaim, the owner
 * rename's raw SQL) is ended by the AFTER DELETE triggers in prisma/grant-invariants.sql, so no path can be missed. The SOFT
 * deletes fire no delete, so each door calls {@link endHeldGrants} in its own transaction: a person's erasure, `retireWorker`,
 * `deleteAgent` and `deleteApp`.
 *
 * The stamp `holder_departed_at` is a FACT, like `revoked_at`; no state label is chosen for the ended grant (`:03` Open). It is
 * set once and only on a grant not already ended (the first end stands), and `isGrantLive` / `grantLiveSql` read it.
 * LOCK ORDER: the grant row lock is the LAST lock a departing transaction takes. Each caller runs this after its own locks
 * (the holder row among them), and anything that locks a grant row and then a holder row can deadlock against it.
 */
import { Prisma } from '../../generated/prisma/index.js';
import { GRANT_DB_NOW } from './live.js';

export type GrantHolderKind = 'user' | 'agent' | 'worker' | 'app';

/** The sealed holder column each kind lives in (an identifier from this closed map, never from input). */
const HOLDER_COLUMN: Record<GrantHolderKind, string> = { user: 'user_id', agent: 'agent_id', worker: 'worker_id', app: 'grantee_app_id' };

/**
 * End every grant `holderId` holds that has not already ended, in the caller's transaction. Returns how many it ended.
 * A grant already revoked, departed, EXPIRED or SPENT (an activated grant past its expiry or at its count) keeps its first end; a grant whose own App is gone is skipped (its row is
 * deleted with the App). Never throws for "no grants".
 */
export async function endHeldGrants(tx: Prisma.TransactionClient, kind: GrantHolderKind, holderId: string): Promise<number> {
  const column = Prisma.raw(`grants."${HOLDER_COLUMN[kind]}"`);
  // Lock FIRST, judge SECOND, in two statements (the pattern live.ts documents): one UPDATE judges "has it expired" before it
  // waits for the row lock, so a grant that expired while the departure waited behind another transaction would still be stamped.
  // The second statement reads the database clock after the locks are held. Locked in id order, so two departures cannot deadlock.
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM grants WHERE ${column} = ${holderId} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
    ORDER BY id FOR UPDATE`);
  return tx.$executeRaw(Prisma.sql`
    UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW}
    WHERE ${column} = ${holderId} AND holder_departed_at IS NULL AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
      AND NOT (activated_at IS NOT NULL AND ((expires_at IS NOT NULL AND expires_at <= ${GRANT_DB_NOW})
        OR (max_uses IS NOT NULL AND use_count >= max_uses)))`);
}
