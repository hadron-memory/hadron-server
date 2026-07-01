// sessionQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  assertFullyQualifiedUrn,
  hasSchemePrefix,
} from '../../../lib/urn.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import {
  listInboxMessages,
  listFolders,
} from '../../../integrations/exchange/exchange.js';
import {
  type Context,
  requireRole,
  requireOrgRole,
  getAccessibleMemoryIds,
  sessionScopeFilter,
  SESSION_INCLUDE,
  getExchangeRefreshToken,
} from './resolvers.helpers.js';

export const sessionQueries = {
    sessions: async (
      _: unknown,
      { type, repo, customerId, limit, offset }: { type?: string; repo?: string; customerId?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      // ADMIN/OWNER see all; App-keyed callers see their own sessions;
      // users see sessions for any App in an org they belong to.
      const scopeFilter = await sessionScopeFilter(ctx);
      return ctx.db.session.findMany({
        where: {
          ...scopeFilter,
          ...(type ? { type: type as any } : {}),
          ...(repo ? { repo } : {}),
          ...(customerId ? { customerId } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
        include: SESSION_INCLUDE,
      });
    },

    session: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const session = await ctx.db.session.findUnique({ where: { id }, include: SESSION_INCLUDE });
      if (!session) return null;
      // ADMIN/OWNER can see any session
      if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return session;
      // App-keyed caller can see sessions belonging to their App
      if (ctx.appId && session.appId === ctx.appId) return session;
      // User can see sessions from Apps in any org they belong to
      if (ctx.userId && session.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: session.appId },
          select: { organizationId: true },
        });
        if (app) {
          const member = await ctx.db.orgMember.findUnique({
            where: {
              organizationId_userId: { organizationId: app.organizationId, userId: ctx.userId },
            },
          });
          if (member && !member.deletedAt) return session;
        }
      }
      return null;
    },

    usageEvents: async (
      _: unknown,
      {
        type,
        memoryId,
        nodeId,
        limit,
        offset,
      }: {
        type?: string;
        memoryId?: string;
        nodeId?: string;
        limit?: number;
        offset?: number;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Per-node scoping (issue #249 follow-up): a single node addressed by a
      // node *token* — PK, URN, or bare loc — no memoryId required. Mirrors the
      // memoryId pattern (resolveMemoryRef accepts ID or URN), generalized to a
      // node ref. Branches by token shape:
      //
      //   - PK, or any `urn:`-prefixed / fully-qualified node URN →
      //     resolveNodeRef → exact nodeId FK filter. Memory-precise: it can't
      //     collide with a same-loc node in another memory. Events whose nodeId
      //     is null (orphaned post node-deletion, or the older recordUsage
      //     path's ambiguous loc lookup) are excluded; a resolvable ref implies
      //     a live node. Routing every `urn:`-prefixed input through
      //     resolveNodeRef (rather than the loc fallback) keeps its wrong-type
      //     URN handling loud — `urn:memory:…` fails instead of silently
      //     degrading to a loc filter that returns [].
      //   - bare loc (unprefixed AND fails node-URN qualification — a node URN
      //     needs ≥3 segments) → exact nodeLoc match, like nodeUsage(loc).
      //     Cross-memory: UsageEvent has no memoryId, so this matches that loc
      //     in every memory; it does NOT validate node existence (a filter, not
      //     a lookup, so an unknown loc yields [] rather than NODE_NOT_FOUND).
      let nodeIdFilter: string | undefined;
      let nodeLocExact: string | undefined;
      if (nodeId) {
        // Scheme-prefixed inputs (`hrn:` / legacy `urn:`) are always node refs
        // (resolveNodeRef validates the type marker and throws on mismatch).
        // Unprefixed inputs are refs only if they have full node-URN shape;
        // otherwise they're a bare loc.
        let isNodeRef = isId(nodeId) || hasSchemePrefix(nodeId);
        if (!isNodeRef) {
          // assertFullyQualifiedUrn checks shape only (≥3 segments for 'node').
          try {
            assertFullyQualifiedUrn(nodeId, 'node');
            isNodeRef = true;
          } catch {
            isNodeRef = false;
          }
        }
        if (isNodeRef) {
          // 007/022-entity-id-or-urn: PK or fully-qualified node URN. No
          // contextMemoryId at the API boundary (spec 022).
          const { id: resolvedNodeId } = await resolveNodeRef(ctx.db, nodeId);
          nodeIdFilter = resolvedNodeId;
        } else {
          nodeLocExact = nodeId;
        }
      }

      // Access scoping (issue #250): restrict results to memories the caller
      // may read. getAccessibleMemoryIds is the canonical helper — it
      // encapsulates every principal type and the memory-class rules (spec
      // 034): a JWT / user-API-key caller gets their org + subscription +
      // public + owned personal/private set; ADMIN/OWNER get all memories
      // except other users' personal/private. App keys carry roles:[] and are
      // already rejected by requireRole above (App usage reads aren't a GraphQL
      // surface — they go through MCP).
      //
      // The return type is `string[] | null`, where null would mean
      // "unrestricted (no filter)". In practice every branch returns an
      // explicit list — ADMIN/OWNER included, so the personal/private carve-out
      // still applies — so the `!== null` guards below are defensive for that
      // type contract rather than a live code path today.
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);

      // Per-memory scoping (issue #249): filter on the UsageEvent→Node relation
      // by the resolved memory. FK-precise (no cross-memory nodeLoc collision)
      // and a single SQL query — unlike fetching every node loc and using
      // `nodeLoc: { in }`, which collides on shared locs and can blow the
      // IN-parameter limit on large memories. Like the nodeId path, it excludes
      // events with a null nodeId (orphaned / legacy). memoryUsageSummary uses
      // the same relation-scoping approach (aligned in #253).
      let memoryNodeFilter: { memoryId: string } | undefined;
      if (memoryId) {
        // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
        const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
        // #250: deny a memory the caller can't read. Return [] (not a thrown
        // Forbidden) to avoid leaking existence — mirrors nodeById returning
        // null for an out-of-scope target.
        if (accessibleMemoryIds !== null && !accessibleMemoryIds.includes(resolvedMemoryId)) {
          return [];
        }
        memoryNodeFilter = { memoryId: resolvedMemoryId };
      }

      // Resolve the UsageEvent→Node relation filter:
      //  - memoryId scoped path → the single, already access-checked memory.
      //  - otherwise → the caller's full accessible-memory set (#250). This
      //    bounds both the global feed and any bare-loc nodeId filter to
      //    readable memories. A `null` accessible set = unrestricted.
      const nodeRelationFilter: { memoryId: string } | { memoryId: { in: string[] } } | undefined =
        memoryNodeFilter ??
        (accessibleMemoryIds !== null ? { memoryId: { in: accessibleMemoryIds } } : undefined);

      return ctx.db.usageEvent.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(nodeIdFilter ? { nodeId: nodeIdFilter } : {}),
          ...(nodeRelationFilter ? { node: nodeRelationFilter } : {}),
          // nodeId-as-bare-loc → exact nodeLoc match (the supported loc filter
          // since the deprecated nodeLoc substring arg was removed in #252).
          ...(nodeLocExact ? { nodeLoc: nodeLocExact } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
      });
    },

    exchangeConnections: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.exchangeConnection.findMany({
        where: { organizationId: resolvedOrgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
    },

    exchangeMessages: async (
      _: unknown,
      { connectionId, top, filter }: { connectionId: string; top?: number; filter?: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listInboxMessages(refreshToken, { top: top ?? 25, filter: filter ?? undefined });
      return result.data.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress?.address ?? null,
        receivedDateTime: m.receivedDateTime,
        isRead: m.isRead,
        bodyPreview: m.bodyPreview,
        body: m.body?.content ?? null,
        hasAttachments: m.hasAttachments,
      }));
    },

    exchangeFolders: async (_: unknown, { connectionId }: { connectionId: string }, ctx: Context) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listFolders(refreshToken);
      return result.data;
    },
};

