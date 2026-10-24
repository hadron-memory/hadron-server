// sessionQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import {
  assertFullyQualifiedUrn,
  hasSchemePrefix,
} from '../../../lib/urn.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { GraphQLError } from 'graphql';
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

/**
 * The `where` shared by `usageEvents` and `usageEventsPage` (#2212 A1): the READER gate, the loc/nodeId
 * addressing rules and the accessible-memory scope, all resolved before any query.
 */
async function usageEventsWhere(
  ctx: Context,
  { type, memoryId, nodeId, loc }: { type?: string; memoryId?: string; nodeId?: string; loc?: string },
): Promise<Prisma.UsageEventWhereInput> {
      requireRole(ctx, 'READER');

      // `loc` and `nodeId` are two different addressing modes for the same
      // filter slot — a verbatim loc filter vs a shape-classified node token.
      // Passing both is a contradiction we refuse rather than pick a winner.
      if (loc !== undefined && nodeId !== undefined) {
        throw new GraphQLError('Provide either nodeId or loc, not both', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
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

      // Per-memory scoping (issue #249, moved onto the column in #796): filter
      // on `UsageEvent.memoryId` directly. This was a UsageEvent→Node relation
      // join, which was FK-precise (no cross-memory nodeLoc collision) but
      // dropped every event whose node had since been deleted — `nodeId` is
      // SetNull, so a memory silently lost that history. The column keeps the
      // precision and survives deletion. memoryUsageSummary moved in lockstep.
      let memoryScopeId: string | undefined;
      if (memoryId) {
        // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
        const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
        // #250 denied an unreadable memory with [] to avoid leaking existence,
        // but a MISSING memory throws above, so [] itself meant "exists, not
        // yours". #1381 (`cor:api:140:03`): answer exactly as resolveMemoryRef's
        // miss instead.
        if (accessibleMemoryIds !== null && !accessibleMemoryIds.includes(resolvedMemoryId)) {
          throw new MemoryNotFoundError(memoryId);
        }
        memoryScopeId = resolvedMemoryId;
      }

      // Resolve the memory filter:
      //  - memoryId scoped path → the single, already access-checked memory.
      //  - otherwise → the caller's full accessible-memory set (#250). This
      //    bounds both the global feed and any bare-loc nodeId filter to
      //    readable memories. A `null` accessible set = unrestricted.
      //
      // Either way an event with a NULL memoryId is excluded, exactly as the
      // relation filter excluded an event with a null nodeId — `IN` never
      // matches NULL — so this widens results only to events already
      // attributed to a memory the caller can read.
      const memoryFilter: { memoryId: string } | { memoryId: { in: string[] } } | undefined =
        memoryScopeId !== undefined
          ? { memoryId: memoryScopeId }
          : accessibleMemoryIds !== null
            ? { memoryId: { in: accessibleMemoryIds } }
            : undefined;

  return {
          ...(type ? { type } : {}),
          ...(nodeIdFilter ? { nodeId: nodeIdFilter } : {}),
          ...(memoryFilter ?? {}),
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
        take: limit ?? 50,
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
      args: { type?: string; memoryId?: string; nodeId?: string; loc?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const where = await usageEventsWhere(ctx, args);
      return ctx.db.usageEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: args.limit ?? 50,
        skip: args.offset ?? 0,
      });
    },

    /** #2212 A1 — `usageEvents` as a page: the same gate and scope (one shared `where`), a stable `id` tiebreak, the real total. */
    usageEventsPage: async (
      _: unknown,
      args: { type?: string; memoryId?: string; nodeId?: string; loc?: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const where = await usageEventsWhere(ctx, args);
      const { take, skip } = pageArgs(args);
      const [total, items] = await ctx.db.$transaction([
        ctx.db.usageEvent.count({ where }),
        ctx.db.usageEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return pageEnvelope(items, total, skip);
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
          top: Math.max(1, Math.min(top ?? 25, 100)),
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
          top: Math.max(1, Math.min(top ?? 25, 100)),
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
        top: Math.max(1, Math.min(top ?? (searching ? 25 : 50), 100)),
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
