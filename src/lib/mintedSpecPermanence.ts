/**
 * Legacy memory-stamped spec-removal guards, disabled by #1591.
 *
 * Current minting is per node. A first mint ends that node's draft rights:
 * renumbering and governed bulk replacement are refused, and moves retain an
 * alias (hrn:node:hadronmemory.com:specs:cor:dmo:120:08). Minting currently adds
 * NO removal protection (hrn:node:hadronmemory.com:specs:cor:dmo:120:09).
 *
 * The retained implementation below is the OLD policy, exercised by its own
 * tests only while the switch is enabled. Since the #5063 re-key it is keyed
 * like every other reader: a memory counts as minted when any of its nodes
 * carries `minted_at` (tombstones included; the mint time is MAX(minted_at)
 * over all rows), not by the legacy `Memory.corpusMintedAt` stamp. It must
 * not be re-enabled unchanged — the memory-keyed policy cor:dmo:120:09
 * (minting adds no removal protection) is what forbids returning it as-is,
 * and future protection needs a new decision and per-node checks. The mint
 * record is not memory-local the way the stamp was, either: `minted_at`
 * travels with a relocated node (mergeMemories' cross-memory move), so a
 * merge can make the source stop counting as minted and the destination
 * start — a divergence from the old never-moved stamp, live today only in
 * the harmless newlyMarked conflict branch (permanence off, #1591).
 *
 * The mint time is derived, not stored, so it is not monotonic (F1, #5088):
 * hard-deleting minted node rows moves MAX(minted_at) backward, or makes it
 * vanish when none is left, which returns the memory to draft. That is the
 * derived state working as specified (hrn:node:hadronmemory.com:specs:cor:dmo:120:00:
 * the minted state "is not one-way: deleting every minted node makes it draft
 * again"), not a defect. Soft deletes never clear it, since tombstones keep
 * their `minted_at`. MAX is the mint time; MIN would be wrong.
 *
 * Isolation (F2): the guards assume READ COMMITTED. They take `FOR SHARE` on
 * the memory row and then run a plain aggregate over `nodes`; under READ
 * COMMITTED that aggregate takes a fresh snapshot after the lock is granted,
 * so it sees a mint that committed while the lock waited. A stricter level
 * would pin the snapshot at the first statement and could miss it.
 *
 * Fencing invariant (F3): the unlocked EXISTS probe in
 * `lockMintedSpecUnmarks` is stable for the rows being written only because
 * the mint fences EVERY spec row in scope (`fenceCorpusForMint`, `FOR UPDATE`
 * on each), which waits on or times out behind this writer's own row locks.
 * A mint path that fenced fewer rows would break that argument.
 *
 * Index (F5): the `EXISTS`/`MAX` reads over `(memory_id, minted_at)` have no
 * dedicated index. The EXISTS probe runs today, with the switch off, on every
 * write that newly marks a spec (pinned by C2/C2b); only the MAX reads are
 * dormant. Whether a partial or composite index is warranted is to be decided
 * with any future protection rule (cor:dmo:120:09), weighing that per-write
 * probe cost; it is not a step before a switch flip.
 *
 * The legacy implementation selects anything carrying the spec marker (`hasSpecMarker` — a `spec`
 * tag or a `spec`/`spec.*` role; both are plaintext at rest even in encrypted
 * memories). Because the removal guards pick specs out BY that marker,
 * dropping it is itself a removal path, and the marker is guarded too
 * (`assertNoMintedSpecUnmark`, Vera team chat #4403): every door that can
 * rewrite `tags` or `role` refuses to leave a minted spec unmarked, and git
 * sync keeps the stored marker and reports the file.
 *
 * Retained lock protocol when this legacy policy is enabled: the mint fences with Memory
 * `FOR UPDATE`, then every node row `FOR UPDATE` with a 500ms lock timeout
 * that turns into a retryable `SPEC_CORPUS_BUSY` (`fenceCorpusForMint`). This
 * guard takes the opposite, cooperating order that node writers use: the
 * scope's node rows `FOR NO KEY UPDATE` (sorted by id), THEN the memory row
 * `FOR SHARE`, and reads the mint records under that lock. Either the mint
 * committed first (the guard sees the stamp and refuses), or the guard holds
 * rows the mint needs (the mint times out and retries after this removal —
 * which was then a legitimate draft removal), or the guard holds the memory
 * row (the mint waits and then fences the post-removal corpus). Locking the
 * rows first also stops a concurrent edit from adding a spec marker between
 * the check and the removal.
 *
 * Why `FOR NO KEY UPDATE`, not `FOR UPDATE`: it is exactly what a soft
 * delete's own `UPDATE` takes, so the guard adds no new wait. `FOR UPDATE`
 * would also conflict with the `FOR KEY SHARE` an in-flight edge insert holds
 * on its endpoint through the FK, and a soft delete must not wait for that
 * (specCorpusPlaceholder "waits for the edge insert holding the tombstone").
 * It still conflicts with a marker edit (also `NO KEY UPDATE`) and with the
 * mint's node fence (`FOR UPDATE`). A hard delete escalates at its own
 * `DELETE`, as it always did.
 *
 * Callers pass the COMPLETE set of rows the operation removes from the memory
 * (subtree descendants and, for hard deletes, tombstones), inside the same
 * transaction as the removal, after any address/subtree locks they already
 * take (so no row can join the scope afterwards).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { hasSpecMarker } from './specMint.js';
import { questionContainedError, memoryHoldsQuestions } from './questions/index.js';

/**
 * #1591 — the permanence policy: is minted-spec permanence enforced at all?
 *
 * Holger, 2026-10-01 (#1591): no minted spec is permanent for now, including
 * the corpora this guard protected since #1468. Every guard below answers
 * "nothing protected" while this is false. The guard is retained for a later
 * policy decision; its own tests run with it on. Since the #5063 re-key it
 * keys on the per-node mint records, so re-enabling it still needs a decision
 * on which nodes it covers (cor:dmo:120:09 says none today).
 */
let permanenceEnforced = false;

/** Whether minted-spec permanence is enforced (#1591: not for now). */
export function isMintedSpecPermanenceEnforced(): boolean {
  return permanenceEnforced;
}

/** Test hook: the guard's own tests run with permanence enforced. */
export function setMintedSpecPermanenceEnforcedForTests(enforced: boolean): void {
  permanenceEnforced = enforced;
}

/** The one error every minted-spec removal refusal raises. */
export const SPEC_MINTED_PERMANENT = 'SPEC_MINTED_PERMANENT';

/** How many offending locs a refusal names in its message and extensions. */
const NAMED_LOC_CAP = 10;

/** The way forward a refusal names by default: replace a minted spec, never remove it. */
const SUPERSEDE_REMEDY = 'Supersede a spec to replace it.';

/** Build the typed refusal: names the specs (capped) and the way forward (supersede, by default). */
export function mintedSpecRemovalError(
  memoryId: string,
  locs: string[],
  op: string,
  remedy: string = SUPERSEDE_REMEDY,
): GraphQLError {
  const named = locs.slice(0, NAMED_LOC_CAP);
  const more = locs.length > named.length ? ` (and ${locs.length - named.length} more)` : '';
  return new GraphQLError(
    `Refused to ${op}: ${named.map((l) => `"${l}"`).join(', ')}${more} ` +
      `${locs.length === 1 ? 'is a spec' : 'are specs'} in a minted corpus, and minted specs are permanent. ` +
      remedy,
    { extensions: { code: SPEC_MINTED_PERMANENT, memoryId, locs: named, count: locs.length, op } },
  );
}

/**
 * Lock the given node rows, then return the ones the mint protects: the spec
 * rows a removal would take from a mint-stamped corpus (empty when the corpus
 * is not stamped). Run inside the removal's transaction, before the write; the
 * row locks are held to commit, so the answer stays true through the removal.
 *
 * `nodeIds` must all belong to `memoryId` (the memory the operation removes
 * them FROM). Rows that have since left the memory are ignored here; the
 * caller's own concurrency checks own that case.
 *
 * Most callers want `assertNoMintedSpecRemoval`, which refuses. Use this
 * directly only where the removal SKIPS protected rows instead (git sync's
 * repo-wins prune).
 */
export async function lockMintedSpecsIn(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
): Promise<Array<{ id: string; loc: string }>> {
  if (!isMintedSpecPermanenceEnforced() || nodeIds.length === 0) return [];
  const ids = [...new Set(nodeIds)].sort();
  // Node rows first (id order, the global multi-row order), then the markers
  // re-read under those locks.
  const rows = await tx.$queryRaw<
    Array<{ id: string; loc: string; tags: string[]; role: string | null; deleted_at: Date | null }>
  >`
    SELECT id, loc, tags, role, deleted_at FROM nodes
    WHERE id = ANY(${ids}::text[]) AND memory_id = ${memoryId}
    ORDER BY id FOR NO KEY UPDATE`;
  const specs = rows.filter((r) => hasSpecMarker({ tags: r.tags ?? [], role: r.role }));
  // No spec in scope: nothing this guard protects, and no memory lock taken.
  if (specs.length === 0) return [];
  const [memory] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
  if (!memory) return [];
  // #5063 re-key: the mint record is the nodes' own `minted_at` — any row of
  // the memory, tombstones included — read under the memory lock, where a
  // concurrent mint (which holds the memory FOR UPDATE before fencing nodes)
  // cannot interleave.
  const [stamp] = await tx.$queryRaw<Array<{ minted_at: Date | null }>>`
    SELECT MAX(minted_at) AS minted_at FROM nodes WHERE memory_id = ${memoryId}`;
  if (!stamp || stamp.minted_at === null) return [];
  const mintedAt = stamp.minted_at;
  return specs
    .filter((s) => isProtectedAfterMint(s.deleted_at, mintedAt))
    .map((s) => ({ id: s.id, loc: s.loc }))
    .sort((a, b) => a.loc.localeCompare(b.loc));
}

/**
 * Lock the given node rows, then refuse if removing them would remove a spec
 * from a mint-stamped corpus. Run inside the removal's transaction, before the
 * write. See `lockMintedSpecsIn` for the scope contract.
 *
 * @throws GraphQLError `SPEC_MINTED_PERMANENT` when the corpus is stamped and
 *   any locked row carries the spec marker.
 */
export async function assertNoMintedSpecRemoval(
  tx: Prisma.TransactionClient,
  memoryId: string,
  nodeIds: readonly string[],
  op: string,
): Promise<void> {
  const protectedSpecs = await lockMintedSpecsIn(tx, memoryId, nodeIds);
  if (protectedSpecs.length > 0) throw mintedSpecRemovalError(memoryId, protectedSpecs.map((s) => s.loc), op);
}

/** A node's marker fields after a proposed update; an omitted field is left unchanged. */
export interface NodeMarkerChange {
  id: string;
  tags?: readonly string[];
  role?: string | null;
}

/**
 * Lock the given node rows, then return the ones whose proposed update would
 * take the spec marker off a protected spec of a mint-stamped corpus (#1468,
 * Vera team chat #4403). Dropping the marker is a removal path in disguise:
 * the removal guards pick specs out BY their marker, so an unmarked spec can
 * then be deleted like any note. Keeping or swapping the marker (a `spec` tag
 * swapped for a `spec.rule` role) is not a removal and stays allowed.
 *
 * Same locking order and strength as `lockMintedSpecsIn` (node rows
 * `FOR NO KEY UPDATE` in id order, then the memory row `FOR SHARE`), so it
 * cooperates with a concurrent mint the same way, and the answer holds until
 * the caller's write commits. Run inside the update's transaction, before it.
 *
 * Most callers want `assertNoMintedSpecUnmark`, which refuses. Use this
 * directly only where the write KEEPS the marker instead (git sync).
 */
export async function lockMintedSpecUnmarks(
  tx: Prisma.TransactionClient,
  memoryId: string,
  changes: readonly NodeMarkerChange[],
): Promise<Array<{ id: string; loc: string }>> {
  // Only a change that touches a marker field can unmark anything.
  const touching = changes.filter((c) => c.tags !== undefined || c.role !== undefined);
  if (touching.length === 0) return [];
  const next = new Map(touching.map((c) => [c.id, c]));
  const ids = [...next.keys()].sort();
  const rows = await tx.$queryRaw<
    Array<{ id: string; loc: string; tags: string[]; role: string | null; deleted_at: Date | null }>
  >`
    SELECT id, loc, tags, role, deleted_at FROM nodes
    WHERE id = ANY(${ids}::text[]) AND memory_id = ${memoryId}
    ORDER BY id FOR NO KEY UPDATE`;
  const markedBefore = (r: (typeof rows)[number]) => hasSpecMarker({ tags: r.tags ?? [], role: r.role });
  const markedAfter = (r: (typeof rows)[number]) => {
    const change = next.get(r.id)!;
    return hasSpecMarker({
      tags: change.tags ?? r.tags ?? [],
      role: change.role !== undefined ? change.role : r.role,
    });
  };
  // #1591: with permanence off, unmarking protects nothing. The deleted-memory
  // conflict below for a NEWLY marked spec is not permanence and still applies.
  const unmarked = isMintedSpecPermanenceEnforced()
    ? rows.filter((r) => markedBefore(r) && !markedAfter(r))
    : [];
  // A write that marks a node's FIRST spec must not race a whole-corpus
  // delete that has just found none (Codex on #1475): taking the memory row
  // FOR SHARE below conflicts with deleteMemory's FOR UPDATE, so one of the
  // two commits first and the other sees it.
  const newlyMarked = rows.some((r) => !markedBefore(r) && markedAfter(r));
  if (unmarked.length === 0 && !newlyMarked) return [];
  // Unlocked mint probe first, so ordinary spec edits in never-minted
  // memories take no memory lock: does any node of the memory carry a mint
  // record (tombstones included)? It is stable for these rows: the mint must
  // lock them FOR UPDATE, which waits on (or times out behind) ours.
  const [probe] = await tx.$queryRaw<Array<{ minted: boolean }>>`
    SELECT EXISTS(SELECT 1 FROM nodes WHERE memory_id = ${memoryId} AND minted_at IS NOT NULL) AS minted`;
  if (!probe || !probe.minted) return [];
  const [memory] = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>`
    SELECT deleted_at FROM memories WHERE id = ${memoryId} FOR SHARE`;
  // The opposite order (Codex on #1475): a whole-corpus delete took the row
  // first, this lock waited for it, and the corpus is now deleted. Marking a
  // spec into it would report success for a spec that is already
  // unreachable, so the write is refused as a conflict; a retry then meets
  // the ordinary deleted-memory refusal of whatever door it came through.
  if (memory?.deleted_at && newlyMarked) {
    throw new GraphQLError(
      'The memory was deleted while this write waited; nothing was written — re-read and retry.',
      { extensions: { code: 'NODE_WRITE_CONFLICT', memoryId } },
    );
  }
  if (!memory || unmarked.length === 0) return [];
  // #5063 re-key: the mint time is MAX(nodes.minted_at) over all rows, read
  // under the memory lock taken above.
  const [stamp] = await tx.$queryRaw<Array<{ minted_at: Date | null }>>`
    SELECT MAX(minted_at) AS minted_at FROM nodes WHERE memory_id = ${memoryId}`;
  if (!stamp || stamp.minted_at === null) return [];
  const mintedAt = stamp.minted_at;
  return unmarked
    .filter((r) => isProtectedAfterMint(r.deleted_at, mintedAt))
    .map((r) => ({ id: r.id, loc: r.loc }))
    .sort((a, b) => a.loc.localeCompare(b.loc));
}

/** The way forward an unmark refusal names: the marker is what keeps a minted spec a spec. */
const UNMARK_REMEDY =
  'Removing the spec marker (the "spec" tag, or a spec/spec.* role) would let it be deleted; ' +
  'keep a marker, or supersede the spec to replace it.';

/**
 * Refuse an update that would take the spec marker off a protected spec of a
 * mint-stamped corpus. See `lockMintedSpecUnmarks` for the rule and locking.
 *
 * @throws GraphQLError `SPEC_MINTED_PERMANENT` naming the specs it would unmark.
 */
export async function assertNoMintedSpecUnmark(
  tx: Prisma.TransactionClient,
  memoryId: string,
  changes: readonly NodeMarkerChange[],
  op: string,
): Promise<void> {
  const unmarked = await lockMintedSpecUnmarks(tx, memoryId, changes);
  if (unmarked.length > 0) {
    throw mintedSpecRemovalError(memoryId, unmarked.map((s) => s.loc), op, UNMARK_REMEDY);
  }
}

/**
 * Which spec rows the mint promised to keep: every live one, and a tombstone
 * only if it was deleted AT OR AFTER the mint. A tombstone deleted before the
 * mint is a legitimate draft-era deletion that never belonged to the minted
 * corpus, so hard-deleting it (or reclaiming its memory) stays allowed. One
 * deleted after the mint can only have come from a path that bypassed this
 * guard, and keeping it recoverable is the point.
 */
function isProtectedAfterMint(deletedAt: Date | null, mintedAt: Date): boolean {
  return deletedAt === null || deletedAt >= mintedAt;
}

type NodeReader = Pick<Prisma.TransactionClient, 'node' | 'memory'>;

/** The Prisma form of `hasSpecMarker`, for whole-memory scans. Keep in step with it. */
const SPEC_MARKER_WHERE: Prisma.NodeWhereInput = {
  OR: [{ tags: { has: 'spec' } }, { role: 'spec' }, { role: { startsWith: 'spec.' } }],
};

/**
 * The spec locs a whole-memory removal would take from a mint-stamped corpus;
 * empty when the memory is not stamped. UNLOCKED: use it for a fail-fast
 * preflight, never as the authoritative check (a paged operation can outlive
 * it). `includeTombstones` for hard (cascading) removals, which erase
 * tombstones too — those deleted after the mint (see isProtectedAfterMint).
 */
export async function mintedSpecLocsIn(
  db: NodeReader,
  memoryId: string,
  opts: { includeTombstones: boolean },
): Promise<string[]> {
  if (!isMintedSpecPermanenceEnforced()) return [];
  // #5063 re-key: the memory counts as minted when any of its nodes carries
  // `minted_at` (tombstones included — a soft delete never clears the mint
  // record), with MAX as the mint time; the named locs stay as they were
  // (live, plus protected tombstones for hard removals).
  const stamp = await db.node.aggregate({ where: { memoryId }, _max: { mintedAt: true } });
  const mintedAt = stamp._max.mintedAt;
  if (!mintedAt) return [];
  const specs = await db.node.findMany({
    where: {
      memoryId,
      // See isProtectedAfterMint: a tombstone counts only if deleted after the mint.
      ...(opts.includeTombstones
        ? { OR: [{ deletedAt: null }, { deletedAt: { gte: mintedAt } }] }
        : { deletedAt: null }),
      AND: [SPEC_MARKER_WHERE],
    },
    select: { loc: true },
    orderBy: { loc: 'asc' },
  });
  return specs.map((s) => s.loc);
}

/** Fail-fast form of the whole-memory check: throws the typed refusal if the preflight finds specs. */
export async function preflightNoMintedCorpusRemoval(
  db: NodeReader,
  memoryId: string,
  op: string,
  opts: { includeTombstones: boolean },
): Promise<void> {
  const locs = await mintedSpecLocsIn(db, memoryId, opts);
  if (locs.length > 0) throw mintedSpecRemovalError(memoryId, locs, op);
}

/**
 * Whole-memory removal guard (#1468, Holger team chat #4308): deleting a
 * mint-stamped corpus, directly or by a parent's cascade, removes every spec
 * in it and is refused while it holds any. Run inside the removal's
 * transaction.
 *
 * Locking: the CALLER takes the memory row `FOR UPDATE` first (deleteMemory,
 * deleteAgent, the merge disposition, reclaim and cascade all do). That lock
 * conflicts with a concurrent mint (Memory `FOR UPDATE`), with the FK
 * `KEY SHARE` every node insert or move-in takes, and with the `FOR SHARE` a
 * write takes when it marks a spec (`lockMintedSpecUnmarks`), so no spec can
 * appear between this scan and the tombstone (Codex on #1475 closed the race
 * this guard used to accept). The `FOR SHARE` read here re-enters it. Node
 * rows are not locked: a whole memory can be large, and the memory lock is
 * what excludes new specs.
 */
export async function assertNoMintedCorpusRemoval(
  tx: Prisma.TransactionClient,
  memoryId: string,
  op: string,
  opts: { includeTombstones: boolean; remedy?: string },
): Promise<void> {
  // #1641 §3.2 / Q17 — a memory holding a question or a question log is never
  // removed, directly or by a parent's cascade, in v1. Ahead of the spec
  // checks' early returns, which are about specs only. Every caller holds the
  // memory row FOR UPDATE, which excludes a concurrent node insert (FK KEY
  // SHARE), so no log can appear after this scan.
  if (await memoryHoldsQuestions(tx, memoryId)) throw questionContainedError(`Removing this memory (${op})`);
  if (!isMintedSpecPermanenceEnforced()) return;
  // The FOR SHARE re-entry keeps the cooperating order (the caller holds the
  // row FOR UPDATE); the minted-or-not question now lives on the node rows
  // (#5063 re-key) and is answered by mintedSpecLocsIn below.
  const [memory] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memories WHERE id = ${memoryId} FOR SHARE`;
  if (!memory) return;
  const locs = await mintedSpecLocsIn(tx, memoryId, opts);
  if (locs.length > 0) throw mintedSpecRemovalError(memoryId, locs, op, opts.remedy);
}

/**
 * Hard-delete a SOFT-DELETED memory to reclaim its URN for a new one (#1468):
 * the tombstone-reclaim step of createMemory, cloneMemory, extract, App-memory
 * provisioning and owner-namespace merges. The FK cascade erases its nodes, so
 * a mint-stamped corpus still holding a protected spec is refused.
 *
 * Locks the memory row `FOR UPDATE` (the delete's own strength, so the guard's
 * `FOR SHARE` re-enters) and re-checks it is still a tombstone: a row revived
 * since the caller's unlocked read is left alone. Returns whether it deleted.
 */
export async function reclaimTombstonedMemory(
  tx: Prisma.TransactionClient,
  memoryId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ deleted_at: Date | null }>>`
    SELECT deleted_at FROM memories WHERE id = ${memoryId} FOR UPDATE`;
  if (!row || row.deleted_at === null) return false;
  await assertNoMintedCorpusRemoval(tx, memoryId, 'reclaim the address of the deleted corpus holding', {
    includeTombstones: true,
  });
  await tx.memory.delete({ where: { id: memoryId } });
  return true;
}

/**
 * Refuse a PARENT hard delete whose FK cascade would erase a mint-stamped
 * corpus still holding a protected spec (#1468, Holger team chat #4308): an
 * App reclaim (`Memory.appId` cascades), and anything else that deletes the
 * owner of a memory set. Run in the same transaction as the parent delete.
 *
 * Locks each doomed memory row `FOR UPDATE` (the strength the cascade itself
 * takes) in id order, the global multi-row order, before checking it.
 */
export async function assertNoMintedCorpusCascade(
  tx: Prisma.TransactionClient,
  memoryIds: readonly string[],
  op: string,
  remedy?: string,
): Promise<void> {
  for (const id of [...new Set(memoryIds)].sort()) {
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR UPDATE`;
    await assertNoMintedCorpusRemoval(tx, id, op, { includeTombstones: true, remedy });
  }
}
