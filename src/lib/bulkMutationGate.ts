/**
 * #1191 — the write gate for BULK and WHOLE-MEMORY operations.
 *
 * Every per-node write surface consults two gates: the protected-loc gate
 * (spec 049 §2 S4 — a Channel owns its address) and the governed-role gate
 * (#1201/#1203 — a spec, review or task node is written through its own door).
 * Two paths consulted NEITHER, verified by counting gate calls in each on
 * `main`:
 *
 *     mergeMemoryGraph              0
 *     extractParentNodeGraph(move)  0
 *
 * So an authorized merge or extract could relocate, rewrite or delete the nodes
 * under a Channel's address, or move a review node out from under the review
 * door, with no refusal. The Channel half is the sharper one: chat authorship is
 * derived by the owning operation precisely because it was otherwise forgeable
 * and not tamper-evident, which makes that gate a security boundary rather than
 * a guardrail.
 *
 * **Why these two need their own helper rather than the per-node gates.** Both
 * operate on a whole subtree or a whole memory, in batches. Calling
 * `assertLocWritable` per node would be one round trip per row on an operation
 * whose entire design is bounded-memory paging, and `lockNodeForDelete` per node
 * would take thousands of advisory keys — the `acquireLockSet` protocol (#1187)
 * exists precisely so a caller declares a BOUNDED set. These are preflights
 * instead: they answer "does this operation touch anything the generic surface
 * may not?" once, before the work starts, and refuse the whole operation.
 *
 * **Refusing the whole operation is the right granularity here, not a
 * limitation.** A memory merge relocates or folds EVERY node; there is no
 * partial merge that leaves a Channel's address behind, and a Channel whose root
 * moved to another memory would leave `Channel.memoryId`/`loc` reserving an
 * address its root no longer occupies — the same reason `nodeSubtreeMove`
 * refuses a cross-memory move of a chat root, for the same reason.
 */

import { COMMENT_NODE_TYPE, commentGovernedError } from './comments/index.js';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { lockMemoriesForChannelChange } from './channels.js';
import {
  LocProtectedError,
  protectedLocsIn,
  protectedCoversForOp,
  releasesDeadChannelDescendants,
  type ChannelReader,
} from './protectedLoc.js';
import {
  governedKindsOf,
  governedRoleWhereClauses,
  RoleGovernedError,
} from './governedRole.js';

/**
 * The governed signals as they stand UNDER THE LOCK, keyed by loc (#1210).
 *
 * **Single-memory only.** `loc` is unique within a memory, never globally, so
 * this keying is only sound because the `carry` path refuses more than one
 * memoryId — see the guard in `assertBatchMutable`.
 *
 * Returned only on the `carry` path, and the reason it is returned rather than
 * merely checked is @codex's P1 on PR #1230: an owning operation must copy the
 * values that are true NOW, not the ones its transaction read before the gate
 * ran. Absent from the map = no live row at that loc.
 *
 * It does NOT close the window entirely. The kind doors lock per loc, not on
 * the memory key this gate holds, so a promotion committing between this read
 * and the caller's write is still possible — the same residual window the
 * refuse path already documents, and #1213's bounded serialization point is
 * what closes it for both.
 */
export type GovernedSnapshot = ReadonlyMap<string, { role: string | null; isRunnable: boolean | null }>;

/** The columns this gate reads off a node. */
export interface GatedRow {
  loc: string;
  role?: string | null;
  isRunnable?: boolean | null;
}

/**
 * Refuse if any of `rows` is a GOVERNED node — one the generic surface may not
 * produce, edit or remove without its kind's door (`cor` #1201).
 *
 * In memory rather than by query, because both callers have already loaded the
 * rows they are about to mutate. The refusal names the first offender's kind and
 * loc: a caller extracting a large subtree has no other way to tell which node
 * refused it (the #1099 rule).
 */
export function assertNoGovernedRows(rows: readonly GatedRow[], op: 'create' | 'update'): void {
  for (const row of rows) {
    const kinds = governedKindsOf({ role: row.role ?? null, isRunnable: row.isRunnable ?? null });
    if (kinds.length > 0) {
      // 'edits' — this operation is neither minting the marker nor clearing it;
      // it is mutating a node that already carries one, which is exactly the
      // case the generic surface must not reach.
      const err = new RoleGovernedError(kinds[0], op, 'edits', {
        // A bulk merge/extract is not completed by editing one node, so no
        // node-write route is offered (@codex, PR #1305).
        context: 'bulk',
        ...(kinds.length > 1 ? { kinds } : {}),
      });
      // NAME THE NODE. `RoleGovernedError` describes the KIND, which is all a
      // per-node writer needs — it already knows which node it was writing.
      // A bulk caller does not: a merge or extract refused over one row among
      // thousands is unactionable without its loc (the #1099 rule). @copilot
      // caught this as a contract the doc comment promised and the code did not
      // keep.
      throw new GraphQLError(`${err.message} (at "${row.loc}")`, {
        extensions: { ...err.extensions, loc: row.loc },
      });
    }
  }
}

/**
 * Refuse if any PROTECTED address in `memoryId` overlaps the operation's reach.
 *
 * `locs: 'all'` is the whole-memory case (a merge moves everything, so every
 * protected address in either endpoint is touched). A loc LIST is the subtree
 * case, and it is an explicit list rather than a prefix filter on purpose: a
 * Prisma `startsWith` compiles to an unescaped `LIKE`, and `_` is both a
 * wildcard and a legal loc character
 * (`findings:prisma-string-filters-are-unescaped-like`). Both callers already
 * hold the exact set.
 */
export async function assertNoProtectedReach(
  db: ChannelReader,
  memoryId: string,
  locs: readonly string[] | 'all',
  op: string,
): Promise<void> {
  const entries = await protectedLocsIn(db, memoryId);
  if (entries.length === 0) return;
  if (locs === 'all') {
    // This sentinel is used by merge's final SOURCE-memory soft delete. A dead
    // Channel's root is already hidden and stays physically present; the step
    // cleans the live remainder, so apply the same strict-descendant release as
    // every other cleanup gate. Live Channels and non-cleanup operations still
    // refuse. (A hard root delete never comes through this whole-memory path.)
    const hit = entries.find((entry) => !releasesDeadChannelDescendants(entry, op));
    if (hit) throw new LocProtectedError(hit.loc, hit, op);
    return;
  }
  for (const entry of entries) {
    // #1226 via the SHARED predicate: a dead Channel releases its orphaned
    // descendants and still reserves its own address and the path to it. This
    // was the third gate to need the rule and the one I missed twice
    // (@copilot, PR #1257) — routed through `protectedCoversForOp` rather than
    // given a fourth private copy of the liveness test.
    const hit = locs.find((loc) => protectedCoversForOp(entry, loc, op));
    // Name the offending LOC, not just the Channel: a caller extracting a large
    // subtree has no other way to tell which of its nodes refused it (#1099).
    if (hit !== undefined) throw new LocProtectedError(hit, entry, op);
  }
}

/**
 * The whole-memory preflight, for an operation that touches every node in
 * `memoryId` — both gates in one call.
 *
 * `take: 1` on the governed probe: this answers "is there ANY", so a count over
 * a large memory would be paid for nothing.
 */
export async function assertMemoryBulkMutable(
  db: ChannelReader & Pick<Prisma.TransactionClient, 'node'>,
  memoryId: string,
  op: string,
  /** #1664 — `carry`: the caller moves threads with their targets itself (mergeMemories). */
  opts: { comments?: 'refuse' | 'carry' } = {},
): Promise<void> {
  await assertNoProtectedReach(db, memoryId, 'all', op);
  if ((opts.comments ?? 'refuse') === 'refuse') await assertNoCommentRows(db, { memoryId }, op);
  const governed = await db.node.findFirst({
    where: {
      memoryId,
      deletedAt: null,
      OR: [...governedRoleWhereClauses(), { isRunnable: true }],
    },
    select: { loc: true, role: true, isRunnable: true },
  });
  if (governed) assertNoGovernedRows([governed], 'update');
}

/**
 * The AUTHORITATIVE per-batch gate — the one that actually holds.
 *
 * {@link assertMemoryBulkMutable} is a point-in-time read, and @codex and
 * @copilot both landed on the same P1: a merge is paged across SEPARATE
 * transactions, so a Channel created (or a node promoted to a governed kind)
 * after the preflight and before a later page is invisible to it. "A check
 * before the lock was a TOCTOU window the size of the wait" (PR #1165) — here
 * the window was the size of the whole merge.
 *
 * So the preflight stays only as FAIL-FAST (refusing a doomed merge before it
 * moves anything is worth one query), and THIS runs inside each writing
 * transaction, over the rows that transaction is about to write:
 *
 *   - it takes `lockMemoriesForChannelChange` on every memory involved, which is
 *     the key `ensureChannelWithRoot` holds while it creates a Channel — so a
 *     concurrent Channel create either commits before this check sees it, or
 *     waits behind this batch;
 *   - it re-reads the protected set under that lock, on a fresh READ COMMITTED
 *     snapshot taken after the grant;
 *   - it checks the batch's OWN rows, read inside the same transaction, so a
 *     row promoted to a governed kind between classification and write is seen.
 *
 * The complete memory set is resolved to PostgreSQL signed hash keys and
 * acquired in that order (#1213), so collisions cannot invert acquisitions
 * between two merges with different endpoint sets.
 *
 * What this does NOT claim: a merge that has already relocated pages one to
 * eight does not un-relocate them when page nine refuses. Bulk paging makes
 * partial completion a property of the operation, not of this gate — the
 * merge is resumable by design.
 */
export async function assertBatchMutable(
  tx: ChannelReader & Pick<Prisma.TransactionClient, '$executeRaw' | 'node'>,
  memoryIds: readonly string[],
  rows: readonly GatedRow[],
  op: string,
  opts: {
    /**
     * What this operation does when the batch contains a GOVERNED row (#1210).
     *
     * - `'refuse'` (default) — the generic surface may not touch a node that
     *   carries a kind's marker. This is the conservative answer and stays the
     *   default deliberately: a copying operation added later gets it without
     *   asking, and being refused is the recoverable direction. Merge holds
     *   this.
     * - `'carry'` — an OWNING operation (#1218): it duplicates an
     *   already-approved node rather than authoring a new one, so it carries
     *   the signals across instead of being refused for doing so. Extract
     *   holds this, on @Holger's ruling of 2026-09-19.
     *
     * Note what this option does NOT do: it never makes a row governed. The
     * carry is `governedSignals.ts`'s job and it PRESERVES — this flag only
     * decides whether the presence of a marker stops the operation.
     *
     * The PROTECTED-loc half above is unaffected either way. A Channel's
     * address is a reservation, not a kind marker, and no ruling touched it.
     */
    governed?: 'refuse' | 'carry';
  } = {},
): Promise<GovernedSnapshot | undefined> {
  await lockMemoriesForChannelChange(tx as Prisma.TransactionClient, memoryIds);
  const locs = rows.map((r) => r.loc);
  for (const memoryId of new Set(memoryIds)) {
    await assertNoProtectedReach(tx, memoryId, locs, op);
  }
  await assertNoCommentRows(tx, { memoryId: { in: [...new Set(memoryIds)] }, loc: { in: locs } }, op);

  // The GOVERNED half re-reads under the MEMORY lock, and deliberately does
  // NOT take a key per row (@copilot rounds 2 and 3, which pull in opposite
  // directions and are both right).
  //
  // Round 2 was correct that the kind doors coordinate on
  // `lockLocForWrite(memoryId, loc)`, so the memory key alone does not
  // serialize against them. Round 3 was correct that the per-row answer is
  // unaffordable here: `extractParentNodeGraph` passes its ENTIRE live subtree
  // with no cap and no paging, so one advisory key per node — held until that
  // single transaction ends — is an unbounded claim on a finite shared-memory
  // lock table. A gate that can exhaust the lock table on a large but perfectly
  // valid extract is not a safer gate.
  //
  // So this re-reads rather than trusting the caller's snapshot, which closes
  // the window that matters in practice — a promotion committed before this
  // transaction's read — and leaves ONE narrow window open: a promotion that
  // commits between this read and the batch's write. That is filed rather than
  // papered over, and closing it properly means giving the governed writers a
  // BOUNDED shared serialization point instead of a key per row.
  //
  // An owning operation does not REFUSE — but it must not skip the read
  // either (@codex P1 on PR #1230, and the finding is right). The caller's
  // `rows` were read earlier in its transaction; the kind doors coordinate on
  // `lockLocForWrite(memoryId, loc)`, which does not conflict with the memory
  // key held above, and READ COMMITTED does not refresh that earlier snapshot.
  // So a door that commits in between leaves the caller holding STALE signals
  // — and a carry built from them copies `role: null` off a node that is now
  // governed. With `move: true` the now-governed source is then soft-deleted,
  // leaving only an ungoverned copy the generic surface may edit: governance
  // laundering, introduced by the carry that exists to prevent it.
  //
  // So the read happens either way. What differs is the verdict: REFUSE turns
  // a governed row into an error, CARRY hands the fresh values back for the
  // caller to copy.
  const governed = opts.governed ?? 'refuse';

  if (governed === 'carry') {
    // Keyed by loc, so it is only unambiguous within ONE memory — `loc` is
    // unique per memory (`@@unique([loc, memoryId])`), not globally, and a
    // loc-only lookup across memories silently picks an arbitrary tenant's row
    // (`findings:unscoped-loc-lookup-crosses-memories`). @copilot on PR #1230.
    //
    // Refused loudly rather than papered over with a composite key: the one
    // carry caller extracts FROM a single memory, and a future multi-memory
    // owning operation should design its keying deliberately instead of
    // inheriting a collision from here. Unreachable today by construction —
    // which is exactly when it is cheap to close.
    if (new Set(memoryIds).size > 1) {
      throw new Error(
        `assertBatchMutable: { governed: 'carry' } takes exactly one memory (got ${new Set(memoryIds).size}) — a loc-keyed snapshot is ambiguous across memories.`,
      );
    }
    // Unfiltered, unlike the refuse path below: the carry needs the CURRENT
    // value of both signals for every row, not just the governed ones. A row
    // DEMOTED since the caller's snapshot is the mirror hazard — copying its
    // stale marker would mint governance the source no longer carries, which
    // is the half of the ruling that says preserve, never mint.
    const fresh = await tx.node.findMany({
      where: { memoryId: { in: [...new Set(memoryIds)] }, loc: { in: locs }, deletedAt: null },
      select: { loc: true, role: true, isRunnable: true },
    });
    return new Map(fresh.map((r) => [r.loc, { role: r.role, isRunnable: r.isRunnable }]));
  }

  const fresh = await tx.node.findMany({
    where: {
      memoryId: { in: [...new Set(memoryIds)] },
      loc: { in: locs },
      deletedAt: null,
      OR: [...governedRoleWhereClauses(), { isRunnable: true }],
    },
    select: { loc: true, role: true, isRunnable: true },
  });
  assertNoGovernedRows(fresh, 'update');
  return undefined;
}

/**
 * #1606 (cor:dmo:110:04) — a bulk merge or extract never copies, moves or
 * rewrites a comment: comments are written only by the comment path, and a
 * generic copy would produce a comment without its anchor. Only LIVE comments
 * refuse, so the admin thread delete is the way through (cor:dmo:110:02); a
 * deleted thread left behind is checked by the database invariants. Naming the
 * first offender's loc follows the #1099 rule above.
 */
async function assertNoCommentRows(
  db: Pick<Prisma.TransactionClient, 'node'>,
  where: Prisma.NodeWhereInput,
  op: string,
): Promise<void> {
  const comment = await db.node.findFirst({ where: { ...where, nodeType: COMMENT_NODE_TYPE, deletedAt: null }, select: { loc: true } });
  if (comment) {
    const err = commentGovernedError('merge', 'edits');
    throw new GraphQLError(`${err.message} A ${op} cannot carry comment threads yet; an admin of the memory deletes them first (at "${comment.loc}").`, {
      extensions: { ...err.extensions, loc: comment.loc },
    });
  }
}
