/**
 * #1610 — read side of node agent attribution: the Worker / Agent behind a
 * node's creation, its last authored edit, and each revision's edit.
 *
 * Resolved to PUBLIC identifiers only (`ActorRef { id, name, urn }`), like the
 * revision editor (cor:dmo:060:04). A field never hands out the `Worker` or
 * `Agent` object itself: their field resolvers assume their own read gate ran,
 * and widening a node read into another tenant's nested object is the #552
 * class. Reaching the node already passed its memory's read gate; naming who
 * wrote it is the point of the field.
 */
import type { Context } from './resolvers.helpers.js';
import { safeCanonicalUrn } from './resolvers.helpers.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { normalizeUrnForLookup } from '../../../lib/urn.js';
import { resolveRevisionEditor } from './resolvers.types.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';

export type ActorRef = { id: string; name: string; urn: string | null };

type ActorKind = 'worker' | 'agent';
const actorCaches = new WeakMap<Context, Map<string, Promise<ActorRef | null>>>();

/** One lookup per actor per request: a list page names few distinct actors. */
export function loadActorRef(ctx: Context, kind: ActorKind, id: string): Promise<ActorRef | null> {
  let cache = actorCaches.get(ctx);
  if (!cache) {
    cache = new Map();
    actorCaches.set(ctx, cache);
  }
  const key = `${kind}:${id}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = kind === 'worker' ? loadWorkerRef(ctx, id) : loadAgentRef(ctx, id);
    cache.set(key, pending);
  }
  return pending;
}

async function loadWorkerRef(ctx: Context, id: string): Promise<ActorRef | null> {
  const worker = await ctx.db.worker.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, app: { select: { urn: true } } },
  });
  if (!worker) return null;
  let urn: string | null = null;
  try {
    urn = composeWorkerUrn(normalizeUrnForLookup(worker.app.urn), worker.slug);
  } catch {
    urn = null;
  }
  return { id: worker.id, name: worker.name, urn };
}

async function loadAgentRef(ctx: Context, id: string): Promise<ActorRef | null> {
  // A soft-deleted agent still names who wrote the node: history must keep
  // resolving, as the revision editor does for a deleted user's handle.
  const agent = await ctx.db.agent.findUnique({ where: { id }, select: { id: true, name: true, urn: true } });
  return agent ? { id: agent.id, name: agent.name, urn: safeCanonicalUrn('agent', agent.urn) } : null;
}

type AttributionColumn =
  | 'createdByWorkerId' | 'createdByAgentId' | 'updatedByWorkerId' | 'updatedByAgentId' | 'updatedByUserId' | 'createdBy';

/**
 * The parent's own column, or — for a parent selected without it — one read
 * of the LIVE row pinned to the memory the parent was gated in (the post-gate
 * re-read rule, `findings:post-gate-reread-pinned-to-gated-memory-and-live-row`).
 * A slim parent that doesn't carry its memory fails closed: no attribution
 * rather than an unpinned read (#1658 review).
 */
async function nodeColumn(
  n: { id: string; memoryId?: string } & Partial<Record<AttributionColumn, string | null>>,
  column: AttributionColumn,
  ctx: Context,
): Promise<string | null> {
  if (n[column] !== undefined) return n[column] ?? null;
  if (!n.memoryId) return null;
  const row = await ctx.db.node.findFirst({
    where: { id: n.id, memoryId: n.memoryId, deletedAt: null },
    select: { [column]: true } as Record<AttributionColumn, true>,
  });
  return (row as Record<string, string | null> | null)?.[column] ?? null;
}

const nodeActor = (column: AttributionColumn, kind: ActorKind) =>
  async (n: { id: string; memoryId?: string }, _: unknown, ctx: Context) => {
    const id = await nodeColumn(n, column, ctx);
    return id ? loadActorRef(ctx, kind, id) : null;
  };

const revisionActor = (column: 'editedByWorkerId' | 'editedByAgentId', kind: ActorKind) =>
  (r: Partial<Record<'editedByWorkerId' | 'editedByAgentId', string | null>>, _: unknown, ctx: Context) => {
    const id = r[column];
    return id ? loadActorRef(ctx, kind, id) : null;
  };

/** The ONE user projection (handle + URN, never a raw id) shared by Node and Edge attribution (#1151). */
function userProjection(ctx: Context, raw: string | null | undefined) {
  return raw ? resolveRevisionEditor(ctx, [raw]) : null;
}

type EdgeAuthorParent = { id: string; memoryId?: string; createdBy?: string | null; updatedBy?: string | null };

async function edgeUser(e: EdgeAuthorParent, column: 'createdBy' | 'updatedBy', ctx: Context) {
  // A parent selected without its memory fails closed (no attribution rather than an unpinned read, #1658 rule).
  if (!e.memoryId || e[column] === undefined) return null;
  if (!(await isMemoryReadableCached(ctx, e.memoryId))) return null;
  return userProjection(ctx, e[column]);
}

export const nodeAttributionFieldResolvers = {
  Node: {
    createdByWorker: nodeActor('createdByWorkerId', 'worker'),
    createdByAgent: nodeActor('createdByAgentId', 'agent'),
    updatedByWorker: nodeActor('updatedByWorkerId', 'worker'),
    updatedByAgent: nodeActor('updatedByAgentId', 'agent'),
    // #2176 — public identifiers only (handle + urn), the projection a revision's editor already has.
    // One lookup per distinct user per request (the editor cache memoizes misses too).
    updatedByUser: async (n: { id: string; memoryId?: string }, _: unknown, ctx: Context) => {
      const id = await nodeColumn(n, 'updatedByUserId', ctx);
      return id ? resolveRevisionEditor(ctx, [id]) : null;
    },
    // #1151 — the user behind the create: the `createdBy` column is `userId ?? clientId`, and a clientId is not a
    // user PK, so it resolves to null here (never echoed). Same projection and helper as updatedByUser.
    createdByUser: async (n: { id: string; memoryId?: string }, _: unknown, ctx: Context) =>
      userProjection(ctx, await nodeColumn(n, 'createdBy', ctx)),
  },
  Edge: {
    // #1151 — an Edge reached through a cross-memory endpoint carries the outer query's gate for ANOTHER memory
    // (`Edge.memoryId` is its source side). Name an author only to a caller who may read the memory the row lives in.
    createdByUser: (e: EdgeAuthorParent, _: unknown, ctx: Context) => edgeUser(e, 'createdBy', ctx),
    updatedByUser: (e: EdgeAuthorParent, _: unknown, ctx: Context) => edgeUser(e, 'updatedBy', ctx),
  },
  NodeRevision: {
    editedByWorker: revisionActor('editedByWorkerId', 'worker'),
    editedByAgent: revisionActor('editedByAgentId', 'agent'),
  },
};
