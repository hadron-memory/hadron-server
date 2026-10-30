/** #2175 / cor:dmo:010:04: explicit recovery DTOs; ordinary node reads never acquire recovery authority. */
import { GraphQLError } from 'graphql';
import { Prisma, type Node } from '../../../generated/prisma/index.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { NodeNotFoundError, MemoryNotFoundError } from '../../../lib/entityRef/errors.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { decryptNodeFields } from '../../../lib/nodeCrypto.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { acquireLockSet, ancestorLocs } from '../../../lib/nodeSubtreeLock.js';
import { assertLocWritable } from '../../../lib/protectedLoc.js';
import { lockMemoryForChannelChange } from '../../../lib/channels.js';
import { lockRemovalRows } from '../../../lib/governedRemoval.js';
import { assertGovernedWrite } from '../../../lib/governedRole.js';
import { COMMENT_NODE_TYPE, assertNotCommentWrite } from '../../../lib/comments/index.js';
import { restoreThreadsOfTargets } from '../../../lib/comments/lifecycle.js';
import { assertBootPromptWriteAllowed } from '../../../lib/bootPrompt.js';
import { assertRoleWritersForNodes } from '../../../lib/nodeRoleWriters.js';
import { publishNodeWritten } from '../../../lib/events/nodeWritten.js';
import { isDeadlockVictim } from '../../../lib/memoryLockConflict.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { liveTxContext } from './authorizedTx.js';
import { lockInstallAuthorityFirst } from './installMemory.js';
import { type Context, isAuthorizationDenial, isMemoryReadableCached, nodeNotFoundError, requireMemoryWriteAccess, withoutRequestCaches } from './resolvers.helpers.js';

/** Expected authorization failures alone collapse to a concealed recovery miss. */
/** R131: no recovery capability is inferred from a credential holder or run's on-behalf-of user. */
function recoveryPrincipal(ctx: Context): boolean {
  return !!ctx.userId && !ctx.impersonation && !isRunPrincipal(ctx) && !ctx.appKeyId;
}

/** Same point gates as ordinary content and writes, with explicit owning-scope liveness. */
export async function canRecoverMemory(ctx: Context, memoryId: string): Promise<boolean> {
  if (!recoveryPrincipal(ctx)) return false;
  const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, include: { organization: true, app: true } });
  if (!memory || memory.deletedAt || memory.organization?.deletedAt || memory.app?.deletedAt || memory.app?.uninstalledAt) return false;
  if (!(await isMemoryReadableCached(ctx, memoryId))) return false;
  try { await requireMemoryWriteAccess(ctx, memoryId); return true; }
  catch (error) { if (isAuthorizationDenial(error)) return false; throw error; }
}

/** Recovery-authorized subset of an already scoped memory set; no all-memory/admin fallback. */
export async function recoveryMemoryIds(ctx: Context, ids: readonly string[]): Promise<string[]> {
  const allowed: string[] = [];
  for (const id of new Set(ids)) if (await canRecoverMemory(ctx, id)) allowed.push(id);
  return allowed;
}

/** Resolve one live, recovery-authorized corpus; denial and absence have the same envelope. */
async function recoveryMemory(ctx: Context, ref: string): Promise<string> {
  const { id } = await resolveMemoryRef(ctx.db, ref);
  if (!(await canRecoverMemory(ctx, id))) throw new MemoryNotFoundError(ref);
  return id;
}

/** A retained node's explicit identity projection; contains no generic entity relations. */
async function summary(ctx: Context, node: Node) {
  const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: node.memoryId }, select: { urn: true } });
  return { id: node.id, urn: emitNodeUrnV2(memory.urn, node.loc), memoryId: node.memoryId,
    loc: node.loc, name: node.name, nodeType: node.nodeType, deletedAt: node.deletedAt };
}

/** The largest recovery page, and the most edge ids one recoveryEdges call may name. */
const RECOVERY_PAGE_MAX = 200;

/** Null means omitted on both transports; a complete-set consumer can drain offset pages using total. */
function page(args: { limit?: number | null; offset?: number | null }) {
  return { take: Math.min(RECOVERY_PAGE_MAX, Math.max(1, args.limit ?? 20)), skip: Math.max(0, args.offset ?? 0) };
}

/**
 * #2818: an optional edge-id restriction, refused outside 1..RECOVERY_PAGE_MAX before any lookup.
 * An id that is not a visible edge of the memory is simply absent, so naming it discloses nothing a full scan would not.
 */
function edgeRestriction(edgeIds: readonly string[] | null | undefined): Prisma.Sql {
  if (edgeIds == null) return Prisma.empty;
  if (edgeIds.length === 0 || edgeIds.length > RECOVERY_PAGE_MAX) {
    throw new GraphQLError(`edgeIds must name 1 to ${RECOVERY_PAGE_MAX} edges.`, { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return Prisma.sql` AND e.id = ANY(${[...new Set(edgeIds)]}::text[])`;
}

/** A recovery reference never falls back to an inherited node or successor at another address. */
async function recoveryTarget(ctx: Context, ref: string) {
  let id: string;
  try { ({ id } = await resolveNodeRefForCaller(ctx, ref, undefined, { includeDeleted: true })); }
  catch (error) { if (error instanceof NodeNotFoundError) return null; throw error; }
  const node = await ctx.db.node.findUnique({ where: { id }, select: { id: true, memoryId: true, loc: true, deletedAt: true } });
  return node && await canRecoverMemory(ctx, node.memoryId) ? node : null;
}

export const recoveryQueries = {
  /** Explicit graph inspection; endpoint authority and ancestor liveness precede SQL count and page. */
  recoveryEdges: async (_: unknown, args: { memoryRef: string; edgeIds?: string[] | null; limit?: number | null; offset?: number | null }, ctx: Context) => {
    const only = edgeRestriction(args.edgeIds);
    const memoryId = await recoveryMemory(ctx, args.memoryRef);
    // #2810: a UNION of key lookups; an OR join condition cannot use the node primary key.
    const endpointIds = Prisma.sql`SELECT e.source_id FROM edges e WHERE e.memory_id = ${memoryId} AND e.deleted_at IS NULL${only}
      UNION SELECT e.target_id FROM edges e WHERE e.memory_id = ${memoryId} AND e.deleted_at IS NULL${only}`;
    // #2818: a restricted call probes its few endpoints by primary key; IN would hash-join a scan of every node.
    const endpointMemories = await ctx.db.$queryRaw<Array<{ memory_id: string }>>(args.edgeIds == null
      ? Prisma.sql`SELECT DISTINCT n.memory_id FROM nodes n WHERE n.id IN (${endpointIds})`
      : Prisma.sql`SELECT DISTINCT n.memory_id FROM nodes n WHERE n.id = ANY(ARRAY(${endpointIds}))`);
    const readable: string[] = [], recoverable: string[] = [];
    for (const { memory_id: id } of endpointMemories) {
      const memory = await ctx.db.memory.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!memory || memory.deletedAt || !(await isMemoryReadableCached(ctx, id))) continue;
      readable.push(id);
      if (await canRecoverMemory(ctx, id)) recoverable.push(id);
    }
    // Every interpolated value is a bound SQL parameter. The ancestors are the endpoint loc's ':'-boundary
    // prefixes (ancestorLocs), probed by equality on (memory_id, loc). #2810: a prefix comparison against
    // every tombstone cannot use an index and scanned the whole nodes table once per endpoint.
    const endpoint = (alias: 's' | 't') => {
      const n = Prisma.raw(alias);
      return Prisma.sql`(( ${n}.deleted_at IS NULL AND ${n}.memory_id = ANY(${readable}::text[])
        AND NOT EXISTS (SELECT 1 FROM nodes p WHERE p.memory_id = ${n}.memory_id AND p.deleted_at IS NOT NULL
          AND p.loc = ANY(ARRAY(SELECT array_to_string((string_to_array(${n}.loc, ':'))[1:g.i], ':')
            FROM generate_series(1, cardinality(string_to_array(${n}.loc, ':')) - 1) g(i)))))
        OR (${n}.deleted_at IS NOT NULL AND ${n}.node_type <> ${COMMENT_NODE_TYPE}
          AND ${n}.memory_id = ANY(${recoverable}::text[])))`;
    };
    const predicate = Prisma.sql`e.memory_id = ${memoryId} AND e.deleted_at IS NULL${only} AND ${endpoint('s')} AND ${endpoint('t')}`;
    const { take, skip } = page(args);
    type GraphRow = { id: string; name: string; source_id: string; source_loc: string; source_name: string;
      source_deleted: Date | null; source_urn: string; target_id: string; target_loc: string; target_name: string;
      target_deleted: Date | null; target_urn: string };
    const [counts, rows] = await ctx.db.$transaction([
      ctx.db.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT count(*) AS total FROM edges e
        JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
        JOIN memories ms ON ms.id = s.memory_id JOIN memories mt ON mt.id = t.memory_id
        WHERE ms.deleted_at IS NULL AND mt.deleted_at IS NULL AND ${predicate}`),
      ctx.db.$queryRaw<GraphRow[]>(Prisma.sql`SELECT e.id, e.name,
        s.id AS source_id, s.loc AS source_loc, s.name AS source_name, s.deleted_at AS source_deleted, ms.urn AS source_urn,
        t.id AS target_id, t.loc AS target_loc, t.name AS target_name, t.deleted_at AS target_deleted, mt.urn AS target_urn
        FROM edges e JOIN nodes s ON s.id = e.source_id JOIN nodes t ON t.id = e.target_id
        JOIN memories ms ON ms.id = s.memory_id JOIN memories mt ON mt.id = t.memory_id
        WHERE ms.deleted_at IS NULL AND mt.deleted_at IS NULL AND ${predicate}
        ORDER BY e.loc, e.id LIMIT ${take} OFFSET ${skip}`),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { total: Number(counts[0]?.total ?? 0), items: rows.map((r) => ({ id: r.id, name: r.name,
      source: { id: r.source_id, urn: emitNodeUrnV2(r.source_urn, r.source_loc), loc: r.source_loc, name: r.source_name, deletedAt: r.source_deleted },
      target: { id: r.target_id, urn: emitNodeUrnV2(r.target_urn, r.target_loc), loc: r.target_loc, name: r.target_name, deletedAt: r.target_deleted },
    })) };
  },
  /** Explicit raw recovery read. Templates and generic nested Node resolvers never run. */
  recoveryNode: async (_: unknown, args: { nodeRef: string }, ctx: Context) => {
    const target = await recoveryTarget(ctx, args.nodeRef);
    if (!target?.deletedAt) return null;
    const node = await ctx.db.node.findFirst({ where: { id: target.id, memoryId: target.memoryId, loc: target.loc,
      deletedAt: { not: null }, nodeType: { not: COMMENT_NODE_TYPE } } });
    return node ? { ...await summary(ctx, node), description: node.description, _retainedNode: node } : null;
  },
  /** Writer-only tombstone listing, authorization before SQL count and pagination. */
  recoveryNodes: async (_: unknown, args: { memoryRef: string; limit?: number | null; offset?: number | null }, ctx: Context) => {
    const memoryId = await recoveryMemory(ctx, args.memoryRef);
    const where = { memoryId, deletedAt: { not: null }, nodeType: { not: COMMENT_NODE_TYPE } };
    const [total, nodes] = await ctx.db.$transaction([
      ctx.db.node.count({ where }),
      ctx.db.node.findMany({ where, orderBy: [{ loc: 'asc' }, { id: 'asc' }], ...page(args) }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items: await Promise.all(nodes.map((node) => summary(ctx, node))), total };
  },
};

export const recoveryFieldResolvers = {
  RecoveryNode: {
    /** Key-required only when raw content is actually selected, never return ciphertext as recovered content. */
    content: async (parent: { _retainedNode: Node }, _: unknown, ctx: Context) => {
      const node = { ...parent._retainedNode };
      if (node.nodeType === COMMENT_NODE_TYPE) throw nodeNotFoundError(node.id);
      if (!(await canRecoverMemory(withoutRequestCaches(ctx), node.memoryId))) throw nodeNotFoundError(node.id);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: node.memoryId }, select: { id: true, isEncrypted: true } });
      decryptNodeFields(node, memory);
      return node.content;
    },
  },
};

/** Typed concurrency refusal never names an address in a newly inaccessible corpus. */
function changed(): GraphQLError {
  return new GraphQLError('Node changed while recovery waited; read again and retry.', { extensions: { code: 'NODE_WRITE_CONFLICT' } });
}

export const recoveryMutations = {
  /** One retained ordinary node, restored under the same authority/address/row/rulebook protocol as supported writers. */
  restoreNode: async (_: unknown, args: { nodeRef: string }, ctx: Context) => {
    const candidate = await recoveryTarget(ctx, args.nodeRef);
    if (!candidate) throw nodeNotFoundError(args.nodeRef);
    const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: candidate.memoryId } });
    const anchors: AuthorityAnchor[] = [
      { kind: 'memory', id: memory.id }, { kind: 'user', id: ctx.userId! },
      ...(memory.organizationId ? [{ kind: 'org' as const, id: memory.organizationId }] : []),
      ...(memory.ownerUserId ? [{ kind: 'user' as const, id: memory.ownerUserId }] : []),
      ...(memory.userId ? [{ kind: 'user' as const, id: memory.userId }] : []),
      ...[...new Set([memory.appId, ctx.appId].filter((id): id is string => !!id))].map((id) => ({ kind: 'app' as const, id })),
    ];
    const result = await ctx.db.$transaction(async (tx) => {
      await lockInstallAuthorityFirst(tx, ctx, memory.id);
      await lockAuthorityAnchors(tx, anchors, 'shared');
      await lockMemoryForChannelChange(tx, memory.id);
      const ancestors = ancestorLocs(candidate.loc);
      await acquireLockSet(tx, [...ancestors, candidate.loc].map((loc) => ({ memoryId: memory.id, loc })));
      // Owner rows precede Memory, which precedes Node rows (promotion/update/merge order).
      if (memory.organizationId) await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${memory.organizationId} FOR SHARE`;
      for (const id of [...new Set([ctx.userId, memory.ownerUserId, memory.userId].filter((id): id is string => !!id))].sort()) {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR SHARE`;
      }
      for (const id of [...new Set([memory.appId, ctx.appId].filter((id): id is string => !!id))].sort()) {
        await tx.$queryRaw`SELECT id FROM apps WHERE id = ${id} FOR SHARE`;
      }
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR SHARE`;
      const txCtx = await liveTxContext(ctx, tx);
      const currentMemory = await tx.memory.findUnique({ where: { id: memory.id } });
      if (!currentMemory || !(await canRecoverMemory(txCtx, memory.id))) throw nodeNotFoundError(args.nodeRef);
      if (currentMemory.organizationId !== memory.organizationId || currentMemory.ownerUserId !== memory.ownerUserId ||
          currentMemory.userId !== memory.userId || currentMemory.isEncrypted !== memory.isEncrypted ||
          currentMemory.appId !== memory.appId || currentMemory.class !== memory.class ||
          currentMemory.userMemoryOfAgentId !== memory.userMemoryOfAgentId) throw changed();
      const related = await tx.node.findMany({ where: { memoryId: memory.id, OR: [{ id: candidate.id }, { loc: { in: ancestors } }] } });
      const threadMembers = await tx.commentMeta.findMany({ where: { targetNodeId: candidate.id, threadDeletedCause: 'TARGET' }, select: { nodeId: true } });
      const nodeIds = [...related.map((node) => node.id), ...threadMembers.map((member) => member.nodeId)];
      const locked = await lockRemovalRows(tx, memory.id, nodeIds);
      if (locked.length !== new Set(nodeIds).size) throw changed();
      // Comment metadata is written by the lifecycle helper too. Fence its complete
      // TARGET set before the final rulebook lock; the target row blocks new comments.
      const lockedMeta = await tx.$queryRaw<Array<{ node_id: string }>>`
        SELECT node_id FROM comment_meta WHERE target_node_id = ${candidate.id} AND thread_deleted_cause = 'TARGET'
        ORDER BY node_id FOR UPDATE`;
      const lockedNodeIds = new Set(locked.map((node) => node.id));
      if (lockedMeta.some((member) => !lockedNodeIds.has(member.node_id))) throw changed();
      const current = await tx.node.findUnique({ where: { id: candidate.id }, include: { outgoingEdges: { include: { target: true } } } });
      if (!current) throw nodeNotFoundError(args.nodeRef);
      if (current.memoryId !== memory.id || current.loc !== candidate.loc) throw changed();
      // The mutation returns content. Validate key custody before any visible state change, not after commit.
      decryptNodeFields({ ...current }, currentMemory);
      const parents = await tx.node.findMany({ where: { memoryId: memory.id, loc: { in: ancestors }, deletedAt: { not: null } }, select: { loc: true } });
      const deletedLocs = new Set(parents.map((parent) => parent.loc));
      const firstDeleted = ancestors.find((loc) => deletedLocs.has(loc));
      if (firstDeleted !== undefined) {
        const ancestorUrn = emitNodeUrnV2(currentMemory.urn, firstDeleted);
        throw new GraphQLError(`Restore the deleted ancestor ${ancestorUrn} first.`, { extensions: { code: 'NODE_PARENT_DELETED', ancestorUrn } });
      }
      await assertLocWritable(tx, memory.id, current.loc, 'restore');
      assertNotCommentWrite(current.nodeType, current.nodeType, 'restore');
      assertBootPromptWriteAllowed(current, current, 'restore');
      assertGovernedWrite(current, current, 'update', undefined, { context: 'node-restore' });
      // The final rulebook fence must follow every row and address lock.
      await assertRoleWritersForNodes(tx, txCtx, [current], { from: memory.id });
      if (!current.deletedAt) return { node: current, changed: false };
      const count = await tx.node.updateMany({ where: { id: current.id, memoryId: memory.id, loc: current.loc, deletedAt: current.deletedAt },
        data: { deletedAt: null, deletedBy: null } });
      if (count.count !== 1) throw changed();
      // Only threads deleted by this target's deletion return; independently
      // deleted ADMIN/AUTHOR/MANAGER threads retain their own deletion cause.
      await restoreThreadsOfTargets(tx, [current.id]);
      const node = await tx.node.findUniqueOrThrow({ where: { id: current.id }, include: { outgoingEdges: { include: { target: true } } } });
      return { node, changed: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }).catch((error: unknown) => {
      if (isDeadlockVictim(error)) throw changed();
      throw error;
    });
    if (result.changed) await publishNodeWritten({ nodeId: result.node.id, memoryId: memory.id, ownerRepo: result.node.ownerRepo ?? '', clientId: ctx.clientId });
    const out = { ...result.node };
    decryptNodeFields(out, memory);
    return out;
  },
};
