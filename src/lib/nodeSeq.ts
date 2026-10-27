/**
 * Sibling ordering helper, shared by the two single-node create surfaces
 * (the GraphQL `upsertNode` resolver and the MCP `hadron_create_node` tool) so they
 * assign `seq` identically.
 *
 * Rule (task): when a new node is added to an ALREADY-ORDERED sibling list it
 * should get the next seq, landing at the end. "Ordered" means at least one
 * sibling already carries a `seq`; an unordered (or empty) list is left alone
 * so we never impose an order that wasn't there.
 *
 * Spec: hrn:node:hadronmemory.com:specs:cor:dmo:020:01 (Node ordering).
 */

import type { Prisma } from '../generated/prisma/index.js';

/**
 * The `seq` a NEW node at `loc` should take to append to its sibling list, or
 * `null` when the list isn't ordered (no sibling has a seq) — in which case the
 * caller leaves `seq` null.
 *
 * Siblings = the direct children of the new node's parent loc within the same
 * memory (same depth, same parent prefix) — the same direct-child rule
 * `hadron_get_next_node` uses to walk ordered children.
 * For automatic nested creates, call on the writing transaction AFTER its
 * existing ancestor locks; the parent key serializes read-max plus insert (#443).
 * Root callers take K (`lockRootSiblings`) first (#443, root-only slice).
 *
 * Soft-deleted rows and the node itself are excluded (harmless on a fresh create,
 * correct when an upsert targets an existing loc).
 */
export async function nextSiblingSeq(
  db: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
): Promise<number | null> {
  const depth = loc.split(':').length;
  const parentPrefix = depth > 1 ? loc.slice(0, loc.lastIndexOf(':') + 1) : null;

  // Only seq-bearing siblings matter; narrow by the parent prefix when the new
  // node isn't root-level so we don't scan the whole memory.
  const candidates = await db.node.findMany({
    where: {
      memoryId,
      deletedAt: null,
      seq: { not: null },
      ...(parentPrefix ? { loc: { startsWith: parentPrefix } } : {}),
      // Exclude the node itself; for root-level locs (no parentPrefix) also let
      // the DB drop nested nodes so we don't scan the whole memory's ordered
      // rows (PR #309 review). Array NOT = AND of negations.
      NOT: parentPrefix ? { loc } : [{ loc }, { loc: { contains: ':' } }],
    },
    select: { loc: true, seq: true },
  });

  let max: number | null = null;
  for (const c of candidates) {
    // Direct children only: a `startsWith` prefix also matches deeper
    // descendants, so keep just those at the new node's own depth.
    if (c.loc.split(':').length !== depth) continue;
    if (c.seq != null && (max === null || c.seq > max)) max = c.seq;
  }
  return max === null ? null : max + 1;
}

/**
 * #443 (root-only slice) — the per-memory key K that serializes AUTOMATIC ROOT seq allocation: the in-transaction
 * `max(seq)+1` read and the insert that consumes it. Root creates take no ancestor lock, so without K two of them read the
 * same max and commit a duplicate seq.
 *
 * K is the single-`bigint` advisory form (`objsubid = 1`), which Postgres keeps disjoint from the two-`int4` form every
 * loc/authority key uses (`objsubid = 2`), so no loc key can alias it. The value forces bit 63 = 0 and bit 62 = 1: a
 * sign-extended `int4` single-key (`hashtext(...)`) has all of its top 33 bits equal, so K never equals one either. The
 * remaining aliasing class is a 64-bit `hashtextextended` user that also root-creates; none is on a node-create path.
 *
 * PLACEMENT RULE: take K after every explicit lock the transaction takes and BEFORE its first write another K-holder's
 * suffix could wait on, and hold it to the OUTER commit (xact lock). A K-holder then never waits on an uncommitted write of
 * a K-waiter. Exactly three seams call it (a test greps for that): the GraphQL write core, the MCP create transaction and
 * the reserve-citation seam, which pre-acquires K before it archives a tombstone (`reserveRootSeqLock`).
 */
const ROOT_SEQ_KEY = (memoryId: string) => `node-root-seq:${memoryId}`;

async function takeRootSeqKey(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    (hashtextextended(${ROOT_SEQ_KEY(memoryId)}, 0) | (1::bigint << 62)) & ~(1::bigint << 63))`;
}

/**
 * Per-transaction state lives in a transaction-LOCAL setting, not a JS object, so every wrapper that forwards the same
 * database transaction sees it, and the check-and-set is ONE statement, so two concurrent calls on a transaction cannot
 * both read "no state". Values: '' none; '<memoryId>|1' reserved (one-use handoff); '<memoryId>|0' allocated.
 */
const STATE_SETTING = 'hadron.root_seq_state';

export class RootSeqAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootSeqAllocationError';
  }
}

const SECOND = 'A second root sibling allocation in one transaction is not supported';

async function readState(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ v: string }>>`SELECT coalesce(current_setting(${STATE_SETTING}, true), '') AS v`;
  return rows[0]?.v ?? '';
}

/** Check-and-set in one statement; returns the PRIOR state. */
async function swapState(tx: Prisma.TransactionClient, memoryId: string, reserve: boolean): Promise<string> {
  const reserved = `${memoryId}|1`;
  const taken = `${memoryId}|0`;
  const rows = await tx.$queryRaw<Array<{ v: string }>>`
    WITH prev AS (SELECT coalesce(current_setting(${STATE_SETTING}, true), '') AS v)
    SELECT v, set_config(${STATE_SETTING},
      CASE WHEN v = '' THEN ${reserve ? reserved : taken} WHEN v = ${reserved} AND NOT ${reserve} THEN ${taken} ELSE v END,
      true) AS s FROM prev`;
  return rows[0]?.v ?? '';
}

/**
 * Refuse a second root allocation BEFORE the caller takes any lock of its own (the placement rule forbids a pre-K lock
 * after K). Passes when nothing was allocated, or when a reservation for this memory is waiting to be consumed.
 */
export async function assertRootAllocationAllowed(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  const v = await readState(tx);
  if (v !== '' && v !== `${memoryId}|1`) throw new RootSeqAllocationError(SECOND);
}

/**
 * Take K for the root allocation about to happen in this transaction. Re-entrant at the database, but the transaction may
 * allocate a root seq ONCE: a second allocation would take its pre-K locks after K, which the placement rule forbids, so it
 * is refused and the transaction rolls back. A one-use reservation from `reserveRootSeqLock` for the same memory is
 * consumed by the first allocation.
 */
export async function lockRootSiblings(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  const prev = await swapState(tx, memoryId, false);
  if (prev === `${memoryId}|1`) return;
  if (prev !== '') throw new RootSeqAllocationError(SECOND);
  await takeRootSeqKey(tx, memoryId);
}

/**
 * Pre-acquire K for the root allocation this transaction will make next, and record it as a one-use reservation. Used by the
 * reserve-citation seam, which must hold K before it archives a tombstone's edges (uncommitted writes) and then enters the
 * create core for its first and only root allocation.
 */
export async function reserveRootSeqLock(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  const prev = await swapState(tx, memoryId, true);
  if (prev !== '') throw new RootSeqAllocationError(SECOND);
  await takeRootSeqKey(tx, memoryId);
}
