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

import { GraphQLError } from 'graphql';
import type { Prisma } from '../generated/prisma/index.js';
import { lockMemoryForChannelChange } from './channels.js';
import { LocProtectedError, protectedLocsIn, protectedLocCovers, type ChannelReader } from './protectedLoc.js';
import { GOVERNED_ROLES, governedKindsOf, RoleGovernedError } from './governedRole.js';

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
      const err = new RoleGovernedError(kinds[0], op, 'edits');
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
    // The whole memory is in reach, so the protected address itself is the loc
    // being refused — there is no narrower one to name.
    throw new LocProtectedError(entries[0].loc, entries[0], op);
  }
  for (const entry of entries) {
    const hit = locs.find((loc) => protectedLocCovers(entry, loc));
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
): Promise<void> {
  await assertNoProtectedReach(db, memoryId, 'all', op);
  const governed = await db.node.findFirst({
    where: {
      memoryId,
      deletedAt: null,
      OR: [{ role: { in: GOVERNED_ROLES as string[] } }, { isRunnable: true }],
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
 *   - it takes `lockMemoryForChannelChange` on every memory involved, which is
 *     the key `ensureChannelWithRoot` holds while it creates a Channel — so a
 *     concurrent Channel create either commits before this check sees it, or
 *     waits behind this batch;
 *   - it re-reads the protected set under that lock, on a fresh READ COMMITTED
 *     snapshot taken after the grant;
 *   - it checks the batch's OWN rows, read inside the same transaction, so a
 *     row promoted to a governed kind between classification and write is seen.
 *
 * The memory locks are taken in sorted order for the same reason
 * `compareLockKeys` sorts on memory first (#1187): two merges with swapped
 * endpoints must not invert against each other.
 *
 * What this does NOT claim: a merge that has already relocated pages one to
 * eight does not un-relocate them when page nine refuses. Bulk paging makes
 * partial completion a property of the operation, not of this gate — the
 * merge is resumable by design.
 */
export async function assertBatchMutable(
  tx: ChannelReader & Pick<Prisma.TransactionClient, '$executeRaw'>,
  memoryIds: readonly string[],
  rows: readonly GatedRow[],
  op: string,
): Promise<void> {
  for (const memoryId of [...new Set(memoryIds)].sort()) {
    await lockMemoryForChannelChange(tx as Prisma.TransactionClient, memoryId);
  }
  const locs = rows.map((r) => r.loc);
  for (const memoryId of new Set(memoryIds)) {
    await assertNoProtectedReach(tx, memoryId, locs, op);
  }
  assertNoGovernedRows(rows, 'update');
}
