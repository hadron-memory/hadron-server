// sessionQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  assertFullyQualifiedUrn,
  hasSchemePrefix,
} from '../../../lib/urn.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { isAppKeyPrincipal, projectUsageRowsFor } from './resolvers.usageProjection.js';
import { isAppKeyManager } from './appKeyManagement.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { GraphQLError } from 'graphql';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { requirePersonAsThemselves } from '../../../lib/auth/personAsThemselves.js';
import { oauthSurfaceRefusal } from '../../../middleware/auth.js';
import { CONNECTION_FLOW_TTL_MS } from '../../../integrations/mailboxConnect.js';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/index.js';
import {
  type ToolCalendarEvent,
  type ToolCalendarInfo,
  type ToolDriveExport,
  type ToolDriveFile,
  type ToolEmailFolder,
  type ToolEmailMessage,
  type ToolScheduleFreeBusy,
} from '../../../lib/emailClient.js';
import {
  type Context,
  requireRole,
  listOrgExchangeConnections,
  orgExchangeConnectionScope,
  pageArgs,
  pageEnvelope,
  getAccessibleMemoryIds,
  sessionScopeFilter,
  SESSION_INCLUDE,
  mapToolCalendarEvent,
  mapToolDriveFile,
  runOwnedEmailOperation,
} from './resolvers.helpers.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';

/**
 * The `where` shared by `sessions` and `sessionsPage` (#2212 A1): one audience, one filter set.
 * `null` is the empty answer (a blank or unresolvable `workerRef` narrows to nothing, never widens).
 */
async function sessionsWhere(
  ctx: Context,
  { type, repo, customerId, workerRef }: { type?: string; repo?: string; customerId?: string; workerRef?: string | null },
): Promise<Prisma.SessionWhereInput | null> {
      // Ordinary session audience intersected with bound-memory strict ownership.
      const scopeFilter = await sessionScopeFilter(ctx);
      // #974 / cor:agt:020:03: the "taken right now" / "last driven by" reads —
      // a worker's sessions, newest first, inside the caller's ordinary session
      // scope. #991 widened the ref to a Worker id OR an
      // hrn:worker:<root>:<app-slug>:<worker-slug> URN.
      //
      // This stays a FILTER, not a lookup: an unresolvable ref narrows to
      // nothing rather than throwing, so it cannot be used to probe which
      // workers exist outside the caller's scope. `scopeFilter` — not the ref —
      // is what authorizes the rows either way.
      //
      // An OMITTED filter and a SUPPLIED-BUT-BLANK one are different requests:
      // omitting it means "don't filter by worker", while `workerRef: "   "` is
      // a filter that nothing satisfies. Collapsing the two would let a blank
      // ref silently WIDEN the result to every session in scope — the opposite
      // of what the caller asked for, and a regression against the pre-#991
      // behaviour (which filtered on an empty id and matched nothing).
      let workerId: string | undefined;
      if (workerRef !== undefined && workerRef !== null) {
        const trimmedWorkerRef = workerRef.trim();
        if (trimmedWorkerRef === '') return null;
        try {
          ({ id: workerId } = await resolveWorkerRef(ctx.db, trimmedWorkerRef));
        } catch {
          return null;
        }
      }
      return {
          ...scopeFilter,
          ...(type ? { type: type as any } : {}),
          ...(repo ? { repo } : {}),
          ...(customerId ? { customerId } : {}),
          ...(workerId ? { workerId } : {}),
      };
}

// Like task-list bounds (#2692), usage windows require unambiguous instants.
const usageWindowInstant = z.string().datetime({ offset: true });

/**
 * The `where` shared by `usageEvents` and `usageEventsPage` (#2212 A1): the principal gate, the loc/nodeId
 * addressing rules and the scope, all resolved before any query.
 *
 * #2817 — the two scopes of hrn:node:hadronmemory.com:specs:cor:acl:090:01 (ruling 0244 items 1 and 2):
 *   - no resource named (no `memoryId`, `nodeId` or `loc`) → OWN ACTIVITY: the events attributed to the
 *     calling user (`UsageEvent.userId`), in any memory or none. A principal with no user identity (an App
 *     key, a userless run) has no own activity and gets an empty result, not an error.
 *   - a resource named → RESOURCE SCOPE: every principal's events there, bounded by the memory READ gate
 *     (`getAccessibleMemoryIds`, which handles App-key principals). An empty resource scope stays empty;
 *     it never falls back to own activity.
 */
/**
 * #2944 (hrn:node:hadronmemory.com:specs:cor:acl:090:01 rev 7, "Filtering by App key"; rulings 0244 item 4, 0245):
 * who may filter usage by App key K. K itself (`self`), and whoever manages K's App (cor:dmo:050:12) through the
 * one person-only manager predicate the key inventory uses. Anyone else, including a non-owner App member, another
 * key of the same App, a bound worker session and another tenant, gets EXACTLY the answer a nonexistent key gets:
 * APP_KEY_NOT_FOUND naming the caller's own reference (the resolvers.appKeyScope.ts shape). A revoked key is still
 * a key: its history stays filterable.
 */
async function admitUsageKeyFilter(ctx: Context, ref: string): Promise<{ id: string; self: boolean }> {
  const unknownKey = () => new GraphQLError('App key not found.', { extensions: { code: 'APP_KEY_NOT_FOUND', id: ref } });
  const key = await ctx.db.appKey.findUnique({
    where: { id: ref },
    select: { id: true, app: { select: { id: true, organizationId: true, ownerUserId: true } } },
  });
  if (!key) throw unknownKey();
  // An App key may filter by itself only; its App's other keys are not its own.
  if (isAppKeyPrincipal(ctx)) {
    if (ctx.appKeyId === key.id) return { id: key.id, self: true };
    throw unknownKey();
  }
  if (!(await isAppKeyManager(ctx, key.app))) throw unknownKey();
  return { id: key.id, self: false };
}

async function usageEventsWhere(
  ctx: Context,
  { type, memoryId, nodeId, loc, since, until, appKey }: {
    type?: string; memoryId?: string; nodeId?: string; loc?: string;
    since?: string | null; until?: string | null; appKey?: string | null;
  },
): Promise<Prisma.UsageEventWhereInput> {
      // #2817: an hdr_app_ key (roles [], no user identity) is admitted; its read is scoped below.
      // Every other principal keeps the READER gate unchanged, so an impersonation session (roles []),
      // an unauthenticated caller and any App context that is not a key are still refused.
      if (!isAppKeyPrincipal(ctx)) requireRole(ctx, 'READER');
      // #2784: a half-open activity window narrows the existing scope. Reject
      // its order before resolving any resource, so the error reveals no access.
      if ((since != null && !usageWindowInstant.safeParse(since).success) ||
          (until != null && !usageWindowInstant.safeParse(until).success)) {
        throw new GraphQLError('since and until must be ISO date-times with Z or an explicit offset', { extensions: { code: 'BAD_USER_INPUT' } });
      }
      const start = since == null ? undefined : new Date(since);
      const end = until == null ? undefined : new Date(until);
      if (start && end && start >= end) {
        throw new GraphQLError('since must be earlier than until', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // `loc` and `nodeId` are two different addressing modes for the same
      // filter slot — a verbatim loc filter vs a shape-classified node token.
      // Passing both is a contradiction we refuse rather than pick a winner.
      if (loc !== undefined && nodeId !== undefined) {
        throw new GraphQLError('Provide either nodeId or loc, not both', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      const windowFilter = start || end ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {};

      // #2944: the key is judged after the input checks and BEFORE any resource is resolved, so a refused key
      // answers as an unknown one whatever memory or node is also named, and never reveals one.
      const keyFilter = appKey != null ? await admitUsageKeyFilter(ctx, appKey) : null;
      const keyWhere = keyFilter ? { appKeyId: keyFilter.id } : {};

      // #2817 (cor:acl:090:01): naming no resource selects OWN ACTIVITY, never the accessible-memories
      // feed. "Named" uses the same truthiness that applies each filter below, so no request can reach
      // the resource branch without a resource filter. `type` and the window narrow either scope.
      // #2944: a key filter is the one exception. K reading itself gets its own events in the memories it can read
      // plus those attributed to none (ruling 0245 item 3, bounded by item 4 per ruling 0254); a manager falls through to the resource path below with no resource named, which bounds K's
      // events to every memory the manager can read (items 1 and 4) and never restores the broad feed, since
      // only a key-filtered read reaches it.
      if (!memoryId && !nodeId && !loc && keyFilter?.self) {
        // Ruling 0254 (hrn:node:hadronmemory.com:hadron-dev-team-shared:rulings:0254, Holger 2026-11-08, "Hide them"):
        // K's own events only in memories K can read NOW; an event in a memory K has lost is not returned (0245
        // item 4 governs where it meets item 3). Events attributed to no memory reveal none, so 0245 item 3 still
        // returns them (Vera's reading, recorded in 0254).
        const readable = await getAccessibleMemoryIds(ctx);
        return {
          ...windowFilter,
          ...(type ? { type } : {}),
          ...keyWhere,
          OR: [{ memoryId: { in: readable } }, { memoryId: null }],
        };
      }
      if (!memoryId && !nodeId && !loc && !keyFilter) {
        return {
          ...windowFilter,
          ...(type ? { type } : {}),
          // No user identity, no own activity: an empty result (matches no row), not an error.
          ...(ctx.userId ? { userId: ctx.userId } : { id: { in: [] } }),
        };
      }

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
      //     Cross-memory: the loc alone names no memory, so this matches that
      //     loc in EVERY readable memory (the memory scoping below still
      //     applies); it does NOT validate node existence (a filter, not a
      //     lookup, so an unknown loc yields [] rather than NODE_NOT_FOUND).
      //
      // The shape classification means nodeId CANNOT express a loc filter for
      // a hierarchical loc: `cor:acl:010:01` has ≥3 segments, so it qualifies
      // as node-URN shape and routes to resolveNodeRef — which throws
      // NODE_NOT_FOUND unless an org literally named by its first segment
      // exists (PR-986 review, Codex P2). The explicit `loc` argument below is
      // the unambiguous loc-filter path — and the nodeUsage migration target.
      let nodeIdFilter: string | undefined;
      let nodeMemoryId: string | undefined;
      let nodeLocExact: string | undefined;
      if (loc) {
        // Verbatim — never shape-sniffed, so every loc works, including ones
        // that happen to look like a URN. Exactly nodeUsage(loc:)'s semantics.
        nodeLocExact = loc;
      }
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
          const { id: resolvedNodeId } = await resolveNodeRefForCaller(ctx, nodeId);
          nodeIdFilter = resolvedNodeId;
          // The exact node names its memory, so that memory is a READ target like a named memoryId (Dorian P2-2).
          nodeMemoryId = (await ctx.db.node.findUnique({ where: { id: resolvedNodeId }, select: { memoryId: true } }))?.memoryId;
        } else {
          nodeLocExact = nodeId;
        }
      }

      // Access scoping (issue #250): restrict results to memories the caller
      // may read. getAccessibleMemoryIds is the canonical helper — it
      // encapsulates every principal type and the memory-class rules (spec
      // 034): a JWT / user-API-key caller gets their org + subscription +
      // public + owned personal/private set; ADMIN/OWNER get all memories
      // except other users' personal/private. An App key (#2817) gets the
      // memories its App may read — the same READ gate as the memory's content.
      //
      // The gate always returns an explicit list (#3921) — ADMIN/OWNER included, so the personal/private
      // carve-out still applies — never an "unrestricted" null.
      // A named memory is checked against that one target (the scoped form of the same predicates), so a
      // gate that admits only a NAMED memory, such as an App key's PUBLIC knowledge read (#3306), applies.
      const resolvedMemoryId = memoryId ? (await resolveMemoryRef(ctx.db, memoryId)).id : undefined;
      let accessibleMemoryIds = await getAccessibleMemoryIds(ctx, resolvedMemoryId);
      // An exact node (no memoryId) adds its own memory through the same scoped check, so a gate that admits only a
      // NAMED memory (an App key's PUBLIC knowledge read) applies to the node's memory too. The scoped check answers
      // [] for an unreadable memory, so this never widens past the memory's READ gate, and the nodeId filter below
      // still bounds the rows to that one node.
      if (!resolvedMemoryId && nodeMemoryId && !accessibleMemoryIds.includes(nodeMemoryId)) {
        const nodeTarget = await getAccessibleMemoryIds(ctx, nodeMemoryId);
        accessibleMemoryIds = [...accessibleMemoryIds, ...nodeTarget];
      }

      // Per-memory scoping (issue #249, moved onto the column in #796): filter
      // on `UsageEvent.memoryId` directly. This was a UsageEvent→Node relation
      // join, which was FK-precise (no cross-memory nodeLoc collision) but
      // dropped every event whose node had since been deleted — `nodeId` is
      // SetNull, so a memory silently lost that history. The column keeps the
      // precision and survives deletion. memoryUsageSummary moved in lockstep.
      let memoryScopeId: string | undefined;
      if (memoryId && resolvedMemoryId) {
        // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN (resolved above).
        // #250 denied an unreadable memory with [] to avoid leaking existence,
        // but a MISSING memory throws above, so [] itself meant "exists, not
        // yours". #1381 (`cor:api:140:03`): answer exactly as resolveMemoryRef's
        // miss instead.
        if (!accessibleMemoryIds.includes(resolvedMemoryId)) {
          throw new MemoryNotFoundError(memoryId);
        }
        memoryScopeId = resolvedMemoryId;
      }

      // Resolve the memory filter:
      //  - memoryId scoped path → the single, already access-checked memory.
      //  - otherwise (a nodeId or loc was named) → the caller's full
      //    accessible-memory set (#250), bounding any bare-loc filter to
      //    readable memories. The accessible set is always a list (#3921).
      //
      // Either way an event with a NULL memoryId is excluded, exactly as the
      // relation filter excluded an event with a null nodeId — `IN` never
      // matches NULL — so this widens results only to events already
      // attributed to a memory the caller can read.
      const memoryFilter: { memoryId: string } | { memoryId: { in: string[] } } =
        memoryScopeId !== undefined
          ? { memoryId: memoryScopeId }
          : { memoryId: { in: accessibleMemoryIds } };

  return {
          ...windowFilter,
          ...(type ? { type } : {}),
          ...keyWhere,
          ...(nodeIdFilter ? { nodeId: nodeIdFilter } : {}),
          ...memoryFilter,
          // nodeId-as-bare-loc → exact nodeLoc match (the supported loc filter
          // since the deprecated nodeLoc substring arg was removed in #252).
          ...(nodeLocExact ? { nodeLoc: nodeLocExact } : {}),
  };
}

export const sessionQueries = {
    sessions: async (
      _: unknown,
      { type, repo, customerId, workerRef, limit, offset }: { type?: string; repo?: string; customerId?: string; workerRef?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const where = await sessionsWhere(ctx, { type, repo, customerId, workerRef });
      if (!where) return [];
      return ctx.db.session.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        take: limit ?? 20,
        skip: offset ?? 0,
        include: SESSION_INCLUDE,
      });
    },

    /** #2212 A1 — `sessions` as a page: the same audience and filters (one shared `where`), a stable `id` tiebreak, the real total. */
    sessionsPage: async (
      _: unknown,
      args: { type?: string; repo?: string; customerId?: string; workerRef?: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const where = await sessionsWhere(ctx, args);
      const { take, skip } = pageArgs(args);
      if (!where) return pageEnvelope([], 0, skip);
      const [total, items] = await ctx.db.$transaction([
        ctx.db.session.count({ where }),
        ctx.db.session.findMany({ where, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take, skip, include: SESSION_INCLUDE }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return pageEnvelope(items, total, skip);
    },

    session: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // One predicate for point/list reads; denied and missing are both null.
      return ctx.db.session.findFirst({
        where: { AND: [{ id }, await sessionScopeFilter(ctx)] },
        include: SESSION_INCLUDE,
      });
    },

    usageEvents: async (
      _: unknown,
      args: { type?: string; memoryId?: string; nodeId?: string; loc?: string; since?: string | null; until?: string | null; appKey?: string | null; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const where = await usageEventsWhere(ctx, args);
      // #2817 (cor:api:120:04): the same size bounds as usageEventsPage — default 20, at most 200, a
      // negative limit or offset is 0 — so the legacy list can never return an unbounded number of rows.
      const { take, skip } = pageArgs(args);
      return projectUsageRowsFor(ctx, await ctx.db.usageEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        skip,
      }));
    },

    /** #2212 A1 — `usageEvents` as a page: the same gate and scope (one shared `where`), a stable `id` tiebreak, the real total. */
    usageEventsPage: async (
      _: unknown,
      args: { type?: string; memoryId?: string; nodeId?: string; loc?: string; since?: string | null; until?: string | null; appKey?: string | null; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const where = await usageEventsWhere(ctx, args);
      const { take, skip } = pageArgs(args);
      const [total, items] = await ctx.db.$transaction([
        ctx.db.usageEvent.count({ where }),
        ctx.db.usageEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return pageEnvelope(projectUsageRowsFor(ctx, items), total, skip);
    },

    /**
     * #2913 — where one connect flow is (cor:dmo:080:04 "Finding the connection a flow made"). Only the user who
     * started the flow reads it, for CONNECTION_FLOW_TTL_MS from the start; an unknown, expired or another user's id
     * is ONE refusal, decided by one statement (id AND starter AND the hour, on the database clock) so the answer
     * cannot tell the three apart. Same callers as `startConnection`: a person acting as themselves, never an App
     * key, a worker session, an impersonated request or an MCP-only OAuth credential. Writes nothing.
     */
    connectionFlow: async (_: unknown, { flowId }: { flowId: string }, ctx: Context) => {
      if (ctx.impersonation) throw authorizationDenied();
      if (!ctx.userId) {
        throw new GraphQLError('Reading a connection flow needs a signed-in user.', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      if (ctx.appId) throw authorizationDenied();
      await requirePersonAsThemselves(ctx, authorizationDenied);
      if (oauthSurfaceRefusal(ctx, 'account')) throw authorizationDenied();
      const rows = await ctx.db.$queryRaw<{ connection_id: string | null; failure_code: string | null }[]>`
        SELECT connection_id, failure_code FROM connection_flows
        WHERE id = ${flowId} AND user_id = ${ctx.userId}
          AND started_at > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${CONNECTION_FLOW_TTL_MS / 1000})`;
      const row = rows[0];
      if (!row) throw authorizationDenied();
      if (row.connection_id) return { status: 'CONNECTED', connectionId: row.connection_id, failureCode: null };
      if (row.failure_code) return { status: 'FAILED', connectionId: null, failureCode: row.failure_code };
      return { status: 'PENDING', connectionId: null, failureCode: null };
    },

    exchangeConnections: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      return listOrgExchangeConnections(ctx, resolvedOrgId);
    },

    /** #2213 — `exchangeConnections` as a page: the same admission, rows and order (one shared scope), counted and read in one snapshot. */
    exchangeConnectionsPage: async (
      _: unknown,
      args: { orgId: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, args.orgId);
      const { where, orderBy } = await orgExchangeConnectionScope(ctx, resolvedOrgId);
      const { take, skip } = pageArgs(args);
      const [total, items] = await ctx.db.$transaction([
        ctx.db.exchangeConnection.count({ where }),
        ctx.db.exchangeConnection.findMany({ where, orderBy, take, skip }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return pageEnvelope(items, total, skip);
    },

    exchangeMessages: async (
      _: unknown,
      {
        connectionId,
        top,
        filter,
        unreadOnly,
      }: { connectionId: string; top?: number; filter?: string; unreadOnly?: boolean },
      ctx: Context,
    ) => {
      // The legacy `filter` arg carried a raw Graph OData string — a
      // provider leak the neutral tool surface (spec 002) doesn't accept.
      // `unreadOnly` is the supported concept; the one legacy shape ever sent
      // still translates, anything else is a typed error rather than a
      // silently-ignored filter.
      const normalizedFilter = filter?.replace(/\s+/g, ' ').trim().toLowerCase();
      if (normalizedFilter && normalizedFilter !== 'isread eq false') {
        throw new GraphQLError('Raw provider filters are no longer supported; use unreadOnly.', {
          extensions: { code: 'EMAIL_FILTER_UNSUPPORTED', filter },
        });
      }
      const { messages } = await runOwnedEmailOperation<{ messages: ToolEmailMessage[] }>(
        ctx,
        connectionId,
        'list-messages',
        {
          // The tool caps top at 100 — clamp instead of surfacing a
          // validation error on a previously-unbounded GraphQL arg.
          top: Math.max(1, Math.min(top ?? 20, 100)),
          unreadOnly: unreadOnly || !!normalizedFilter || undefined,
        },
      );
      return messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.address ?? null,
        receivedDateTime: m.receivedAt,
        isRead: m.isRead,
        bodyPreview: m.snippet,
        body: m.body?.content ?? null,
        hasAttachments: m.hasAttachments,
      }));
    },

    exchangeFolders: async (_: unknown, { connectionId }: { connectionId: string }, ctx: Context) => {
      const { folders } = await runOwnedEmailOperation<{ folders: ToolEmailFolder[] }>(
        ctx,
        connectionId,
        'list-folders',
      );
      return folders.map((f) => ({
        id: f.id,
        displayName: f.name,
        totalItemCount: f.totalCount,
        unreadItemCount: f.unreadCount,
      }));
    },

    // ── Calendar reads (hadrontool-google-cal) ─────────────────────────
    // Same gate as the mail surface (requireEmailConnection via
    // runOwnedEmailOperation): interactive owner, or an App holding a
    // ConnectionGrant with the operation's calendar.* scope.

    calendars: async (_: unknown, { connectionRef }: { connectionRef: string }, ctx: Context) => {
      const { calendars } = await runOwnedEmailOperation<{ calendars: ToolCalendarInfo[] }>(
        ctx,
        connectionRef,
        'list-calendars',
      );
      return calendars;
    },

    calendarEvents: async (
      _: unknown,
      {
        connectionRef,
        calendarId,
        start,
        end,
        query,
        top,
      }: {
        connectionRef: string;
        calendarId?: string | null;
        start?: string | null;
        end?: string | null;
        query?: string | null;
        top?: number | null;
      },
      ctx: Context,
    ) => {
      const { events } = await runOwnedEmailOperation<{ events: ToolCalendarEvent[] }>(
        ctx,
        connectionRef,
        'list-events',
        {
          calendarId: calendarId ?? undefined,
          start: start ?? undefined,
          end: end ?? undefined,
          query: query ?? undefined,
          // The tool caps top at 100 — clamp instead of surfacing a
          // validation error (the exchangeMessages precedent).
          top: Math.max(1, Math.min(top ?? 20, 100)),
        },
      );
      return events.map(mapToolCalendarEvent);
    },

    calendarEvent: async (
      _: unknown,
      { connectionRef, eventId, calendarId }: { connectionRef: string; eventId: string; calendarId?: string | null },
      ctx: Context,
    ) => {
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(ctx, connectionRef, 'get-event', {
        eventId,
        calendarId: calendarId ?? undefined,
      });
      return mapToolCalendarEvent(event);
    },

    calendarSchedule: async (
      _: unknown,
      {
        connectionRef,
        start,
        end,
        schedules,
      }: { connectionRef: string; start: string; end: string; schedules?: string[] | null },
      ctx: Context,
    ) => {
      const result = await runOwnedEmailOperation<{ schedules: ToolScheduleFreeBusy[] }>(
        ctx,
        connectionRef,
        'get-schedule',
        {
          start,
          end,
          schedules: schedules?.length ? schedules : undefined,
        },
      );
      return result.schedules;
    },

    // ── Drive reads (hadrontool-google-drive, #749) ────────────────────
    // Same gate as the mail/calendar surfaces (requireEmailConnection via
    // runOwnedEmailOperation): interactive owner, or an App holding a
    // ConnectionGrant with the drive.read scope. The tool's wire shapes map
    // 1:1 onto the GraphQL types (kind is already uppercase-safe — the enum
    // mapping happens via mapToolDriveFile like the calendar surface).

    driveFiles: async (
      _: unknown,
      {
        connectionRef,
        folderId,
        query,
        nameContains,
        mimeType,
        modifiedAfter,
        top,
        pageToken,
      }: {
        connectionRef: string;
        folderId?: string | null;
        query?: string | null;
        nameContains?: string | null;
        mimeType?: string | null;
        modifiedAfter?: string | null;
        top?: number | null;
        pageToken?: string | null;
      },
      ctx: Context,
    ) => {
      // A plain folder listing and a criteria search are ONE GraphQL field
      // (the tool splits them so a sibling can, too): any search criterion
      // routes to search-files, bare folder browsing to list-files.
      const searching = Boolean(query || nameContains || mimeType || modifiedAfter);
      const input: Record<string, unknown> = {
        folderId: folderId ?? undefined,
        // The tool caps top at 100 — clamp instead of surfacing a
        // validation error (the exchangeMessages precedent).
        top: Math.max(1, Math.min(top ?? 20, 100)),
        pageToken: pageToken ?? undefined,
      };
      if (searching) {
        input.query = query ?? undefined;
        input.nameContains = nameContains ?? undefined;
        input.mimeType = mimeType ?? undefined;
        input.modifiedAfter = modifiedAfter ?? undefined;
      }
      const page = await runOwnedEmailOperation<{ files: ToolDriveFile[]; nextPageToken: string | null }>(
        ctx,
        connectionRef,
        searching ? 'search-files' : 'list-files',
        input,
      );
      return { files: page.files.map(mapToolDriveFile), nextPageToken: page.nextPageToken };
    },

    driveFile: async (
      _: unknown,
      { connectionRef, fileId }: { connectionRef: string; fileId: string },
      ctx: Context,
    ) => {
      const { file } = await runOwnedEmailOperation<{ file: ToolDriveFile }>(ctx, connectionRef, 'get-file', {
        fileId,
      });
      return mapToolDriveFile(file);
    },

    driveFileExport: async (
      _: unknown,
      { connectionRef, fileId, format }: { connectionRef: string; fileId: string; format?: string | null },
      ctx: Context,
    ) => {
      const result = await runOwnedEmailOperation<{ export: ToolDriveExport; file: ToolDriveFile }>(
        ctx,
        connectionRef,
        'export-file',
        { fileId, format: format ? format.toLowerCase() : undefined },
      );
      return {
        content: result.export.content,
        mimeType: result.export.mimeType,
        format: result.export.format.toUpperCase(),
        file: mapToolDriveFile(result.file),
      };
    },
};
