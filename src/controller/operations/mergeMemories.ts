import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { assertBatchMutable, assertMemoryBulkMutable, assertNoProtectedReach } from '../../lib/bulkMutationGate.js';
import {
  assertNoMintedCorpusRemoval,
  assertNoMintedSpecRemoval,
  preflightNoMintedCorpusRemoval,
} from '../../lib/mintedSpecPermanence.js';
import { lockMemoryForChannelChange } from '../../lib/channels.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import {
  ensureCurrentNodeRevisionInTransaction,
  buildNodeRevisionSnapshot,
  revisionStateHashRefreshMarker,
  createNodeRevision,
  type SnapshotEditor,
} from '../../lib/nodeRevisionSnapshot.js';
import {
  mergeNodeFields,
  type NodeMergeField,
} from '../../lib/nodeMerge.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';
import { GraphQLError } from 'graphql';
import { validateNodeAgainstSchema, NodeSchemaViolation } from '../../lib/validateNodeAgainstSchema.js';
import { normalizeObjectType } from '../../lib/enforceNodeSchema.js';
import type { MemorySchema } from '../../lib/memorySchema.js';
import { acquireLockSet } from '../../lib/nodeSubtreeLock.js';
import { recordUrnRename } from '../../lib/urnAlias.js';
import { safeNodeUrnV2 } from '../../lib/urnEmit.js';
import { assertNoPlaceholdersLeaveDraft, isDraftCorpus } from '../../lib/specCorpus.js';

/**
 * Batched, resumable execution of a memory→memory merge (spec cor:api:080).
 *
 * Folds a SOURCE memory's live graph into a TARGET memory: each live source
 * node is placed by `loc` — a node whose loc already exists in the target is
 * FOLDED into that counterpart (per-field strategy), the rest RELOCATE with
 * their stable id and loc preserved. Edges follow (spec cor:api:080:01).
 *
 * ## Why batched (issue #363)
 *
 * The v1 implementation (#354) ran the whole merge inside one Prisma
 * interactive transaction. That is atomic but does not scale: a source memory
 * with thousands of nodes/edges blows past the ~5s interactive-transaction
 * timeout, materializes every node/edge in memory at once, and holds row
 * locks for the merge's full duration. This version decomposes the work into
 * bounded units so each transaction stays small.
 *
 * The work splits into three phases, each safe to commit on its own:
 *
 *   1. **Classify + relocate** — keyset-page source addresses against the
 *      target by loc. Colliding nodes (the small set) are recorded for Phase 2;
 *      the rest RELOCATE in bounded transactions, snapshotting each pre-move
 *      state. Ids are preserved, so inbound edges keep resolving, and every SQL
 *      id/loc list stays bounded by the page size (no unbounded `notIn`).
 *   2. **Fold** — fold colliding nodes in batches; per node: snapshot the
 *      target counterpart (`NodeRevision`), merge the selected fields,
 *      recompute `abstractOriginHash`, repoint/transfer its incident edges
 *      onto the counterpart (when EDGES is selected), then delete the emptied
 *      source row. One transaction per batch, all reads + writes inside it.
 *   3. **Edge relocate** — drain the surviving source-memory edges (sourced
 *      from relocated nodes) into the target's loc namespace in batches,
 *      dropping any whose loc is already taken in the target.
 *
 * A final step soft-deletes the now-empty source memory when requested.
 *
 * ## Partial-progress / resume semantics
 *
 * Whole-merge atomicity is traded for bounded transactions (the spec lists
 * the batching + ordering of the underlying writes as TUNABLE — cor:api:080).
 * Each phase commits a CONSISTENT intermediate state — no orphaned edges, no
 * partially-folded node (each fold+delete is one transaction), and the
 * counterpart a colliding node folds into is a target row that exists
 * throughout. If the process dies mid-merge, simply **re-running
 * mergeMemories on the same pair completes it**: classification rederives the
 * surviving colliding set from live rows, the relocate `updateMany` only
 * touches nodes still in the source, and a folded node is GONE (deleted with
 * its fold), so its text is never concatenated twice. The merge is therefore
 * idempotent under retry.
 *
 * Caller (the `mergeMemories` resolver) owns: ref resolution, class/encryption
 * preflight gating, per-memory write authorization (including third memories whose
 * edges re-point), and the post-merge embedding backfill. Encrypted memories
 * are rejected upstream and rechecked under row locks in every writing batch.
 */

/** Nodes folded / edges drained per inner transaction. Bounds tx size + lock duration. */
export const MERGE_BATCH_SIZE = 250;

/** Source nodes scanned per classification page (lightweight id+loc projection). */
const CLASSIFY_PAGE = 1000;

/**
 * Per-batch interactive-transaction timeout. A batch is at most
 * MERGE_BATCH_SIZE folds (each a version-create + an update) plus its incident
 * edges — comfortably bounded, but the default 5s is too tight under a slow
 * link, so we give generous headroom while keeping each tx finite.
 */
const BATCH_TX_OPTS = { timeout: 60_000, maxWait: 15_000 } as const;

export interface MergeMemoryArgs {
  sourceMemoryId: string;
  targetMemoryId: string;
  /** Field strategy for colliding nodes (CONTENT/ABSTRACT/.../EDGES). */
  fields: Set<NodeMergeField>;
  /** Soft-delete the (now-empty) source memory when true. */
  deleteSourceMem: boolean;
  /** Audit attribution for version/edit/update columns (#620: user PK vs
   *  fallback principal info are captured separately). */
  editor: SnapshotEditor;
  /** Nodes folded / edges drained per inner transaction. Test seam; defaults to MERGE_BATCH_SIZE. */
  batchSize?: number;
  /** Source nodes scanned per classify+relocate page. Test seam; defaults to CLASSIFY_PAGE. */
  classifyPageSize?: number;
}

export interface MergeMemoryResult {
  relocatedCount: number;
  foldedCount: number;
  edgesMovedCount: number;
  edgesDroppedCount: number;
}

/** NodeAbstractTooLongError carrying the offending loc (for the GraphQL extension). */
type AbstractTooLongAtLoc = NodeAbstractTooLongError & { loc?: string };

export async function mergeMemoryGraph(
  db: PrismaClient,
  args: MergeMemoryArgs,
): Promise<MergeMemoryResult> {
  const { sourceMemoryId, targetMemoryId, fields, deleteSourceMem, editor } = args;
  const actorId = editor.userId ?? editor.info ?? null;
  // Clamp to >= 1: a zero/negative batchSize (the test seam is public) would
  // never advance the fold loop and spin forever.
  const batchSize = Math.max(1, Math.floor(args.batchSize ?? MERGE_BATCH_SIZE));
  const classifyPage = Math.max(1, Math.floor(args.classifyPageSize ?? CLASSIFY_PAGE));
  const withEdges = fields.has('EDGES');

  /** Hold both flags through a batch so encryptMemory cannot flip mid-write. */
  const lockMergeMemoryRows = async (
    tx: Prisma.TransactionClient,
    lockMode: 'share' | 'update' = 'share',
    requirePlaintext = true,
  ): Promise<Map<string, string>> => {
    const urns = new Map<string, string>();
    for (const id of [sourceMemoryId, targetMemoryId].sort()) {
      const [memory] = lockMode === 'update'
        ? await tx.$queryRaw<Array<{ urn: string; is_encrypted: boolean }>>`
            SELECT urn, is_encrypted FROM memories WHERE id = ${id} FOR NO KEY UPDATE
          `
        : await tx.$queryRaw<Array<{ urn: string; is_encrypted: boolean }>>`
            SELECT urn, is_encrypted FROM memories WHERE id = ${id} FOR SHARE
          `;
      if (!memory) throw new Error(`merge memory ${id} disappeared while locking; retry the merge`);
      if (requirePlaintext && memory.is_encrypted) {
        throw new GraphQLError('mergeMemories does not support encrypted memories yet.', {
          extensions: { code: 'ENCRYPTED_MEMORY_MERGE_UNSUPPORTED', memoryId: id },
        });
      }
      urns.set(id, memory.urn);
    }
    return urns;
  };

  // #725/#737 — nodes landing in a schema-governed target (relocated OR folded)
  // must satisfy the target schema. A merge is a LONG batched op; the target's
  // schema can be tightened concurrently (an admin hardening the memory), so a
  // single snapshot taken at the top goes stale for later batches and would let
  // a non-conforming node fold in. Re-read the schema per relocate-page (Phase 1)
  // and per fold-batch INSIDE its transaction (Phase 2), so enforcement always
  // sees the schema current at write time. assertConformsAgainst no-ops for an
  // unschema'd target or a non-collection node.
  const fetchTargetSchema = async (client: Pick<typeof db, 'memory'>): Promise<MemorySchema | null> =>
    ((await client.memory.findUnique({ where: { id: targetMemoryId }, select: { schema: true } }))
      ?.schema as unknown as MemorySchema | null);
  const assertConformsAgainst = (
    schema: MemorySchema | null,
    objectType: string | null,
    properties: unknown,
  ): void => {
    const norm = normalizeObjectType(objectType);
    if (norm == null) return;
    try {
      validateNodeAgainstSchema(schema, norm, (properties ?? null) as Record<string, unknown> | null);
    } catch (e) {
      if (e instanceof NodeSchemaViolation) {
        throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      throw e;
    }
  };

  // === Preflight: the two gates every per-node writer consults (#1191). ===
  // Counted on `main` before this: ZERO gate calls in this whole operation, so
  // an authorized merge could relocate, rewrite or delete the nodes under a
  // Channel's address, or move a review node out from under the review door.
  //
  // BOTH endpoints, because a merge touches both: every source node relocates
  // or folds, and a fold OVERWRITES its target counterpart. Whole-memory
  // (`'all'`) rather than a loc set, because there is no partial merge — a
  // Channel left behind in the source would keep `Channel.memoryId`/`loc`
  // reserving an address its root no longer occupies, which is why
  // `nodeSubtreeMove` refuses a cross-memory move of a chat root for the same
  // reason.
  //
  // This preflight is FAIL-FAST ONLY and is not the authoritative check
  // (@codex + @copilot, both P1). A merge is paged across SEPARATE
  // transactions, so a Channel created — or a node promoted to a governed kind
  // — after this read and before a later page is invisible to it: "a check
  // before the lock was a TOCTOU window the size of the wait" (PR #1165), and
  // here the window was the whole merge. `assertBatchMutable` runs inside each
  // writing transaction and is what actually holds.
  //
  // It stays because refusing a doomed merge before it relocates anything is
  // worth one query per endpoint, and because the refusal is far more useful
  // up front than eight pages in.
  await assertMemoryBulkMutable(db, sourceMemoryId, 'merge');
  await assertMemoryBulkMutable(db, targetMemoryId, 'merge into');
  // #1468 — every source node leaves the source memory (relocated, or folded
  // and deleted) and the source memory is then deleted: a mint-stamped source
  // corpus holding a spec cannot be merged away. Fail fast here; each batch
  // and the final disposition re-check under their own locks.
  await preflightNoMintedCorpusRemoval(db, sourceMemoryId, 'merge out of its corpus', { includeTombstones: false });
  // #1450 — the same up-front refusal for placeholders, before any batch
  // commits: a merge into a memory that is not a draft corpus would publish
  // them. The per-batch check below still holds against one reserved mid-merge.
  {
    const target = await db.memory.findUnique({ where: { id: targetMemoryId }, select: { corpusDraft: true } });
    const placeholders = await db.node.findMany({
      where: { memoryId: sourceMemoryId, deletedAt: null, isPlaceholder: true },
      select: { loc: true, isPlaceholder: true },
      take: 1,
    });
    assertNoPlaceholdersLeaveDraft(placeholders, { isDraft: target?.corpusDraft === true, memoryId: targetMemoryId });
  }

  // === Phase 1: classify + relocate, in one keyset-paged scan. ===
  // Page the live source node addresses by id and match each page against the
  // target by loc. A source node whose
  // loc already exists in the target FOLDS into that counterpart (Phase 2 below);
  // the rest RELOCATE here in revisioned batches. Folding and
  // relocating in the same scan means the colliding set is the ONLY id list
  // we hold in memory, and every SQL `IN (...)`/`updateMany` list is bounded
  // by the page size — a giant source memory never builds an unbounded
  // `notIn` (which would blow the DB bind-parameter limit). Keyset (`id >
  // cursor`) is required: relocated movers leave the `memoryId = source` set,
  // but the colliding rows we leave behind would otherwise be re-read forever
  // by an offset/`take`-only loop.
  const survivor = new Map<string, string>(); // colliding src id → target counterpart id
  const collidingSrcIds: string[] = [];
  let relocatedCount = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await db.node.findMany({
      where: { memoryId: sourceMemoryId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, loc: true },
      orderBy: { id: 'asc' },
      take: classifyPage,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    const matches = await db.node.findMany({
      where: { memoryId: targetMemoryId, deletedAt: null, loc: { in: page.map((n) => n.loc) } },
      select: { id: true, loc: true },
    });
    const tgtByLoc = new Map(matches.map((t) => [t.loc, t.id]));
    const relocateIds: string[] = [];
    for (const s of page) {
      const tgtId = tgtByLoc.get(s.loc);
      if (tgtId) {
        survivor.set(s.id, tgtId);
        collidingSrcIds.push(s.id);
      } else {
        relocateIds.push(s.id);
      }
    }
    if (relocateIds.length > 0) {
      const relocateIdSet = new Set(relocateIds);
      const classifiedLocById = new Map(
        page.filter((row) => relocateIdSet.has(row.id)).map((row) => [row.id, row.loc]),
      );
      // Enforce the target schema on the collection members relocating in (only
      // when the target IS schema'd — page rows are id/loc-only, so fetch the
      // typed subset's discriminator/properties for validation). Re-read the
      // schema here so a mid-merge tightening is honored (not the top-of-fn one).
      const relocateSchema = await fetchTargetSchema(db);
      if (relocateSchema != null) {
        const typed = await db.node.findMany({
          where: { id: { in: relocateIds }, objectType: { not: null } },
          select: { objectType: true, properties: true },
        });
        for (const t of typed) assertConformsAgainst(relocateSchema, t.objectType, t.properties);
      }
      // The relocate moves into its own transaction so the AUTHORITATIVE gate
      // can hold the Channel-memory locks across the check and the write. It
      // was a bare `updateMany` before, which left nothing for the gate to be
      // authoritative inside.
      for (let i = 0; i < relocateIds.length; i += batchSize) {
        const ids = relocateIds.slice(i, i + batchSize);
        const moved = await db.$transaction(async (tx) => {
          let rows = await tx.node.findMany({
            where: { id: { in: ids }, memoryId: sourceMemoryId, deletedAt: null },
          });
          // Memory-scope locks precede every loc-scope lock in the global
          // protocol. This first gate acquires them and gives a fast refusal;
          // the second gate below rechecks the authoritative post-loc-lock rows.
          await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], rows, 'merge');
          await acquireLockSet(
            tx,
            ids.flatMap((id) => {
              const loc = classifiedLocById.get(id)!;
              return [
                { memoryId: sourceMemoryId, loc },
                { memoryId: targetMemoryId, loc },
              ];
            }),
          );
          // Lock node rows before Memory rows, matching moveNodeSubtree's
          // order. The resolver's one-time flag check can go stale between
          // batches, so pin both flags before reconciliation mints history.
          for (const id of [...ids].sort()) {
            await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
          }
          const memoryUrns = await lockMergeMemoryRows(tx);
          rows = await tx.node.findMany({
            where: { id: { in: ids }, memoryId: sourceMemoryId, deletedAt: null },
          });
          // #1468 — authoritative for this batch, under its node + memory locks.
          await assertNoMintedSpecRemoval(tx, sourceMemoryId, rows.map((r) => r.id), 'merge out of its corpus');
          for (const row of rows) {
            if (row.loc !== classifiedLocById.get(row.id)) {
              throw new Error(`merge source node ${row.id} moved during classification; retry the merge`);
            }
          }
          const lateCollision = await tx.node.findFirst({
            where: {
              memoryId: targetMemoryId,
              deletedAt: null,
              loc: { in: rows.map((row) => row.loc) },
            },
            select: { loc: true },
          });
          if (lateCollision) {
            throw new Error(`merge target loc ${lateCollision.loc} appeared during classification; retry the merge`);
          }
          // Reentrant memory locks; fresh governed/protected facts for the rows
          // now serialized by their source + destination address locks.
          await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], rows, 'merge');
          // #1323 (@codex P1, PR #1339): reconcile unrevisioned drift as each
          // row's OWN revision before its relocation snapshot, under the row
          // lock, in id order (one global order, so two multi-row operations
          // cannot lock-invert). Then re-read and re-validate: the snapshot
          // must describe the row as it is now, not as classified.
          const relocationIds = rows.map((row) => row.id).sort();
          for (const id of relocationIds) {
            await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: sourceMemoryId });
          }
          rows = await tx.node.findMany({ where: { id: { in: relocationIds } }, orderBy: { id: 'asc' } });
          for (const row of rows) {
            if (row.memoryId !== sourceMemoryId || row.deletedAt || row.loc !== classifiedLocById.get(row.id)) {
              throw new Error(`merge source node ${row.id} changed during the merge; retry the merge`);
            }
          }
          if (rows.length !== relocationIds.length) {
            throw new Error('a merge source node was deleted during the merge; retry the merge');
          }
          // The held Memory rows also pin both URNs against a concurrent rename.
          const sourceUrn = memoryUrns.get(sourceMemoryId)!;
          const targetUrn = memoryUrns.get(targetMemoryId)!;
          // #1448 (@codex P1, PR #1451): relocating out of a DRAFT spec corpus
          // leaves no alias, exactly like a move — a draft number was never
          // published. Read under the Memory lock held above, so a concurrent
          // mint cannot change the answer mid-batch.
          const [sourceFlags] = await tx.$queryRaw<Array<{ corpus_draft: boolean }>>`
            SELECT corpus_draft FROM memories WHERE id = ${sourceMemoryId}
          `;
          const recordAliases = !isDraftCorpus({ corpusDraft: sourceFlags?.corpus_draft === true });
          // #1450 — a placeholder never leaves draft corpora (see
          // SubtreeMovePlaceholderError); spec placeholders are also refused by
          // the governed guard above, this covers one whose role was changed.
          const [targetFlags] = await tx.$queryRaw<Array<{ corpus_draft: boolean }>>`
            SELECT corpus_draft FROM memories WHERE id = ${targetMemoryId}
          `;
          assertNoPlaceholdersLeaveDraft(rows, { isDraft: targetFlags?.corpus_draft === true, memoryId: targetMemoryId });
          for (const row of rows) {
            await createNodeRevision(
              tx,
              buildNodeRevisionSnapshot(row, editor, { changes: ['memoryId'] }),
            );
            // cor:urn:030:01 — this stable node ID changes its composed URN.
            // Record the old address beside the write in this bounded tx;
            // folded/deleted identities never reach this relocation loop.
            // The mirror root has loc='' and no round-trippable v2 node URN.
            if (row.loc && recordAliases) {
              await recordUrnRename(tx, {
                entityType: 'NODE',
                entityId: row.id,
                oldUrn: safeNodeUrnV2(sourceUrn, row.loc).slice('hrn:node:'.length),
                newUrn: safeNodeUrnV2(targetUrn, row.loc).slice('hrn:node:'.length),
                createdBy: actorId,
              });
            }
            await tx.node.update({
              where: { id: row.id },
              data: {
                memoryId: targetMemoryId,
                updatedBy: actorId,
                revisionContentHash: revisionStateHashRefreshMarker(),
              },
            });
          }
          return rows.length;
        }, BATCH_TX_OPTS);
        relocatedCount += moved;
      }
    }
    if (page.length < classifyPage) break;
  }

  // === Phase 2: fold the colliding nodes, in batches. ===
  // Each batch is its own transaction (bounded size + lock duration). Per
  // node: snapshot the target counterpart, merge fields, recompute the
  // abstract hash, repoint its incident edges (when EDGES is selected), then
  // delete the emptied source row. Repointing happens BEFORE the delete so an
  // edge transferred onto the counterpart doesn't cascade away with the row.
  let foldedCount = 0;
  let edgesMovedCount = 0;
  let edgesDroppedCount = 0;

  for (let i = 0; i < collidingSrcIds.length; i += batchSize) {
    const batchIds = collidingSrcIds.slice(i, i + batchSize);

    const batch = await db.$transaction(async (tx) => {
      let moved = 0;
      let dropped = 0;

      // The authoritative gate below reacquires these keys after refreshing
      // the fold rows. Take the complete Channel-memory set first: holding the
      // Node/Memory rows while waiting for a Channel key would invert against
      // final source disposition, which takes that key before its Memory rows.
      for (const id of [...new Set([sourceMemoryId, targetMemoryId])].sort()) {
        await lockMemoryForChannelChange(tx, id);
      }

      // Read the target schema INSIDE the tx so the fold validates against the
      // schema current at fold time (a tightening committed between batches is
      // honored), consistent with this batch's other reads/writes.
      const batchSchema = await fetchTargetSchema(tx);

      // Read the batch's rows INSIDE the transaction, constrained to their
      // expected memory + live state. Reading here (rather than before the tx)
      // closes a race: a concurrent relocate/delete between classification and
      // this fold can no longer cause a lost update or a stray cross-memory
      // write — the rows are read and mutated under the same tx. Only source
      // rows whose target counterpart is still live get folded; a vanished
      // counterpart leaves its source row untouched for a later pass (the
      // merge is resumable), never silently deleted.
      let srcRows = await tx.node.findMany({
        where: { id: { in: batchIds }, memoryId: sourceMemoryId, deletedAt: null },
      });
      let tgtRows = await tx.node.findMany({
        where: {
          id: { in: srcRows.map((s) => survivor.get(s.id)!) },
          memoryId: targetMemoryId,
          deletedAt: null,
        },
      });
      // #1323 (@codex P1, PR #1339): every row this fold reads or snapshots is
      // row-locked and reconciled (drift as its OWN revision) in id order
      // before anything is computed from it, then re-read — so the fold works
      // from the rows as they are under the lock, not as first fetched.
      // The loc pair each fold was CLASSIFIED on; a row that moved before its
      // lock no longer forms that collision (@copilot, PR #1339).
      const classifiedLoc = new Map([...srcRows, ...tgtRows].map((row) => [row.id, row.loc]));
      const foldIds = [...new Set([...srcRows, ...tgtRows].map((row) => row.id))].sort();
      // Each row only within the memory it was classified in (@copilot, PR
      // #1339): a row that moved out is neither reconciled nor silently
      // dropped — the transaction refuses, so nothing commits in its new memory.
      const foldMemory = new Map<string, string>([
        ...srcRows.map((row) => [row.id, sourceMemoryId] as const),
        ...tgtRows.map((row) => [row.id, targetMemoryId] as const),
      ]);
      // Lock all node rows first, as on other move paths; then recheck both
      // flags before the first drift reconciliation snapshot.
      for (const id of foldIds) {
        await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      }
      await lockMergeMemoryRows(tx);
      // #1468 — the folded source rows are deleted below: authoritative here.
      await assertNoMintedSpecRemoval(tx, sourceMemoryId, srcRows.map((r) => r.id), 'merge out of its corpus');
      for (const id of foldIds) {
        const reconciled = await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: foldMemory.get(id)! });
        if (reconciled == null) throw new Error(`merge node ${id} moved or vanished during the fold; retry the merge`);
      }
      srcRows = await tx.node.findMany({
        where: { id: { in: srcRows.map((row) => row.id) }, memoryId: sourceMemoryId, deletedAt: null },
      });
      tgtRows = await tx.node.findMany({
        where: {
          id: { in: srcRows.map((s) => survivor.get(s.id)!) },
          memoryId: targetMemoryId,
          deletedAt: null,
        },
      });
      for (const row of [...srcRows, ...tgtRows]) {
        if (row.loc !== classifiedLoc.get(row.id)) {
          throw new Error(`merge node ${row.id} moved during the fold; retry the merge`);
        }
      }
      const tgtById = new Map(tgtRows.map((t) => [t.id, t]));
      // The AUTHORITATIVE gate for this batch — both endpoints' rows, read
      // inside this transaction, under the Channel-memory locks. The Phase-1
      // preflight cannot cover a fold that runs transactions later.
      await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], [...srcRows, ...tgtRows], 'merge');
      const foldedIds: string[] = []; // source rows actually folded → safe to delete

      // -- Fold fields (per colliding node). --
      for (const src of srcRows) {
        const tgt = tgtById.get(survivor.get(src.id)!);
        if (!tgt) continue; // counterpart vanished (concurrent delete) — skip
        let merged;
        try {
          merged = mergeNodeFields(
            { content: src.content, abstract: src.abstract, description: src.description, tags: src.tags, data: src.data, properties: src.properties },
            { content: tgt.content, abstract: tgt.abstract, description: tgt.description, tags: tgt.tags, data: tgt.data, properties: tgt.properties },
            fields,
          );
        } catch (e) {
          // Tag the offending loc so the resolver can surface it (tx rolls back).
          if (e instanceof NodeAbstractTooLongError) (e as AbstractTooLongAtLoc).loc = tgt.loc;
          throw e;
        }
        await createNodeRevision(
          tx,
          buildNodeRevisionSnapshot(tgt, editor, {
            changes: Object.keys(merged.changed),
          }),
        );
        if (Object.keys(merged.changed).length > 0) {
          // #725/#737 — the folded target must still satisfy its collection.
          assertConformsAgainst(batchSchema, tgt.objectType, 'properties' in merged.changed ? merged.changed.properties : tgt.properties);
          // A collision fold authors a new target content state. Keep the
          // target's old stamp in its pre-fold NodeRevision above; the live
          // combination has no single verified author. Unchanged folds never
          // enter this branch, and relocations preserve their source stamp.
          const writeData: Record<string, unknown> = {
            ...merged.changed,
            ...clearNodeAuthorship(),
            updatedBy: actorId,
          };
          if (merged.abstractChanged) {
            writeData.abstractOriginHash = computeContentHash(
              merged.contentChanged ? (merged.changed.content as string | null) : tgt.content,
            );
          }
          writeData.revisionContentHash = revisionStateHashRefreshMarker();
          await tx.node.update({ where: { id: tgt.id }, data: writeData });
        }
        foldedIds.push(src.id);
      }

      // -- Re-point the folded nodes' incident edges onto the survivors. --
      // An edge touching a colliding node transfers only when EDGES is
      // selected; otherwise it is left to cascade with the deleted row.
      // Self-loops (both endpoints fold to the same survivor) and
      // (loc, memory) collisions in the target drop. Keyed off the nodes we
      // actually folded (not the raw batch) so a skipped node's edges are left
      // intact for its later pass.
      if (withEdges && foldedIds.length > 0) {
        const incident = await tx.edge.findMany({
          where: { OR: [{ sourceId: { in: foldedIds } }, { targetId: { in: foldedIds } }] },
        });
        const incidentIds = new Set(incident.map((e) => e.id));

        // The denormalized memory of an edge follows its SOURCE endpoint. A
        // re-pointed source endpoint that is a colliding node lands on its
        // counterpart (a target row → target memory). For an endpoint we
        // leave unchanged we read its CURRENT memory (a relocated node now
        // sits in the target; a foreign node keeps its own memory).
        const unknownSrc = new Set<string>();
        for (const e of incident) {
          if (!survivor.has(e.sourceId)) unknownSrc.add(e.sourceId);
        }
        const memById = new Map<string, string>();
        if (unknownSrc.size > 0) {
          for (const r of await tx.node.findMany({
            where: { id: { in: [...unknownSrc] } },
            select: { id: true, memoryId: true },
          })) {
            memById.set(r.id, r.memoryId);
          }
        }

        // Locs already taken in the target an incoming edge could collide
        // with — restricted to the candidate locs and EXCLUDING the in-flight
        // edges themselves (an edge already in the target memory that is also
        // incident to a colliding node appears here and must not be treated
        // as colliding with its own loc).
        const occupied = new Set<string>(
          (
            await tx.edge.findMany({
              where: { memoryId: targetMemoryId, loc: { in: incident.map((e) => e.loc) } },
              select: { id: true, loc: true },
            })
          )
            .filter((e) => !incidentIds.has(e.id))
            .map((e) => e.loc),
        );

        const toDrop: string[] = [];
        const memoryOnly: string[] = [];
        const remaps: Array<{ id: string; sourceId: string; targetId: string; memoryId: string }> = [];
        for (const e of incident) {
          const newSourceId = survivor.get(e.sourceId) ?? e.sourceId;
          const newTargetId = survivor.get(e.targetId) ?? e.targetId;
          if (newSourceId === newTargetId) {
            toDrop.push(e.id);
            continue;
          }
          const newMemoryId = survivor.has(e.sourceId)
            ? targetMemoryId
            : (memById.get(newSourceId) ?? e.memoryId);
          if (newMemoryId === targetMemoryId) {
            if (occupied.has(e.loc)) {
              toDrop.push(e.id);
              continue;
            }
            occupied.add(e.loc);
          }
          const endpointChanged = newSourceId !== e.sourceId || newTargetId !== e.targetId;
          if (endpointChanged) {
            remaps.push({ id: e.id, sourceId: newSourceId, targetId: newTargetId, memoryId: newMemoryId });
          } else if (newMemoryId !== e.memoryId) {
            memoryOnly.push(e.id);
          }
        }
        if (toDrop.length > 0) {
          await tx.edge.deleteMany({ where: { id: { in: toDrop } } });
        }
        if (memoryOnly.length > 0) {
          await tx.edge.updateMany({ where: { id: { in: memoryOnly } }, data: { memoryId: targetMemoryId } });
        }
        for (const r of remaps) {
          await tx.edge.update({
            where: { id: r.id },
            data: { sourceId: r.sourceId, targetId: r.targetId, memoryId: r.memoryId },
          });
        }
        moved += remaps.length + memoryOnly.length;
        dropped += toDrop.length;
      }

      // -- Delete the now-emptied colliding source rows. Only the rows we
      //    folded, and only if still in the source memory, so a concurrently
      //    relocated row is never cross-memory deleted. Any edge not
      //    transferred above cascades away with the row. --
      if (foldedIds.length > 0) {
        await tx.node.deleteMany({ where: { id: { in: foldedIds }, memoryId: sourceMemoryId } });
      }
      return { folded: foldedIds.length, moved, dropped };
    }, BATCH_TX_OPTS);

    foldedCount += batch.folded;
    edgesMovedCount += batch.moved;
    edgesDroppedCount += batch.dropped;
  }

  // === Phase 3: relocate the surviving source-memory edges into the target. ===
  // After Phases 2-3 the source memory holds no live nodes, so every edge
  // still denormalized to it is sourced from a relocated node (its endpoints
  // are unchanged — ids were preserved) and must follow into the target's loc
  // namespace. Drained in batches: each batch's source-memory edges have
  // distinct locs (the source's own unique index), so the only collisions are
  // against the target's existing locs — re-queried each batch so a prior
  // batch's moves are visible. Colliding edges drop; the rest move.
  for (;;) {
    const edges = await db.edge.findMany({
      where: { memoryId: sourceMemoryId },
      select: { id: true, loc: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (edges.length === 0) break;
    const taken = new Set(
      (
        await db.edge.findMany({
          where: { memoryId: targetMemoryId, loc: { in: edges.map((e) => e.loc) } },
          select: { loc: true },
        })
      ).map((e) => e.loc),
    );
    const drop = edges.filter((e) => taken.has(e.loc)).map((e) => e.id);
    const move = edges.filter((e) => !taken.has(e.loc)).map((e) => e.id);
    await db.$transaction(async (tx) => {
      await lockMergeMemoryRows(tx);
      if (drop.length > 0) await tx.edge.deleteMany({ where: { id: { in: drop } } });
      if (move.length > 0) {
        await tx.edge.updateMany({ where: { id: { in: move } }, data: { memoryId: targetMemoryId } });
      }
    }, BATCH_TX_OPTS);
    edgesMovedCount += move.length;
    edgesDroppedCount += drop.length;
    if (edges.length < batchSize) break;
  }

  // === Final: soft-delete the now-empty source memory when asked. ===
  if (deleteSourceMem) {
    // Under the lock and re-checked (@copilot round 2). The per-batch gates
    // release `channel-host:<source>` when their transactions end, so a Channel
    // created between the last batch and this update would otherwise let a
    // merge soft-delete a memory that now HOSTS one — the normal delete path
    // locks and re-checks for exactly this reason, and this one did not.
    await db.$transaction(async (tx) => {
      // `'all'`, not the batch form with an empty row list — that would make
      // the check vacuous, since an empty loc list overlaps nothing. Deleting
      // the memory puts EVERY address in it out of reach, so any Channel at all
      // refuses.
      await lockMemoryForChannelChange(tx, sourceMemoryId);
      // The later memory.update needs NO KEY UPDATE. Take it on BOTH rows in
      // stable ID order now; opposing merges must not each upgrade a shared
      // lock on a different source row after holding SHARE on both.
      // All content and edge writes have committed. Disposition only marks
      // the source deleted, so a target encryption flip after those batches
      // must not strand the requested cleanup.
      await lockMergeMemoryRows(tx, 'update', false);
      await assertNoProtectedReach(tx, sourceMemoryId, 'all', 'delete');
      // #1468 — the source memory's deletion: whatever the batches left.
      await assertNoMintedCorpusRemoval(tx, sourceMemoryId, 'merge out of its corpus', { includeTombstones: false });
      await tx.memory.update({ where: { id: sourceMemoryId }, data: { deletedAt: new Date() } });
    });
  }

  return { relocatedCount, foldedCount, edgesMovedCount, edgesDroppedCount };
}
