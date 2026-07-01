// memoryQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import {
  type Context,
  requireRole,
  getAccessibleMemoryIds,
  MEMORY_INCLUDE,
} from './resolvers.helpers.js';

export const memoryQueries = {
    memoryUsageSummary: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);

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

    publicMemories: async (_: unknown, __: unknown, ctx: Context) => {
      return ctx.db.memory.findMany({
        where: { visibility: 'PUBLIC', deletedAt: null },
        orderBy: { name: 'asc' },
        include: MEMORY_INCLUDE,
      });
    },

    memory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUnique({
        where: { id },
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

    orgSystemMemories: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      // Authorization: platform ADMIN or member of the org
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.memory.findMany({
        where: {
          organizationId: resolvedOrgId,
          deletedAt: null,
          class: 'system',
          userMemoryOfAgentId: null,
        },
        include: MEMORY_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },

    myMemories: async (
      _: unknown,
      { includeAgentSystem }: { includeAgentSystem?: boolean },
      ctx: Context,
    ) => {
      // Agent system memories are hidden by default on listing pages. The
      // portal passes includeAgentSystem: true only when the user toggles
      // "Show system memories" at the top of /app/memories.
      const typeFilter = includeAgentSystem
        ? {}
        : { class: { not: 'system' as const } };

      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Surface
      // memoryItems for every installed Agent (the "primary" notion is
      // not load-bearing here — the resolver returns the union). Apps
      // with no installed Agents see zero memories.
      if (ctx.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: ctx.appId },
          select: {
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
        if (!app || app.appAgents.length === 0) return [];
        const memoryMap = new Map<string, any>();
        for (const aa of app.appAgents) {
          for (const item of aa.agent.memoryItems) {
            if (!includeAgentSystem && item.memory.class === 'system') continue;
            memoryMap.set(item.memory.id, item.memory);
          }
        }
        return Array.from(memoryMap.values());
      }
      // JWT/OAuth user — union of all org-accessible memories
      if (ctx.userId) {
        const memberships = await ctx.db.orgMember.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { organizationId: true },
        });
        const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
        if (orgIds.length === 0) return [];
        return ctx.db.memory.findMany({
          where: {
            deletedAt: null,
            ...typeFilter,
            // Also exclude per-user agent memories — they belong to the chatbot
            // flow, not the user's regular memory list.
            userMemoryOfAgentId: null,
            OR: [
              // Org-shared classes via membership; 034: owner-owned
              // personal/private never come in via the org.
              { organizationId: { in: orgIds }, class: { notIn: ['personal', 'private'] as any } },
              { class: { notIn: ['personal', 'private'] as any }, subscriptions: { some: { organizationId: { in: orgIds } } } },
              // 034: the user's own owner-owned personal/private memories.
              { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
            ],
          },
          include: MEMORY_INCLUDE,
          orderBy: { name: 'asc' },
        });
      }
      throw new Error('Unauthenticated');
    },

    // ── Exchange integration queries ────────────────────────────────────

};

