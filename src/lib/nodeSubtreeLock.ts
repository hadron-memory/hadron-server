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
// holding transaction ends and take no row locks. Multi-key sets are acquired
// in signed resolved-key order (#1214), including when distinct inputs collide.
// Callers must declare their complete set before taking any of its locks.
//
// NOT covered: moveNode, which can relocate an existing node INTO a subtree
// being deleted without passing through these create paths. Coordinating move
// is a tracked follow-up.
import type { Prisma } from '../generated/prisma/index.js';
// Spec 049 §2 S4 — the protected-loc gate every lock helper enforces.
import { assertLocWritable, type ProtectedSource } from './protectedLoc.js';

/**
 * One advisory key in the `(memoryId, loc)` space every helper here shares.
 */
export interface LockKey {
  memoryId: string;
  loc: string;
}

/**
 * Stable input-space order: memory, then loc length and lexical order (#1187).
 * Ancestor enumeration remains root→leaf, but this is NOT an advisory-lock
 * acquisition order: hashtext collisions can invert it (#1214).
 * {@link acquireLockSet} orders the actual signed PostgreSQL key pairs.
 */
export function compareLockKeys(a: LockKey, b: LockKey): number {
  if (a.memoryId !== b.memoryId) return a.memoryId < b.memoryId ? -1 : 1;
  return a.loc.length - b.loc.length || (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0);
}

/**
 * Acquire a caller's COMPLETE advisory key set, deduped and in the one global
 * order — the protocol #1187 exists to establish.
 *
 * **The rule: a call site that needs more than one key declares them all here,
 * once, before doing anything else.** It may then call the individual helpers
 * below for their gate and revalidation behaviour; those re-acquisitions are
 * free, because `pg_advisory_xact_lock` is RE-ENTRANT within a transaction
 * (measured, not assumed: three acquisitions of one key in one transaction
 * succeed, and the lock is released once at transaction end regardless).
 *
 * That re-entrancy is what makes this minimally invasive — the helpers keep
 * their own semantics and a caller's lock SET is unchanged; only the order in
 * which it first takes them moves.
 *
 * **Why an order had to be imposed at all.** The four helpers share one key
 * space and their callers had no common order: bulk sorted length-first, merge
 * took target-then-source, move took destination-then-source, create took its
 * ancestor path. Individually deterministic; collectively not a protocol. #1184
 * added one edge to the create path and produced three pairwise inversions in
 * three review rounds, each from a locally-correct repair of the last — the
 * signature of a missing global invariant rather than of three bugs.
 *
 * **Scope note.** `lockMemoryForChannelChange` (`src/lib/channels.ts`) keys the
 * ONE-ARGUMENT advisory space, which Postgres keeps disjoint from this
 * two-argument one, so it can never contend with a key here. It is still
 * ordered against them by convention: **memory-scope keys before loc-scope
 * keys**, which is what `ensureChannelWithRoot` already does.
 */
export async function acquireLockSet(tx: Prisma.TransactionClient, keys: LockKey[]): Promise<void> {
  const seen = new Set<string>();
  const unique: LockKey[] = [];
  for (const k of keys) {
    // `\0` as the separator, written as the ESCAPE and not the raw byte: a NUL
    // cannot occur in a memory id or a loc, so the composite key is unambiguous
    // where a `:` or a space would not be — but a literal NUL in a source file
    // makes grep skip the whole file, which `noLiteralNulBytes.test.ts` fails on.
    const id = `${k.memoryId}\0${k.loc}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(k);
  }
  if (unique.length === 0) return;
  if (unique.length === 1) {
    // Preserve the single-key path: no resolution round trip is needed.
    const k = unique[0];
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k.memoryId}), hashtext(${k.loc}))`;
    return;
  }
  // #1214: resolve the COMPLETE set in one round trip. Input-space ordering
  // cannot prevent a collision X=Y from inverting against an intervening Z.
  const resolved = await tx.$queryRaw<Array<{ h1: number; h2: number }>>`
    SELECT hashtext(k."memoryId") AS h1, hashtext(k.loc) AS h2
    FROM jsonb_to_recordset(${JSON.stringify(unique)}::jsonb) AS k("memoryId" text, loc text)`;
  const actual = new Map(resolved.map((k) => [`${k.h1},${k.h2}`, k]));
  const ordered = [...actual.values()].sort((a, b) => a.h1 - b.h1 || a.h2 - b.h2);
  // One AWAITED statement per distinct pair. An ORDER BY beside the lock
  // function does not constrain its evaluation order, nor does Promise.all.
  for (const k of ordered) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${k.h1}::int, ${k.h2}::int)`;
  }
}

/**
 * The strict ancestor locs of `loc`, shortest first (root → parent). A loc is a
 * ':'-delimited path, so `a:b:c` has ancestors `['a', 'a:b']`. A root-level loc
 * (no ':') has none. The node's own loc is never included.
 *
 * This is enumeration order only. Advisory acquisition uses the resolved-key
 * order in acquireLockSet, preserving ancestor coverage without hash inversions.
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
 * ancestor to coordinate against). Locks use the shared resolved-key order.
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
  /**
   * The verb this caller is performing, for the refusal message and — since
   * #1198 — for the REMEDY, which must not name an authoring door that cannot
   * do what was asked. Defaults to each helper's own verb.
   *
   * `writeNodeCore` passes 'create' / 'update' so its FAST check and this
   * AUTHORITATIVE one agree; before this they could differ, and the under-lock
   * refusal (the one a race actually produces) carried the vaguer 'write'
   * (@copilot, PR #1198). Verb-vs-capability drift is tracked in #1199.
   */
  op?: string;
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
  await acquireLockSet(tx, ancestorLocs(loc).map((ancestor) => ({ memoryId, loc: ancestor })));
  await guard(tx, memoryId, [loc], opts?.op ?? 'create under', opts);
}

/**
 * Batch form of {@link lockAncestorsForCreate} for a BULK insert of many nodes
 * (e.g. a git-graph sync; `replaceSubtree` was one until #454 retired it). Dedupes the ancestor set across all
 * `locs` and acquires each distinct actual key once in a sorted resolved-key
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
  // acquireLockSet owns the resolved-key acquisition order (#1214).
  await acquireLockSet(tx, [...ancestors].map((ancestor) => ({ memoryId, loc: ancestor })));
  await guard(tx, memoryId, locs, opts?.op ?? 'create under', opts);
}

/**
 * Acquire exactly the locks a create UNDER `parentLoc` would take — `parentLoc`
 * itself plus its strict ancestors — before the child's own loc is known.
 *
 * Identical key set to `lockAncestorsForCreate(tx, memoryId, `${parentLoc}:x`)`
 * for any `x`, and taken in the same resolved-key order, so it neither deadlocks
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
  await acquireLockSet(
    tx,
    [...ancestorLocs(parentLoc), parentLoc].map((loc) => ({ memoryId, loc })),
  );
  await guard(tx, memoryId, [parentLoc], opts?.op ?? 'create under', opts);
}

/**
 * Acquire the transaction-scoped advisory lock for WRITING the node at `loc`
 * — the same key `lockNodeForDelete` and an ancestor-create use, so all three
 * serialize against each other on that loc.
 *
 * A writer needing this key and ancestor keys declares the COMPLETE set via
 * acquireLockSet first (#1187/#1214), then re-acquires here for the gate.
 * Run inside the same READ COMMITTED transaction as the write itself.
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
  await acquireLockSet(tx, [{ memoryId, loc }]);
  await guard(tx, memoryId, [loc], opts?.op ?? 'write', opts);
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
  await acquireLockSet(tx, [{ memoryId, loc }]);
  await guard(tx, memoryId, [loc], 'delete', opts);
}
