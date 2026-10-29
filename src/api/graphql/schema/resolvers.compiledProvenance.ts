import { Prisma } from '../../../generated/prisma/index.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../../../lib/bootPrompt.js';
import { parseCompiledProvenance, CompiledRevisionIntegrityError } from '../../../lib/bootCompile/provenance.js';
import { liveReadSnapshotContext } from './authorizedTx.js';
import { isMemoryReadableCached, pageArgs, pageEnvelope, type Context } from './resolvers.helpers.js';

/**
 * #2046 / cor:agt:040:12: recorded metadata for ONE compiled revision, never
 * reconstructed from current edges or source nodes. Gate the live compiled
 * node and read its record in one read-only snapshot; a parent is no authority.
 */
export const compiledProvenanceFieldResolvers = {
  Node: {
    compiledProvenance: async (
      parent: { id: string },
      args: { revision?: number | null; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const fresh = await liveReadSnapshotContext(ctx, tx);
      const node = await tx.node.findUnique({ where: { id: parent.id },
        select: { memoryId: true, nodeType: true, deletedAt: true, revSeq: true } });
      if (!node || node.deletedAt || !(await isMemoryReadableCached(fresh, node.memoryId))) return null;
      if (node.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) return null;
      const revision = args.revision ?? node.revSeq;
      if (!Number.isInteger(revision) || revision < 1 || revision > node.revSeq) return null;
      const record = await tx.compiledPromptRevision.findUnique({
        where: { compiledNodeId_compiledRevNo: { compiledNodeId: parent.id, compiledRevNo: revision } },
      });
      if (!record) return null;
      const provenance = parseCompiledProvenance(record.provenance, parent.id, revision);
      if (record.occurrenceCount !== provenance.occurrences.length) {
        throw new CompiledRevisionIntegrityError(parent.id, revision, 'occurrence count disagrees with the stored occurrences');
      }
      const { take, skip } = pageArgs(args);
      const page = provenance.occurrences.slice(skip, skip + take);
      // Only existence metadata for this bounded page, never source content.
      // The current source revision need not have a history snapshot yet.
      const nodes = await tx.node.findMany({ where: { id: { in: page.map((o) => o.nodeId) } }, select: { id: true, revSeq: true } });
      const snapshots = page.length ? await tx.nodeRevision.findMany({
        where: { OR: page.map((o) => ({ nodeId: o.nodeId, revNo: o.revNo })) },
        select: { nodeId: true, revNo: true },
      }) : [];
      const current = new Map(nodes.map((n) => [n.id, n.revSeq]));
      const retained = new Set(snapshots.map((r) => `${r.nodeId}:${r.revNo}`));
      const items = page.map((o) => ({ ...o, pruned: current.get(o.nodeId) !== o.revNo && !retained.has(`${o.nodeId}:${o.revNo}`) }));
      return { revision, contentHash: record.contentHash,
        ...pageEnvelope(items, record.occurrenceCount, skip) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 5_000, maxWait: 2_000 }),
  },
};
