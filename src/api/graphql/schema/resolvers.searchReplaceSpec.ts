import { stampEmbeddingObligation } from '../../../services/embedding/obligation.js';
/**
 * #1294: the spec-only bulk door. Selection is explicit and belongs to one
 * draft corpus. Apply locks that corpus and every selected row, rebuilds the
 * same preview under those locks, and writes only when its fingerprint agrees.
 * The generic mutation still excludes governed nodes.
 */
import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { NodeNotFoundError, NodeAbstractTooLongError } from '../../../lib/entityRef/errors.js';
import { governedKindsOf } from '../../../lib/governedRole.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { protectedLocsIn, protectedLocCovers } from '../../../lib/protectedLoc.js';
import {
  buildReplacer,
  SearchReplaceInvalidPatternError,
} from '../../../lib/searchReplace.js';
import {
  computeRevisionStateHash,
  createNodeRevision,
  buildNodeRevisionSnapshot,
  editorFromAuth,
  revisionStateHashRefreshMarker,
} from '../../../lib/nodeRevisionSnapshot.js';
import { decryptNodeFields, encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { clearNodeAuthorship } from '../../../lib/nodeAuthorship.js';
import { recordNodeUsage, toUsageNodeRefs } from '../../../lib/usageRecorder.js';
import { enqueueNodeEmbedding } from '../../../services/embedding/enqueue.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import {
  type Context,
  requireMemoryWriteAccess,
  concealUnreadableDenial,
  getAccessibleMemoryIds,
} from './resolvers.helpers.js';
import { assertIncludesWritable, syncDerivedIncludesEdges } from '../../../lib/includes/writeIncludes.js';

export interface SpecSearchReplaceInput {
  memoryRef: string;
  nodeIds: string[];
  oldText: string;
  newText: string;
  fields: Array<'content' | 'abstract'>;
  caseInsensitive?: boolean;
  regex?: boolean;
  wordBoundary?: boolean;
  dryRun?: boolean;
  expectedPlan?: string | null;
  maxNodesChanged?: number | null;
  reason?: string | null;
}

type NodeRow = NonNullable<Awaited<ReturnType<Context['db']['node']['findUnique']>>>;
type DbTx = Prisma.TransactionClient;

interface ChangedNode {
  raw: NodeRow;
  changed: { content?: string; abstract?: string | null };
  plaintext: { content: string | null; abstract: string | null };
  /** #2041 S2b — the content before replacement, read under the apply transaction's row locks. */
  storedContent: string | null;
  isEncrypted: boolean;
  contentChanged: boolean;
  abstractChanged: boolean;
  total: number;
  fields: Array<{ field: 'content' | 'abstract'; matches: number }>;
}

interface Snapshot {
  result: {
    nodesSelected: number;
    nodesScanned: number;
    nodesSkipped: number;
    skipCounts: { governed: number; protectedAddress: number };
    nodesChanged: number;
    totalReplacements: number;
    dryRun: boolean;
    results: Array<{
      nodeId: string;
      loc: string;
      memoryId: string;
      replacements: number;
      fields: ChangedNode['fields'];
    }>;
    skips: Array<{
      nodeId: string;
      loc: string;
      memoryId: string;
      reason: 'OTHER_GOVERNED_KIND' | 'PROTECTED_ADDRESS';
      governedKinds: string[];
    }>;
    plan: string;
  };
  changed: ChangedNode[];
}

function error(message: string, code: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

const stale = () => error('The spec replacement preview is stale; run a new dry run.', 'SEARCH_REPLACE_PLAN_STALE');

export async function searchReplaceInSpecNodes(
  _: unknown,
  { input }: { input: SpecSearchReplaceInput },
  ctx: Context,
) {
  if (!Array.isArray(input.nodeIds) || input.nodeIds.length === 0) {
    throw error('Select at least one spec node.', 'SEARCH_REPLACE_NO_SELECTION');
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0 ||
      input.fields.some((field) => field !== 'content' && field !== 'abstract')) {
    throw error('Spec replacement fields must be content or abstract.', 'SEARCH_REPLACE_NO_FIELDS');
  }
  if (input.maxNodesChanged != null &&
      (!Number.isInteger(input.maxNodesChanged) || input.maxNodesChanged < 0)) {
    throw error('maxNodesChanged must be a non-negative integer.', 'SEARCH_REPLACE_BAD_LIMIT');
  }
  const dryRun = input.dryRun === true;
  if (!dryRun && !input.expectedPlan) {
    throw error('Apply requires the exact dry-run plan.', 'SEARCH_REPLACE_PLAN_REQUIRED');
  }

  let replacer;
  try {
    replacer = buildReplacer(input.oldText, input.newText, {
      caseInsensitive: input.caseInsensitive === true,
      regex: input.regex === true,
      wordBoundary: input.wordBoundary !== false,
    });
  } catch (cause) {
    if (cause instanceof SearchReplaceInvalidPatternError) {
      throw new GraphQLError(cause.message, {
        extensions: { code: cause.name, pattern: cause.pattern, reason: cause.reason },
      });
    }
    throw cause;
  }

  let memoryId: string;
  try {
    ({ id: memoryId } = await resolveMemoryRef(ctx.db, input.memoryRef));
  } catch (cause) {
    if (!dryRun) throw stale();
    throw cause;
  }
  await concealUnreadableDenial(ctx, memoryId, input.memoryRef, () =>
    requireMemoryWriteAccess(ctx, memoryId),
  );

  // Resolve the exact selection before the transaction, reading only metadata.
  // The apply transaction rechecks the current memory before loading plaintext.
  const ids = new Set<string>();
  for (const ref of input.nodeIds) {
    let id: string;
    try {
      ({ id } = await resolveNodeRefForCaller(ctx, ref));
    } catch (cause) {
      if (!dryRun) throw stale();
      throw cause;
    }
    const row = await ctx.db.node.findUnique({
      where: { id },
      select: { memoryId: true, deletedAt: true },
    });
    if (!row || row.deletedAt) throw dryRun ? new NodeNotFoundError(ref) : stale();
    if (row.memoryId !== memoryId) {
      throw dryRun
        ? error('Every selected node must belong to the chosen draft corpus.', 'SEARCH_REPLACE_MIXED_CORPUS')
        : stale();
    }
    ids.add(id);
  }
  const selectedIds = [...ids].sort();
  const fields = [...new Set(input.fields)].sort() as Array<'content' | 'abstract'>;

  const snapshot = async (tx: DbTx, applying: boolean): Promise<Snapshot> => {
    const memory = await tx.memory.findUnique({
      where: { id: memoryId },
      select: { id: true, deletedAt: true, isEncrypted: true },
    });
    if (!memory || memory.deletedAt) throw applying ? stale() : error('The corpus was deleted.', 'SEARCH_REPLACE_PLAN_STALE');

    const meta = await tx.node.findMany({
      where: { id: { in: selectedIds } },
      orderBy: { id: 'asc' },
      select: {
        id: true, memoryId: true, deletedAt: true, loc: true,
        role: true, isRunnable: true, revSeq: true, revisionContentHash: true, mintedAt: true,
      },
    });
    if (meta.length !== selectedIds.length ||
        meta.some((row) => row.deletedAt || row.memoryId !== memoryId)) {
      throw applying ? stale() : error('Selected nodes changed or left the draft corpus.', 'SEARCH_REPLACE_MIXED_CORPUS');
    }
    // #1591: bulk replacement is a draft right, so every target must be
    // unminted. Read under the snapshot's own transaction, so a mint that
    // commits after the dry run makes the apply stale rather than rewrite it.
    const minted = meta.filter((row) => row.mintedAt !== null).map((row) => row.loc).sort();
    if (minted.length > 0) {
      throw applying ? stale() : error(
        `Spec bulk replacement applies only to unminted nodes; minted: ${minted.slice(0, 10).join(', ')}` +
          `${minted.length > 10 ? ` (and ${minted.length - 10} more)` : ''}.`,
        'SEARCH_REPLACE_NOT_DRAFT',
      );
    }

    const protectedLocs = await protectedLocsIn(tx, memoryId);
    const skips: Snapshot['result']['skips'] = [];
    const changed: ChangedNode[] = [];
    const rowFingerprints: Array<{
      id: string; revSeq: number; memoryId: string; loc: string;
      role: string | null; isRunnable: boolean | null;
      stateHash: string; skip: string;
    }> = [];
    let scanned = 0;
    let governed = 0;
    let protectedAddress = 0;
    const encryption = { id: memory.id, isEncrypted: memory.isEncrypted };
    const scannedIds: string[] = [];

    for (const row of meta) {
      // This is the DB's canonical hash of the revisioned state, including
      // current at-rest text. Refuse an unrevisioned drift rather than
      // previewing a state whose revision history cannot be trusted.
      const stateHash = await computeRevisionStateHash(tx, row.id);
      if (!stateHash) throw applying ? stale() : new NodeNotFoundError(row.id);
      const kinds = governedKindsOf({ role: row.role, isRunnable: row.isRunnable });
      const otherKinds = kinds.filter((entry) => entry.kind !== 'spec').map((entry) => entry.kind);
      let skip = '';
      if (otherKinds.length > 0) {
        governed++;
        skip = 'OTHER_GOVERNED_KIND';
        skips.push({ nodeId: row.id, loc: row.loc, memoryId, reason: 'OTHER_GOVERNED_KIND', governedKinds: otherKinds });
      } else if (protectedLocs.some((entry) => protectedLocCovers(entry, row.loc))) {
        protectedAddress++;
        skip = 'PROTECTED_ADDRESS';
        skips.push({ nodeId: row.id, loc: row.loc, memoryId, reason: 'PROTECTED_ADDRESS', governedKinds: [] });
      } else {
        if (row.revisionContentHash !== stateHash) {
          throw applying ? stale() : error(
            `Selected node ${row.loc} (${row.id}) has unrevisioned drift. Read it with node(ref: "${row.id}", raw: true) to reconcile its revision, then run a new dry run.`,
            'NODE_WRITE_CONFLICT',
          );
        }
        scanned++;
        scannedIds.push(row.id);
      }
      rowFingerprints.push({
        id: row.id, revSeq: row.revSeq, memoryId: row.memoryId, loc: row.loc,
        role: row.role, isRunnable: row.isRunnable, stateHash, skip,
      });
    }

    if (scanned > 0 && encryption.isEncrypted && !sessionKeyCache.getByMemoryId(memoryId)) {
      throw new GraphQLError(`SESSION_EXPIRED: memory ${memoryId} is encrypted but no active session key is available.`, {
        extensions: { code: 'SESSION_EXPIRED', memoryId },
      });
    }
    // Only eligible rows load text into the resolver. Protected selections
    // contribute a canonical state hash and skip reason, not their payload.
    const rows = scannedIds.length > 0 ? await tx.node.findMany({
      where: { id: { in: scannedIds } },
      orderBy: { id: 'asc' },
    }) as NodeRow[] : [];
    for (const row of rows) {
      const pt = { ...row };
      if (encryption.isEncrypted) decryptNodeFields(pt, encryption);
      const replacement: ChangedNode = {
        raw: row,
        changed: {},
        plaintext: { content: pt.content, abstract: pt.abstract },
        storedContent: pt.content,
        isEncrypted: encryption.isEncrypted,
        contentChanged: false,
        abstractChanged: false,
        total: 0,
        fields: [],
      };
      if (fields.includes('content') && pt.content != null) {
        const next = replacer.apply(pt.content);
        if (next.count > 0) {
          replacement.changed.content = next.value;
          replacement.plaintext.content = next.value;
          replacement.contentChanged = true;
          replacement.total += next.count;
          replacement.fields.push({ field: 'content', matches: next.count });
        }
      }
      if (fields.includes('abstract') && pt.abstract != null) {
        const next = replacer.apply(pt.abstract);
        if (next.count > 0) {
          if (next.value.length > 2000) {
            const tooLong = new NodeAbstractTooLongError(next.value.length, { currentLength: pt.abstract.length });
            throw new GraphQLError(`${tooLong.message} (node ${pt.loc} / ${pt.id})`, {
              extensions: { ...tooLong.extensionFields(), nodeId: pt.id, loc: pt.loc },
            });
          }
          replacement.changed.abstract = next.value.trim() === '' ? null : next.value;
          replacement.plaintext.abstract = replacement.changed.abstract;
          replacement.abstractChanged = true;
          replacement.total += next.count;
          replacement.fields.push({ field: 'abstract', matches: next.count });
        }
      }
      if (replacement.total > 0) changed.push(replacement);
    }

    const plan = createHash('sha256').update(JSON.stringify({
      memoryId,
      corpusDraft: true,
      selectedIds,
      oldText: input.oldText,
      newText: input.newText,
      fields,
      caseInsensitive: input.caseInsensitive === true,
      regex: input.regex === true,
      wordBoundary: input.regex === true ? false : input.wordBoundary !== false,
      reason: input.reason ?? null,
      maxNodesChanged: input.maxNodesChanged ?? null,
      rows: rowFingerprints,
      matches: changed.map((node) => [node.raw.id, node.total, node.fields]),
    })).digest('hex');
    return {
      changed,
      result: {
        nodesSelected: meta.length,
        nodesScanned: scanned,
        nodesSkipped: skips.length,
        skipCounts: { governed, protectedAddress },
        nodesChanged: changed.length,
        totalReplacements: changed.reduce((sum, node) => sum + node.total, 0),
        dryRun,
        results: changed.map((node) => ({
          nodeId: node.raw.id,
          loc: node.raw.loc,
          memoryId: node.raw.memoryId,
          replacements: node.total,
          fields: node.fields,
        })),
        skips,
        plan,
      },
    };
  };

  if (dryRun) {
    // One MVCC snapshot across corpus state, selected rows and Channel state.
    const preview = await ctx.db.$transaction((tx) => snapshot(tx, false), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 120_000,
    });
    return preview.result;
  }

  let readableForIncludes: string[] | null = null;
  const applied = await ctx.db.$transaction(async (tx) => {
    // Channel creation takes this memory key. Lock every selected Node before
    // the Memory row: ordinary node writers take Node then Memory FOR SHARE.
    // Minting and memory deletion update the Memory row after these locks.
    await lockMemoryForChannelChange(tx, memoryId);
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ANY(${selectedIds}::text[]) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR NO KEY UPDATE`;

    // Repeat authorization under the row/memory locks. Snapshot then refuses
    // any row that moved out of this memory before it reads plaintext.
    await requireMemoryWriteAccess(ctx, memoryId);

    const current = await snapshot(tx, true);
    if (current.result.plan !== input.expectedPlan) throw stale();
    if (input.maxNodesChanged != null && current.changed.length > input.maxNodesChanged) {
      throw error('The replacement exceeds maxNodesChanged.', 'SEARCH_REPLACE_MAX_NODES_CHANGED');
    }
    for (const node of current.changed) {
      await createNodeRevision(tx, buildNodeRevisionSnapshot(node.raw, editorFromAuth(ctx), {
        revLabel: input.reason,
        changes: Object.keys(node.changed),
      }));
      const data: Record<string, unknown> = {};
      if (node.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memoryId)!;
        const encrypted = encryptNodeFieldsWithKey({
          content: node.contentChanged ? node.changed.content! : null,
          abstract: node.abstractChanged ? node.changed.abstract! : null,
        }, key);
        if (node.contentChanged) data.content = encrypted.content;
        if (node.abstractChanged) data.abstract = encrypted.abstract;
      } else {
        if (node.contentChanged) data.content = node.changed.content;
        if (node.abstractChanged) data.abstract = node.changed.abstract;
      }
      if (node.abstractChanged) {
        data.abstractOriginHash = computeContentHash(node.plaintext.content);
      }
      data.revisionContentHash = revisionStateHashRefreshMarker();
      Object.assign(data, clearNodeAuthorship());
      await tx.node.update({ where: { id: node.raw.id }, data });
      if (node.contentChanged || node.abstractChanged) {
        node.raw.embeddingWorkToken = await stampEmbeddingObligation(tx, node.raw.id, memoryId);
      }
      // #2040 — a content rewrite re-checks its include tags inside the batch.
      if (node.contentChanged) {
        const text = node.plaintext.content;
        readableForIncludes ??= text?.includes('{{>') ? await getAccessibleMemoryIds(ctx) : null;
        const stored = { storedPlaintext: node.storedContent };
        const tags = await assertIncludesWritable(tx, node.raw, text, readableForIncludes, undefined, stored);
        await syncDerivedIncludesEdges(tx, node.raw, tags, readableForIncludes, stored);
      }
    }
    return current;
  }, { timeout: 120_000 });

  if (applied.changed.length > 0) {
    recordNodeUsage(ctx.db, 'write', toUsageNodeRefs(applied.changed.map((node) => node.raw)), ctx);
  }
  for (const node of applied.changed) {
    if (node.contentChanged || node.abstractChanged) {
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: node.raw.id,
        workToken: node.raw.embeddingWorkToken,
        memoryId,
        plaintext: node.plaintext,
      });
    }
    void publishNodeWritten({
      nodeId: node.raw.id,
      memoryId,
      ownerRepo: node.raw.ownerRepo ?? '',
      clientId: ctx.clientId,
    });
  }
  return applied.result;
}
