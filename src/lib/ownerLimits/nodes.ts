/**
 * #5015 (Billing A7b): the `nodes` key at the node doors. A write that adds a live node to an owner (an insert, a deleted
 * node brought back, a node moved in from another owner) either refuses at the owner's limit or counts and is never
 * refused; an update, or a move inside one owner, adds nothing (cor:acl:150:04, Proposed). Which doors refuse is listed,
 * per call site, in `writeDoorsGuard5015.test.ts`.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { ownerRefOf, type OwnerRef } from '../owner.js';
import { requireOwnerHeadroom } from './gate.js';

/**
 * What a node writer does at the owner's `nodes` limit. REQUIRED on `writeNodeCoreRaw` (beside `authoring`), so a new
 * call site states it and cannot skip the check by omission. Read only on a write that adds a live node.
 * - `refuse`: the write is refused with `OWNER_LIMIT_REACHED` when the owner has no room.
 * - `count-only`: the node counts toward the owner's total and the write is never refused (cor:acl:150:04's exception).
 */
export type NodeOwnerLimit = 'refuse' | 'count-only';

/**
 * The person whose act a write is, for the refusal's form: the request's user, or null for an App key, the system seam, a
 * webhook or boot sync, and an impersonated request (A7a: under impersonation the refusal names no owner and no number).
 */
export function ownerLimitCaller(ctx: { userId?: string | null; impersonation?: unknown }): { userId: string } | null {
  return ctx.userId && !ctx.impersonation ? { userId: ctx.userId } : null;
}

/**
 * The owner of a memory, read on the transaction. The caller must already hold the memory row (FOR SHARE or FOR UPDATE):
 * `transferMemoryOwnership` takes it FOR UPDATE, so the owner read here is the one that holds the memory when the write
 * commits (finding `node-write-owner-transfer-race`).
 */
export async function memoryOwnerInTx(tx: Pick<Prisma.TransactionClient, 'memory'>, memoryId: string): Promise<OwnerRef | null> {
  const row = await tx.memory.findUnique({ where: { id: memoryId }, select: { organizationId: true, ownerUserId: true } });
  return ownerRefOf(row);
}

/**
 * Refuse when the owner of `memoryId` has no room for `amount` more live nodes. The helper's advisory key is the LAST lock
 * a door takes (A7a; gate ruling 5): call this after the door's subtree, loc, memory and row locks, right before the write.
 * After it a door only writes rows it already holds and inserts at locs whose advisory key it holds.
 * A memory always has exactly one owner (`chk_memory_owner_xor`), so the no-owner return is only for a row that is gone.
 */
export async function requireNodeHeadroom(
  tx: Prisma.TransactionClient,
  { memoryId, amount = 1n, caller, alreadyWritten }: {
    memoryId: string; amount?: bigint; caller: { userId: string } | null;
    /** See `requireOwnerHeadroom`: the part of `amount` this transaction already wrote. */
    alreadyWritten?: bigint;
  },
): Promise<void> {
  if (amount < 0n) throw new Error('requireNodeHeadroom: amount must not be negative');
  if (amount === 0n) return;
  const owner = await memoryOwnerInTx(tx, memoryId);
  if (!owner) return;
  await requireOwnerHeadroom(tx, { owner, key: 'nodes', amount, caller, alreadyWritten });
}

/** Two memories have the same owner: a move or merge between them adds nothing to either owner. */
export async function sameMemoryOwner(tx: Pick<Prisma.TransactionClient, 'memory'>, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const oa = await memoryOwnerInTx(tx, a);
  const ob = await memoryOwnerInTx(tx, b);
  if (!oa || !ob) return false;
  return 'userId' in oa ? 'userId' in ob && oa.userId === ob.userId : 'organizationId' in ob && oa.organizationId === ob.organizationId;
}
