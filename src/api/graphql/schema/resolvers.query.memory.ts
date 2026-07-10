// memoryQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { deserializeTags } from '../../../integrations/db/provider.js';
import {
  type Context,
  requireRole,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
  MEMORY_INCLUDE,
} from './resolvers.helpers.js';

// Graph-view fetch (issue #466): default page size + hard cap for the slim
// memoryNodes / memoryEdges lists. Large enough to fill the graph in a few
// round trips, capped so a single page stays bounded.
const GRAPH_PAGE_DEFAULT = 1000;
const GRAPH_PAGE_MAX = 2000;

/**
 * Clamp a graph page size: omitted → the default; otherwise the caller's value
 * clamped to [0, MAX]. `limit: 0` is preserved (not bumped to 1) so a caller can
 * fetch only `total` — the cheap "how big is this memory?" node/edge count — or
 * suppress the payload during init, the standard limit-0 pattern.
 */
function clampGraphTake(limit?: number | null): number {
  if (limit == null) return GRAPH_PAGE_DEFAULT;
  return Math.min(GRAPH_PAGE_MAX, Math.max(0, limit));
}

/**
 * Resolve a memoryId (ID or URN) to its id IFF the caller may read it; returns
 * null when the ref does not resolve OR the caller lacks read access — so the
 * graph-view queries return an empty page with no org/memory existence
 * disclosure (same posture as memoryUsageSummary). Uses the scoped
 * getAccessibleMemoryIds point-read so it stays an indexed check.
 */
async function resolveReadableMemoryId(ctx: Context, memoryRef: string): Promise<string | null> {
  let resolvedId: string;
  try {
    ({ id: resolvedId } = await resolveMemoryRef(ctx.db, memoryRef));
  } catch (e) {
    // Only a genuine miss collapses to an empty page (no existence disclosure).
    // A malformed URN or an unexpected DB/runtime error must propagate rather
    // than masquerade as "empty graph" — mirrors the Query.memory(id:) resolver.
    if (e instanceof MemoryNotFoundError) return null;
    throw e;
  }
  const accessible = await getAccessibleMemoryIds(ctx, resolvedId);
  if (accessible !== null && !accessible.includes(resolvedId)) return null;
  return resolvedId;
}

export const memoryQueries = {
    memoryUsageSummary: async (_: unknown, { memoryRef }: { memoryRef: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // 007-entity-id-or-urn: memoryRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);

      // Access control (#250, extended from usageEvents): deny a memory the
      // caller can't read with [] (no existence leak), mirroring usageEvents
      // and nodeById. getAccessibleMemoryIds encodes principals + the memory-
      // class rules (spec 034). Previously this resolver had no gate at all —
      // any authenticated caller could read any tenant's per-node usage counts.
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      if (accessibleMemoryIds !== null && !accessibleMemoryIds.includes(resolvedMemoryId)) {
        return [];
      }

      // #253: scope via the UsageEvent→Node relation, not `nodeLoc: { in: locs }`.
      // FK-precise (no cross-memory loc collision — a node named `alpha` in
      // another memory no longer inflates this memory's counts), a single query,
      // and no IN-parameter limit on large memories. Like usageEvents post-#251
      // this excludes events with a null nodeId (orphaned after node deletion,
      // or the older recordUsage path's ambiguous loc lookup) — arguably more
      // correct, since an unattributable event shouldn't count toward a memory.
      //
      // `nodeLoc: { not: null }` restores a guarantee the old loc-IN scoping had
      // implicitly: the result feeds UsageSummaryEntry.nodeLoc (String!), so a
      // null-nodeLoc group (an event with nodeId set but nodeLoc null) would
      // violate the schema at the GraphQL layer. The IN-filter could never
      // produce one; the relation filter can, so exclude it explicitly.
      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { node: { memoryId: resolvedMemoryId }, nodeLoc: { not: null } },
        _count: { id: true },
      });
      return rows.map((r: { nodeLoc: string | null; type: string; _count: { id: number } }) => ({
        // nodeLoc is non-null here (guarded in the where above); Prisma's
        // groupBy result type still widens it to string | null.
        nodeLoc: r.nodeLoc as string,
        type: r.type,
        count: r._count.id,
      }));
    },

    memory: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // 007-entity-id-or-urn: ref may be an ID or a URN. A raw ID needs no
      // resolution (skip the extra lookup); a URN is resolved to its id. Only a
      // genuine miss (MemoryNotFoundError) collapses to null — malformed URNs
      // and unexpected DB/runtime errors propagate rather than masking as a
      // misleading not-found (mirrors the effectiveAccess resolver).
      let resolvedId = ref;
      if (!isId(ref)) {
        try {
          ({ id: resolvedId } = await resolveMemoryRef(ctx.db, ref));
        } catch (e) {
          if (!(e instanceof MemoryNotFoundError)) throw e;
          return null;
        }
      }
      const memory = await ctx.db.memory.findUnique({
        where: { id: resolvedId },
        include: MEMORY_INCLUDE,
      });
      if (!memory || memory.deletedAt) return null;
      // 034-memory-class-access: owner-owned personal/private are owner-only —
      // no ADMIN/OWNER bypass, no org-member path. Check before the org logic.
      if (memory.class === 'personal' || memory.class === 'private') {
        if (!ctx.userId || memory.userId !== ctx.userId) throw new Error('Forbidden');
        return memory;
      }
      // Authorization: platform ADMIN/OWNER, a member of the memory's org, OR
      // any caller the shared read gate already admits — PUBLIC visibility,
      // a cross-org subscription, or an App session scoped to this memory.
      // The node queries (nodeById/nodes) authorize through that same set via
      // memoryAccessFilter → getAccessibleMemoryIds, so without the fallback a
      // public-visibility reader could read the memory's NODES but not the
      // memory record itself; the portal's uncaught MEMORY_BY_ID_QUERY then
      // turned that Forbidden into an HTTP 500 (issue #362). The org-member
      // fast-path is kept because getAccessibleMemoryIds (via
      // getOrgReadableMemoryIds) intentionally omits app/system-class org
      // memories, which members can still open here as they do today.
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        // findFirst (not findUnique) so a REVOKED (soft-deleted) membership no
        // longer grants access — matches getOrgReadableMemoryIds' own
        // `deletedAt: null` membership filter.
        const member = ctx.userId
          ? await ctx.db.orgMember.findFirst({
              where: {
                organizationId: memory.organizationId,
                userId: ctx.userId,
                deletedAt: null,
              },
            })
          : null;
        if (!member) {
          // Scope the shared gate to THIS memory so it's an indexed point-read,
          // not an enumeration of the whole accessible set.
          const accessibleIds = await getAccessibleMemoryIds(ctx, memory.id);
          if (accessibleIds !== null && !accessibleIds.includes(memory.id)) {
            throw new Error('Forbidden');
          }
        }
      }
      return memory;
    },

    // #473 — the uniform paginated memory list. Replaces myMemories (the
    // caller's union), publicMemories (filter.visibility: PUBLIC), and
    // orgSystemMemories (orgId + filter.memoryClasses: [system]).
    memories: async (
      _: unknown,
      {
        filter,
        orgId,
        limit,
        offset,
      }: {
        filter?: { memoryClasses?: string[] | null; visibility?: string | null } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const empty = { items: [], total: 0 };
      const f = filter ?? {};
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);

      // Class filter (mirrors findNodes NodeFilter.memoryClasses): when given,
      // restrict to exactly the listed classes; when omitted, hide the noisy
      // agent `system` class by default (the portal's list page relies on it).
      const classSet =
        f.memoryClasses && f.memoryClasses.length > 0 ? new Set(f.memoryClasses) : null;
      const classFilter = classSet
        ? { class: { in: [...classSet] as any } }
        : { class: { not: 'system' as const } };

      // #463 / cor:api:100:01 — optional single-org narrowing ("active
      // organization"): member -> scope, non-member/unresolvable -> empty
      // page with no org-existence disclosure, no platform-admin bypass.
      const scope = await resolveOrgScope(ctx, orgId);
      if (!scope) return empty;

      const page = async (where: Record<string, unknown>) => {
        const [total, items] = await Promise.all([
          ctx.db.memory.count({ where }),
          take === 0
            ? Promise.resolve([])
            : ctx.db.memory.findMany({
                where,
                include: MEMORY_INCLUDE,
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip,
                take,
              }),
        ]);
        return { items, total };
      };

      // filter.visibility: PUBLIC — the marketplace slice (the old
      // publicMemories): every PUBLIC memory, readable by any caller, so the
      // scope selection never widens access. Still class-filtered and
      // org-narrowable like the default slice.
      if (f.visibility === 'PUBLIC') {
        return page({
          visibility: 'PUBLIC',
          deletedAt: null,
          userMemoryOfAgentId: null,
          ...classFilter,
          ...(scope.scopedOrgId ? { organizationId: scope.scopedOrgId } : {}),
        });
      }

      // 023-app-shape Phase 2b: App-key callers get the union of their
      // installed Agents' memoryItems (App↔Agent is N:M via AppAgent). The
      // union is assembled in memory — App memory sets are small — then
      // class-filtered, sorted, and page-sliced with an exact total.
      if (ctx.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: ctx.appId },
          select: {
            organizationId: true,
            appAgents: {
              select: {
                agent: {
                  include: {
                    memoryItems: { include: { memory: { include: MEMORY_INCLUDE } } },
                  },
                },
              },
            },
          },
        });
        if (!app || app.appAgents.length === 0) return empty;
        const memoryMap = new Map<string, any>();
        for (const aa of app.appAgents) {
          for (const item of aa.agent.memoryItems) {
            if (classSet ? !classSet.has(item.memory.class) : item.memory.class === 'system') continue;
            if (f.visibility && item.memory.visibility !== f.visibility) continue;
            memoryMap.set(item.memory.id, item.memory);
          }
        }
        const all = Array.from(memoryMap.values()).sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        );
        return { items: take === 0 ? [] : all.slice(skip, skip + take), total: all.length };
      }

      // JWT/OAuth user — the caller's union:
      //   (1) their OWN owner-owned personal/private memories — ALWAYS,
      //       independent of the active org (they're user-owned, not part of
      //       any org's collection; selecting an active org must not hide
      //       your own notes),
      //   (2) memories their member orgs OWN,
      //   (3) memories their member orgs SUBSCRIBE to.
      // Per-user agent memories (userMemoryOfAgentId) are excluded — they
      // belong to the chatbot flow, not the regular memory list. 034:
      // owner-owned personal/private never come in via the org.
      if (ctx.userId) {
        // A caller with zero memberships still gets their own personal/private
        // memories: `in: []` in the org clauses simply matches nothing.
        const orgIds = scope.memberOrgIds;
        return page({
          deletedAt: null,
          ...(f.visibility ? { visibility: f.visibility as any } : {}),
          userMemoryOfAgentId: null,
          AND: [classFilter],
          OR: [
            { organizationId: { in: orgIds }, class: { notIn: ['personal', 'private'] as any } },
            { class: { notIn: ['personal', 'private'] as any }, subscriptions: { some: { organizationId: { in: orgIds } } } },
            { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
          ],
        });
      }
      throw new Error('Unauthenticated');
    },

    // #466: slim, paginated node list for the graph view. Phase one — the
    // client loads these to completion, renders nodes, then loads memoryEdges.
    // Returns only what a node-link graph draws (no content/abstract/data), so
    // the payload is a fraction of the full node fragment.
    memoryNodes: async (
      _: unknown,
      { memoryRef, limit, offset }: { memoryRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const resolvedId = await resolveReadableMemoryId(ctx, memoryRef);
      if (!resolvedId) return { nodes: [], total: 0 };

      const take = clampGraphTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const where = { memoryId: resolvedId, deletedAt: null };
      const [total, rows] = await Promise.all([
        ctx.db.node.count({ where }),
        ctx.db.node.findMany({
          where,
          orderBy: { loc: 'asc' }, // loc is unique per memory → stable paging
          skip,
          take,
          // #513: seq / isRunnable / description are small scalars the portal's
          // tree + graph render (sibling order, action dot, tooltip). Kept in
          // the slim projection — the heavy body (content/abstract/data) stays out.
          select: {
            id: true,
            loc: true,
            name: true,
            nodeType: true,
            tags: true,
            seq: true,
            isRunnable: true,
            description: true,
          },
        }),
      ]);
      return {
        total,
        // GraphNode is a distinct slim type (not Node), so it has no Node.tags
        // field resolver — deserialize the stored tags here. name/nodeType/tags
        // are NOT NULL columns (nodeType defaults to 'info'), so they're typed
        // non-null here to match GraphNode's String! / [String!]! — no null path.
        // seq/isRunnable/description are nullable columns → passed through as-is
        // (GraphQL Int / Boolean / String, all nullable).
        nodes: rows.map(
          (r: {
            id: string;
            loc: string;
            name: string;
            nodeType: string;
            tags: string[] | string;
            seq: number | null;
            isRunnable: boolean | null;
            description: string | null;
          }) => ({
            id: r.id,
            loc: r.loc,
            name: r.name,
            nodeType: r.nodeType,
            tags: deserializeTags(r.tags),
            seq: r.seq,
            isRunnable: r.isRunnable,
            description: r.description,
          }),
        ),
      };
    },

    // #466: slim, paginated edge list for the graph view. Phase two — endpoint
    // IDs only; the client already holds the nodes by the time it draws edges.
    // Scoped by the edge's denormalized memoryId (edges whose SOURCE is in the
    // memory); a cross-memory edge's target may fall outside this memory and is
    // dropped client-side as a dangling endpoint.
    memoryEdges: async (
      _: unknown,
      { memoryRef, limit, offset }: { memoryRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const resolvedId = await resolveReadableMemoryId(ctx, memoryRef);
      if (!resolvedId) return { edges: [], total: 0 };

      const take = clampGraphTake(limit);
      const skip = Math.max(0, offset ?? 0);
      // Only edges whose BOTH endpoints are live nodes. deleteNode soft-deletes
      // just the node row and leaves its edges live (only `hard` cascades), so
      // an edge to/from a soft-deleted node would otherwise dangle — memoryNodes
      // omits deleted nodes, so the client would draw a link to a node not in
      // the set. Filtering the endpoints here (not edge.deletedAt alone) keeps
      // the graph consistent and total accurate, without changing delete
      // semantics. (A cross-memory edge's target may still fall outside this
      // memory's node page — that legitimate dangling is dropped client-side.)
      const where = {
        memoryId: resolvedId,
        deletedAt: null,
        source: { deletedAt: null },
        target: { deletedAt: null },
      };
      const [total, edges] = await Promise.all([
        ctx.db.edge.count({ where }),
        ctx.db.edge.findMany({
          where,
          orderBy: { loc: 'asc' }, // edge loc is unique per memory → stable paging
          skip,
          take,
          select: { id: true, loc: true, name: true, sourceId: true, targetId: true },
        }),
      ]);
      return { total, edges };
    },
};

