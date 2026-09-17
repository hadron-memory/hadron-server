// Subtree-path coordination between node creates and ancestor deletes (#664).
//
// A non-recursive deleteNode / hadron_delete_node refuses to delete a node that
// still has descendants: it counts `loc startsWith 'N:'`, then acts. That count
// is only race-safe if a concurrent create of a descendant is serialized
// against it — otherwise the create can commit between the count and the
// delete, orphaning the just-inserted child under a now-missing prefix.
//
// SERIALIZABLE isolation on the delete alone does NOT close this (the approach
// #664 first tried):
//   - Postgres SSI records read/write conflicts only among SERIALIZABLE
//     transactions, and the create path runs at the default READ COMMITTED, so
//     its insert is invisible to the delete's predicate lock; and
//   - even if both were SERIALIZABLE, a lone rw-antidependency (delete reads the
//     descendant range, create writes into it) is not the two-edge "dangerous
//     structure" SSI aborts on — the create never reads anything the delete
//     writes, because there is no parent-existence check on create (orphans are
//     a tolerated state, 008 FR-015).
//
// The coordination that actually works is an explicit advisory lock keyed on
// each node's ANCESTOR PATH:
//   - a create of `a:b:c` locks its strict ancestors `a` and `a:b`;
//   - a delete of `N` locks `N` itself.
// A delete of `N` therefore contends with the create of ANY descendant, at any
// depth, because that descendant's ancestor set contains `N` (a deep descendant
// is only reachable by first creating the intermediate node, whose own create
// locked `N`). Whoever commits first wins: create-first ⇒ the delete's count
// sees the row and refuses; delete-first ⇒ the create lands under a now-deleted
// prefix, which is the same tolerated "create after delete" outcome the refusal
// never promised to prevent. Semantics are otherwise unchanged — the create is
// serialized, never refused (Model A).
//
// IMPORTANT: the holding transaction must run at READ COMMITTED (the default),
// NOT SERIALIZABLE/REPEATABLE READ. The lock-then-read pattern relies on the
// count getting a FRESH snapshot after the lock is granted; under a frozen
// transaction snapshot the count would be taken as of lock-acquisition time and
// miss a create that committed while we waited for the lock.
//
// The locks are pg_advisory_xact_lock: they release automatically when the
// holding transaction ends, take no row locks, and — acquired root→leaf in a
// consistent order — cannot deadlock with each other or with a single-key
// delete (the delete never waits while holding, so it can't close a cycle).
//
// NOT covered: moveNode, which can relocate an existing node INTO a subtree
// being deleted without passing through these create paths. Coordinating move
// is a tracked follow-up.
import type { Prisma } from '../generated/prisma/index.js';
// Spec 049 §2 S4 — the protected-loc gate every lock helper enforces.
import { assertLocWritable, type ProtectedSource } from './protectedLoc.js';

/**
 * The strict ancestor locs of `loc`, shortest first (root → parent). A loc is a
 * ':'-delimited path, so `a:b:c` has ancestors `['a', 'a:b']`. A root-level loc
 * (no ':') has none. The node's own loc is never included.
 *
 * Root→leaf order is load-bearing: acquiring the advisory locks in this
 * consistent global order is what keeps concurrent creates on overlapping paths
 * deadlock-free.
 */
export function ancestorLocs(loc: string): string[] {
  const segments = loc.split(':');
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join(':'));
  }
  return ancestors;
}

/**
 * Acquire transaction-scoped advisory locks on every strict ancestor of a node
 * being created, so a concurrent ancestor-delete's descendant count cannot miss
 * the new row and orphan it (#664). A root-level loc acquires nothing (no
 * ancestor to coordinate against). Locks are taken root→leaf for a consistent
 * global order (deadlock-free).
 *
 * MUST run inside a READ COMMITTED interactive transaction that also performs
 * the create; the lock is held only for that transaction's lifetime.
 */
/**
 * Spec 049 §2 S4 — every lock helper below is ALSO the protected-loc gate.
 * A generic writer that omits `owns` is REFUSED on any protected address (the
 * safe default); an owning operation passes the ONE source it owns —
 * `{ owns: 'channel' }` for the chat paths, `{ owns: 'declared' }` for the
 * authoring door — and stays subject to the other. See
 * `protectedLoc.ts` for the rule and why the overlap runs both ways.
 *
 * The gate runs AFTER the locks are granted, never before: Channel creation
 * takes the same ancestor keys and commits its row inside that transaction,
 * so a writer that queued behind it re-reads the Channel table on a fresh
 * READ COMMITTED snapshot and sees the row (Codex/Copilot on PR #1165 — a
 * check before the lock was a TOCTOU window the size of the wait).
 */
export interface LockOpts {
  /**
   * The predicate source this caller OWNS. Entries from that source are
   * skipped; every other source still refuses. Deliberately NOT a boolean:
   * a universal bypass let the authoring door write under a Channel and forge
   * chat authorship (@codex + @copilot, both P1, PR #1190).
   */
  owns?: ProtectedSource;
}

async function guard(tx: Prisma.TransactionClient, memoryId: string, locs: string[], op: string, opts?: LockOpts) {
  await assertLocWritable(tx, memoryId, locs, op, opts?.owns);
}

export async function lockAncestorsForCreate(
  tx: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
  opts?: LockOpts,
): Promise<void> {
  for (const ancestor of ancestorLocs(loc)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${ancestor}))`;
  }
  await guard(tx, memoryId, [loc], 'create under', opts);
}

/**
 * Batch form of {@link lockAncestorsForCreate} for a BULK insert of many nodes
 * (e.g. `replaceSubtree`, a git-graph sync). Dedupes the ancestor set across all
 * `locs` and acquires each lock exactly once in a single sorted (root→leaf)
 * pass — the same consistent global order the single-loc helper uses, so a bulk
 * insert can't deadlock against a concurrent create/delete or another bulk
 * insert. Locs with no ancestor (root-level) contribute nothing.
 *
 * MUST run inside the same READ COMMITTED transaction as the inserts.
 */
export async function lockAncestorsForCreateMany(
  tx: Prisma.TransactionClient,
  memoryId: string,
  locs: string[],
  opts?: LockOpts,
): Promise<void> {
  const ancestors = new Set<string>();
  for (const loc of locs) {
    for (const ancestor of ancestorLocs(loc)) ancestors.add(ancestor);
  }
  // Sort so every caller acquires shared ancestors in one global order. Length
  // first keeps it root→leaf (a parent's loc is a prefix, hence shorter, than
  // its child's); the lexical tiebreak makes the order total & stable (returns
  // 0 on equal to satisfy the comparator contract, though the Set makes ties
  // impossible in practice).
  const ordered = [...ancestors].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const ancestor of ordered) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${ancestor}))`;
  }
  await guard(tx, memoryId, locs, 'create under', opts);
}

/**
 * Acquire exactly the locks a create UNDER `parentLoc` would take — `parentLoc`
 * itself plus its strict ancestors — before the child's own loc is known.
 *
 * Identical key set to `lockAncestorsForCreate(tx, memoryId, `${parentLoc}:x`)`
 * for any `x`, and taken in the same root→leaf order, so it neither deadlocks
 * with nor slips past the other helpers here. #919 needs it because a chat
 * message's name embeds a sequence number that can only be allocated once the
 * lock is held: the loc doesn't exist yet at lock time.
 *
 * MUST run inside the same READ COMMITTED transaction as the create.
 */
export async function lockPathForCreateUnder(
  tx: Prisma.TransactionClient,
  memoryId: string,
  parentLoc: string,
  opts?: LockOpts,
): Promise<void> {
  for (const loc of [...ancestorLocs(parentLoc), parentLoc]) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${loc}))`;
  }
  await guard(tx, memoryId, [parentLoc], 'create under', opts);
}

/**
 * Acquire the transaction-scoped advisory lock for WRITING the node at `loc`
 * — the same key `lockNodeForDelete` and an ancestor-create use, so all three
 * serialize against each other on that loc.
 *
 * Take it AFTER `lockAncestorsForCreate` (root→leaf order is what keeps the
 * whole family deadlock-free), and inside the same READ COMMITTED transaction
 * as the write itself.
 *
 * Why a writer needs it (#976 / PR #977 review, both bots): an upsert that
 * decides "create or overwrite?" from a read taken BEFORE the transaction can
 * be wrong by the time it writes — a concurrent create lands in between, and
 * the upsert then silently overwrites that row believing it created it. Holding
 * this lock and re-reading under it makes the decision authoritative: whoever
 * gets the lock second sees the first's committed row (READ COMMITTED takes a
 * fresh snapshot after the grant) and snapshots it to revision history before
 * overwriting.
 */
export async function lockLocForWrite(
  tx: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
  opts?: LockOpts,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${loc}))`;
  await guard(tx, memoryId, [loc], 'write', opts);
}

/**
 * Acquire the transaction-scoped advisory lock for DELETING the node at `loc`,
 * keyed identically to the lock a descendant-create takes on this loc as one of
 * its ancestors (#664). A delete therefore blocks — and is blocked by — any
 * concurrent create anywhere in its subtree.
 *
 * MUST run inside the same READ COMMITTED interactive transaction as the
 * descendant count + the delete, and as its FIRST statement so the count runs
 * on a snapshot taken after the lock is granted.
 */
export async function lockNodeForDelete(
  tx: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
  opts?: LockOpts,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${loc}))`;
  await guard(tx, memoryId, [loc], 'delete', opts);
}
