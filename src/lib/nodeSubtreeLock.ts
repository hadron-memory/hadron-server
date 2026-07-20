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
export async function lockAncestorsForCreate(
  tx: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
): Promise<void> {
  for (const ancestor of ancestorLocs(loc)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${ancestor}))`;
  }
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
): Promise<void> {
  const ancestors = new Set<string>();
  for (const loc of locs) {
    for (const ancestor of ancestorLocs(loc)) ancestors.add(ancestor);
  }
  // Sort so every caller acquires shared ancestors in one global order. Length
  // first keeps it root→leaf (a parent's loc is a prefix, hence shorter, than
  // its child's); the lexical tiebreak just makes the order total & stable.
  const ordered = [...ancestors].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  for (const ancestor of ordered) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${ancestor}))`;
  }
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
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memoryId}), hashtext(${loc}))`;
}
