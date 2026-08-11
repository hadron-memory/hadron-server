// sessionMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
import { lockAncestorsForCreate, lockAncestorsForCreateMany } from '../../../lib/nodeSubtreeLock.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import { isAgentInstalled } from '../../../lib/appAgent.js';
import {
  parseDataKey,
  type EncryptionKey,
} from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  assertFullyQualifiedUrn,
  UrnNotQualifiedError,
  splitNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
  agentSlugFromUrn,
} from '../../../lib/urn.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';
import { assembleRunNodePrompt } from '../../../lib/runNodeRender.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { generateUniqueHandle } from '../../../lib/userHandle.js';
import { ensureUserPrincipal } from '../../../lib/principal/mintPrincipal.js';
import { isRoutingName, routingNameOf } from '../../../lib/runner/selectNextEdge.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { NodeNotFoundError, AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { triggerManualRun } from './resolvers.appRun.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { serializeJson } from '../../../integrations/db/provider.js';
import { deleteToolConnection, type ToolCalendarEvent } from '../../../lib/emailClient.js';
import {
  type Context,
  requireRole,
  requireOrgRole,
  requireOwnerOrOrgRole,
  resolveReadableNodeByLoc,
  SESSION_INCLUDE,
  mapToolCalendarEvent,
  runOwnedEmailOperation,
  type SessionInput,
  type UsageEventInput,
} from './resolvers.helpers.js';

/**
 * Strip explicit GraphQL nulls from a CalendarEventTimeInput so the tool's
 * either/or schema sees absent fields, not null values (JSON.stringify drops
 * undefined but serializes null).
 */
function dropNulls(t: { dateTime?: string | null; date?: string | null; timeZone?: string | null }) {
  return {
    dateTime: t.dateTime ?? undefined,
    date: t.date ?? undefined,
    timeZone: t.timeZone ?? undefined,
  };
}

export const sessionMutations = {
    startSession: async (_: unknown, { input }: { input: SessionInput }, ctx: Context) => {
      // #928: optional persona link. `agentRef` (PK or URN, cor:api:140)
      // resolves to Session.agentId. Gate mirrors Query.agent's read gate —
      // a PUBLIC agent attaches for any caller, otherwise owner / org member
      // (READER) — so a session is never attributed to an agent the caller
      // cannot read. Resolution is not authorization (#554): the
      // resource-scoped gate runs on the RESOLVED agent.
      let agentId: string | undefined;
      // Trimmed: a whitespace-only ref is a trivial client bug and reads as
      // absent, not as a malformed URN (#929 review).
      const agentRef = input.agentRef?.trim();
      if (agentRef) {
        let resolvedAgentId: string;
        try {
          ({ id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef));
        } catch (e) {
          // A mutation input error surfaces loudly (contrast Query.agent,
          // which masks not-found to null); malformed URNs propagate their
          // own typed error from assertFullyQualifiedUrn.
          if (e instanceof AgentNotFoundError) {
            throw new GraphQLError(`Agent not found: ${agentRef}`, { extensions: { code: 'BAD_USER_INPUT' } });
          }
          throw e;
        }
        const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
        if (agent.deletedAt) {
          throw new GraphQLError(`Agent not found: ${agentRef}`, { extensions: { code: 'BAD_USER_INPUT' } });
        }
        if (agent.visibility !== 'PUBLIC') {
          await requireOwnerOrOrgRole(ctx, agent, 'READER');
        }
        agentId = resolvedAgentId;
      }
      return ctx.db.session.create({
        data: {
          id: input.id,
          type: (input.type as any) ?? 'DEVELOPER',
          appId: ctx.appId,
          agentId,
          // #929 review P1: attribute the session to the calling user (the
          // schema documents userId as "the developer in a DEVELOPER
          // session"). Without it a session started outside any App context
          // (appId null — the CLI coding case) was invisible to its own
          // creator through both session read gates.
          userId: ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
          customerId: input.customerId,
          language: input.language,
          llmModel: input.llmModel,
          parentSessionId: input.parentSessionId,
          prevSessionId: input.prevSessionId,
          // #928 coding-session provenance.
          transcriptPath: input.transcriptPath,
          host: input.host,
          tool: input.tool,
        },
        include: SESSION_INCLUDE,
      });
    },

    endSession: async (
      _: unknown,
      {
        id,
        summary,
        inputTokens,
        outputTokens,
        turnCount,
        errorCount,
      }: { id: string; summary?: string; inputTokens?: number; outputTokens?: number; turnCount?: number; errorCount?: number },
      ctx: Context,
    ) => {
      return ctx.db.session.update({
        where: { id },
        data: { endedAt: new Date(), summary, inputTokens, outputTokens, turnCount, errorCount },
        include: SESSION_INCLUDE,
      });
    },

    recordUsage: async (_: unknown, { event }: { event: UsageEventInput }, ctx: Context) => {
      // #825: attribution must never name a node the caller cannot read.
      // `nodeLoc` is a bare loc, and loc is unique per MEMORY rather than
      // globally, so the old unscoped `findFirst` resolved to an arbitrary
      // tenant's node and stamped ITS memoryId onto the row — landing in that
      // org's usage analytics (#796/#799 scope on UsageEvent.memoryId).
      //
      // Resolution now runs through the shared read gate, so the candidate set
      // is exactly what this caller may read. An unreadable or absent loc
      // yields no attribution (nodeId/memoryId stay null) rather than an error:
      // the raw `nodeLoc` string is still recorded, and denied and missing stay
      // indistinguishable, so this can't be used to probe what exists.
      requireRole(ctx, 'READER');
      const node = event.nodeLoc
        ? await resolveReadableNodeByLoc(ctx, event.nodeLoc)
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          // #796: derived from the same row `nodeId` comes from — now a row the
          // caller demonstrably can read, so the memory attribution is theirs
          // to make. Keeping it derived leaves UsageEventInput unchanged.
          memoryId: node?.memoryId,
          actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
          appId: ctx.appId,
          // Attribution from auth (spec 046 FR-001), as the MCP recorders do.
          // This path only ever set the audit `createdBy` string, so a signed-in
          // user's reads/writes recorded here were invisible to any query
          // filtering on `userId` — including #796's own-activity scope.
          userId: ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          sessionId: event.sessionId,
          model: event.model,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
        },
      });
      return true;
    },

    startAgentSession: async (
      _: unknown,
      { agentId, externalUserId, sessionTimeoutSeconds, dataKey }: {
        agentId: string;
        externalUserId?: string;
        sessionTimeoutSeconds?: number;
        dataKey?: string;
      },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });

      // 008: App→Agent is a direct FK; the App can operate exactly the Agent
      // referenced by App.agent_id (no AppAgent join). Orphan Apps (agent_id
      // IS NULL) cannot operate any agent.
      // 023-app-shape Phase 2b: App↔Agent goes through AppAgent. Check
      // that the requested Agent is installed in the calling App.
      if (!(await isAgentInstalled(ctx.db, app.id, agentId))) {
        throw new Error('Forbidden: App is not allowed to operate this agent');
      }

      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.deletedAt) throw new Error('Agent not found');
      // Per-user/anonymous session memories are provisioned under the
      // Agent's owning org (their URN is derived from the org's URN) — not
      // yet modeled for a user-owned Agent.
      if (!agent.organizationId) {
        throw new GraphQLError('startAgentSession is not supported for a user-owned Agent yet.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // SECRET mode requires a data key; USER_ID mode rejects it.
      if (app.identifyUserMethod === 'SECRET' && !dataKey) {
        throw new Error('dataKey is required when the app uses identifyUserMethod: SECRET');
      }
      if (app.identifyUserMethod === 'USER_ID' && dataKey) {
        throw new Error('dataKey is only accepted when the app uses identifyUserMethod: SECRET');
      }

      const parsedKey: EncryptionKey | null = dataKey ? parseDataKey(dataKey) : null;

      // Resolve user (optional — null means anonymous session)
      let userId: string | null = null;
      if (externalUserId) {
        let user = await ctx.db.user.findFirst({
          where: { externalAppId: ctx.appId, externalId: externalUserId, deletedAt: null },
        });
        if (!user) {
          if (app.createUserPermission !== 'IMPLICIT') {
            throw new Error('User not found. Call createAppUser first or set createUserPermission=IMPLICIT.');
          }
          // Handle is NOT NULL (spec 047). An implicitly-provisioned app
          // end-user gets a RANDOM handle — it's addressed by (externalAppId,
          // externalId), not by handle, and its externalId must not leak into a
          // global handle.
          const appUserHandle = await generateUniqueHandle(ctx.db);
          user = await ctx.db.$transaction(async (tx) => {
            const u = await tx.user.create({
              data: {
                externalAppId: ctx.appId,
                externalId: externalUserId,
                identityProvider: 'APP',
                handle: appUserHandle,
                createdBy: ctx.appId,
              },
            });
            await ensureUserPrincipal(tx, u); // #692: pool principal
            return u;
          });
        }
        userId = user.id;
      }

      // 005-agent-subscription FR-002: auto-provision an AgentSubscription
      // on the first user-attributed contact for (user, agent). Idempotent.
      if (userId) {
        await ensureAgentSubscription(ctx.db, userId, agentId);
      }

      // Find or lazily provision the user memory for (agent, user)
      let memoryId: string;
      let memoryIsEncrypted = false;
      if (userId) {
        const existing = await ctx.db.memory.findFirst({
          where: { userMemoryOfAgentId: agentId, createdBy: userId, deletedAt: null },
        });
        if (existing) {
          memoryId = existing.id;
          memoryIsEncrypted = existing.isEncrypted;
        } else {
          const org = await ctx.db.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          // #697 Stage 3: mint a FLAT single-atom v2 urn (`<org>:<opaqueId>`) —
          // the `app-user` scope now lives in the row columns (class/userId/
          // userMemoryOfAgentId/appId), not the URN path, so node URNs in this
          // memory round-trip through splitNodeUrn. The opaque id can't collide,
          // so this stores `<org>:<opaqueId>` unaliased.
          const memoryUrn = await mintMemoryUrnV2(ctx.db, {
            root: org.urn,
            desiredSlug: opaqueId,
            authorRoot: agentSlugFromUrn(agent.urn),
          });
          const created = await ctx.db.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `User memory (${agent.name})`,
              // 005-agent-subscription: per-user memory keyed on userId.
              // Bidirectional CHECK constraint requires class IN
              // (personal,private) ⇔ userId IS NOT NULL.
              userId,
              // 041 (#516): 'private' is the ONLY encryptable class. In SECRET
              // mode we birth the memory encrypted, so it must be born 'private'
              // (owner-only, caller-held key — that IS the private threat model).
              // Plaintext USER_ID memories stay 'personal'. Both satisfy the
              // bidirectional CHECK class IN (personal,private) ⇔ userId IS NOT NULL.
              class: parsedKey !== null ? 'private' : 'personal',
              // 035-visibility-enum-cleanup: personal/private privacy is
              // class-driven; visibility is NULL (was PERSONAL).
              visibility: null,
              userMemoryOfAgentId: agentId,
              // 008-agent-installation: personal memories pivot on
              // (app_id, user_id). The chk_memory_class_app_id constraint
              // requires app_id when class IN ('app', 'personal').
              appId: ctx.appId,
              // New user memories in SECRET mode are encrypted from creation.
              isEncrypted: parsedKey !== null,
              createdBy: userId,
            },
          });
          memoryId = created.id;
          memoryIsEncrypted = parsedKey !== null;
        }
      } else {
        // Anonymous session — create a scratch memory with expiry. Anonymous
        // memories are always plaintext until linkMemoryToUser promotes them.
        const org = await ctx.db.organization.findUniqueOrThrow({
          where: { id: agent.organizationId }, select: { urn: true },
        });
        const opaqueId = generateId();
        const agentSlug = agentSlugFromUrn(agent.urn);
        // #697 Stage 3: flat single-atom v2 urn (`<org>:<opaqueId>`) — the anon
        // scope lives in the row columns, not the URN path (see the app-user
        // branch above). Fresh opaque id ⇒ no collision, stored unaliased.
        const memoryUrn = await mintMemoryUrnV2(ctx.db, {
          root: org.urn,
          desiredSlug: opaqueId,
          authorRoot: agentSlug,
        });
        const expires = new Date(Date.now() + app.anonymousTtlDays * 24 * 60 * 60 * 1000);
        const created = await ctx.db.memory.create({
          data: {
            organizationId: agent.organizationId,
            urn: memoryUrn,
            name: `Anonymous session (${agent.name})`,
            // Anonymous: no userId yet (linkMemoryToUser later may set
            // it); class is 'app' since the data belongs to the App's
            // bucket of records-through-this-agent until promoted.
            class: 'app',
            // 035-visibility-enum-cleanup: app-class visibility is NULL.
            visibility: null,
            userMemoryOfAgentId: agentId,
            // 008-agent-installation: app-class memories require app_id
            // (chk_memory_class_app_id).
            appId: ctx.appId,
            anonymousExpiresAt: expires,
            createdBy: ctx.appId,
          },
        });
        memoryId = created.id;
        memoryIsEncrypted = false;
      }

      // If the memory is encrypted, the caller must provide a matching key.
      // (In SECRET mode we already required a dataKey above; this check also
      // handles a later call with USER_ID mode on an already-encrypted mem.)
      if (memoryIsEncrypted && !parsedKey) {
        throw new Error('Memory is encrypted; dataKey is required');
      }

      // Clamp session timeout to the app's configured maximum (ceiling)
      const ttl = Math.min(
        sessionTimeoutSeconds ?? app.sessionTimeoutSeconds,
        app.sessionTimeoutSeconds,
      );
      const expiresAt = new Date(Date.now() + ttl * 1000);

      const session = await ctx.db.session.create({
        data: {
          id: generateId(),
          type: 'CHATBOT',
          appId: ctx.appId,
          userId: userId ?? null,
          agentId,
          memoryId,
          expiresAt,
          createdBy: ctx.appId,
        },
      });

      // Register the key in the session key cache so this session (and any
      // concurrent one for the same memory) can decrypt content.
      if (parsedKey) {
        sessionKeyCache.set(session.id, memoryId, parsedKey);
      }

      return session;
    },

    endAgentSession: async (_: unknown, { sessionId }: { sessionId: string }, ctx: Context) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const session = await ctx.db.session.findUnique({ where: { id: sessionId } });
      if (!session || session.appId !== ctx.appId) {
        throw new Error('Session not found');
      }
      if (session.endedAt) {
        sessionKeyCache.evict(sessionId); // defensive — idempotent
        return true;
      }
      await ctx.db.session.update({
        where: { id: sessionId },
        data: { endedAt: new Date() },
      });
      // Evict the data key from the in-memory cache. Ref counting means the
      // key stays available to any other active session on the same memory.
      sessionKeyCache.evict(sessionId);
      return true;
    },

    createRevision: async (
      _: unknown,
      { agentId, description }: { agentId: string; description?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      // Snapshot all non-revision nodes + edges in the system memory
      const nodes = await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true, tags: true },
      });
      const nodeIds = (await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { id: true },
      })).map((n) => n.id);
      const edges = await ctx.db.edge.findMany({
        where: { sourceId: { in: nodeIds }, deletedAt: null },
        include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
      });
      const edgeSnapshots = edges.map((e) => ({
        sourceLoc: e.source.loc,
        targetLoc: e.target.loc,
        loc: e.loc,
        name: e.name,
        description: e.description,
        isRunnable: e.isRunnable,
        data: e.data,
      }));

      // Count existing revisions to auto-increment
      const existingRevisions = await ctx.db.node.count({
        where: { memoryId: sysMemId, loc: { startsWith: 'revisions:' }, deletedAt: null },
      });
      const revNum = existingRevisions + 1;
      const label = `rev-${revNum}`;
      const revLoc = `revisions:${label}`;

      // Ensure revisions parent exists
      try {
        await ctx.db.node.upsert({
          where: { loc_memoryId: { loc: 'revisions', memoryId: sysMemId } },
          create: { id: generateId(), memoryId: sysMemId, loc: 'revisions', name: 'revisions', nodeType: 'system' },
          update: {},
        });
      } catch { /* exists */ }

      // #664/#752: revLoc is `revisions:<label>`, so a concurrent non-recursive
      // delete of the `revisions` parent could count zero descendants and then
      // orphan this row. Hold the ancestor-path lock across the insert (advisory
      // before row; READ COMMITTED so the delete's count sees this post-commit).
      await ctx.db.$transaction(async (tx) => {
        await lockAncestorsForCreate(tx, sysMemId, revLoc);
        await tx.node.create({
          data: {
            id: generateId(), memoryId: sysMemId, loc: revLoc, name: label,
            nodeType: 'system',
            description: description ?? `Revision ${revNum}`,
            data: {
              revision: revNum,
              label,
              published: false,
              createdBy: ctx.userId ?? null,
              snapshot: { nodes: nodes.map((n) => ({ ...n, tags: n.tags ?? [] })), edges: edgeSnapshots },
            } as InputJsonValue,
          },
        });
      });

      return { revisionLoc: revLoc, label, published: false, createdAt: new Date().toISOString() };
    },

    publishRevision: async (
      _: unknown,
      { agentId, revisionLoc, versionLabel }: { agentId: string; revisionLoc: string; versionLabel?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const label = versionLabel ?? (revData.label as string) ?? revisionLoc;

      // Mark as published
      await ctx.db.node.update({
        where: { id: revNode.id },
        data: { data: { ...revData, published: true, publishedAt: new Date().toISOString(), versionLabel: label } as InputJsonValue },
      });

      // Update agent to point to this revision
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { publishedRevisionLoc: revisionLoc },
      });

      return { revisionLoc, label, published: true, createdAt: new Date().toISOString() };
    },

    restoreRevision: async (
      _: unknown,
      { agentId, revisionLoc }: { agentId: string; revisionLoc: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const snapshot = revData.snapshot as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } | undefined;
      if (!snapshot) throw new Error('Revision has no snapshot data');

      // Auto-save current state before restoring
      await sessionMutations.createRevision({}, { agentId: resolvedAgentId, description: `Auto-save before restoring ${revisionLoc}` }, ctx);

      // Restore is ATOMIC (#752 review, Codex P1): the destructive soft-deletes
      // AND the snapshot restore run in ONE transaction, so any failure — the
      // interactive-transaction timeout included — rolls the whole thing back
      // rather than leaving the system memory emptied by the preamble. Advisory
      // locks come first (#664 — a concurrent non-recursive ancestor-delete
      // can't miss the restored rows, and advisory-before-row ordering avoids a
      // lock-order inversion with the delete path). The generous timeout covers
      // a large snapshot; READ COMMITTED (the default) gives each statement a
      // fresh snapshot after the lock is granted.
      const locToId = new Map<string, string>();
      await ctx.db.$transaction(
        async (tx) => {
          await lockAncestorsForCreateMany(
            tx,
            sysMemId,
            snapshot.nodes.map((n) => n.loc as string).filter((l) => typeof l === 'string' && l !== ''),
          );

          // Delete all current non-revision nodes in the system memory
          await tx.node.updateMany({
            where: {
              memoryId: sysMemId,
              deletedAt: null,
              NOT: { loc: { startsWith: 'revisions' } },
            },
            data: { deletedAt: new Date() },
          });

          // Delete all edges in the system memory
          const currentNodeIds = (await tx.node.findMany({
            where: { memoryId: sysMemId },
            select: { id: true },
          })).map((n) => n.id);
          await tx.edge.updateMany({
            where: { sourceId: { in: currentNodeIds }, deletedAt: null },
            data: { deletedAt: new Date() },
          });

          // Restore nodes from snapshot (upsert to handle soft-deleted rows
          // that still hold the unique (loc, memoryId) constraint).
          for (const n of snapshot.nodes) {
            const loc = n.loc as string;
            const nodeData = {
              name: n.name as string,
              nodeType: (n.nodeType as string) ?? 'system',
              description: (n.description as string) ?? null,
              content: (n.content as string) ?? null,
              data: (n.data ?? null) as InputJsonValue,
              tags: (n.tags as string[]) ?? [],
              deletedAt: null,
            };
            const upserted = await tx.node.upsert({
              where: { loc_memoryId: { loc, memoryId: sysMemId } },
              create: { id: generateId(), memoryId: sysMemId, loc, ...nodeData },
              update: nodeData,
            });
            locToId.set(loc, upserted.id);
          }

          // Restore edges from snapshot. Spec 037: derive loc when an older
          // snapshot predates the edge `loc`/`name` fields (it would carry the
          // legacy `label`); memoryId is the system memory being restored into.
          for (const e of snapshot.edges) {
            const sourceId = locToId.get(e.sourceLoc as string);
            const targetId = locToId.get(e.targetLoc as string);
            if (sourceId && targetId) {
              const edgeName = ((e.name ?? e.label) as string | null) ?? null;
              const edgeLoc = (e.loc as string | undefined)
                ?? deriveEdgeLoc(e.sourceLoc as string, edgeName, e.targetLoc as string);
              const edgeFields = {
                sourceId,
                targetId,
                name: edgeName,
                description: (e.description as string | null) ?? null,
                isRunnable: (e.isRunnable as boolean | null) ?? null,
                data: (e.data ?? null) as InputJsonValue,
              };
              // Upsert, not create: the edge soft-delete above leaves the
              // (loc, memoryId) slot occupied (Edge @@unique([loc, memoryId]) is
              // unfiltered), so a plain create would hit the unique index for any
              // graph that already had an edge at this loc (Copilot review). The
              // update branch RESURRECTS that soft-deleted row — mirrors the node
              // upsert above.
              await tx.edge.upsert({
                where: { loc_memoryId: { loc: edgeLoc, memoryId: sysMemId } },
                create: { id: generateId(), memoryId: sysMemId, loc: edgeLoc, ...edgeFields },
                update: { ...edgeFields, deletedAt: null },
              });
            }
          }
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      return { revisionLoc, label: (revData.label as string) ?? revisionLoc, published: false, createdAt: new Date().toISOString() };
    },

    // ── Editor lock ────────────────────────────────────────────────────

    acquireEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');

      const now = new Date();
      const lockExpiry = (agent as any).editorLockExpiresAt as Date | null;
      const lockUser = (agent as any).editorLockUserId as string | null;

      // If locked by someone else and not expired, reject
      if (lockUser && lockUser !== ctx.userId && lockExpiry && lockExpiry > now) {
        return { locked: false, lockedBy: lockUser, expiresAt: lockExpiry.toISOString() };
      }

      // Acquire or renew lock (5 minutes)
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: ctx.userId, editorLockExpiresAt: expiresAt },
      });

      return { locked: true, lockedBy: ctx.userId, expiresAt: expiresAt.toISOString() };
    },

    releaseEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');

      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: null, editorLockExpiresAt: null },
      });
      return true;
    },

    // ── Chat ownership mutations ────────────────────────────────────

    deleteExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
      await ctx.db.exchangeConnection.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      });
      // Tear down the provider tool's side (token + Graph subscriptions) —
      // best-effort fire-and-forget (deleteToolConnection never throws); the
      // soft-delete above already committed and must not wait on the tool.
      if (connection.toolConnectionId) {
        void deleteToolConnection(connection.provider, connection.toolConnectionId);
      }
      return true;
    },

    testExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      try {
        await runOwnedEmailOperation(ctx, id, 'list-messages', { top: 1 });
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'OK', lastError: null, lastSyncAt: new Date() },
        });
        return true;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'ERROR', lastError: errMsg },
        });
        throw new Error(`Exchange connection test failed: ${errMsg}`);
      }
    },

    exchangeReply: async (
      _: unknown,
      { connectionId, messageId, body }: { connectionId: string; messageId: string; body: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionId, 'reply-to-message', {
        messageId,
        bodyHtml: body,
      });
      return true;
    },

    exchangeMoveMessage: async (
      _: unknown,
      { connectionId, messageId, folderId }: { connectionId: string; messageId: string; folderId: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionId, 'move-message', {
        messageId,
        destinationFolderId: folderId,
      });
      return true;
    },

    // ── spec 002 email operations (provider-neutral names) ─────────────
    // The drafts/flag/read-status capabilities the ms-exchange tool added.
    // All owner-only via requireEmailConnection; `idempotencyKey` rides
    // through to the tool's reservation-based replay (at-least-once callers).
    // The legacy exchange* names above stay as portal-compatible shims until
    // the portal migrates to this surface (#396 follow-up).

    emailSaveDraft: async (
      _: unknown,
      {
        connectionRef,
        replyToMessageId,
        to,
        subject,
        bodyHtml,
        idempotencyKey,
      }: {
        connectionRef: string;
        replyToMessageId?: string | null;
        to?: string[] | null;
        subject?: string | null;
        bodyHtml: string;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      return runOwnedEmailOperation<{ draftId: string; conversationId: string | null }>(
        ctx,
        connectionRef,
        'save-draft',
        {
          // JSON.stringify drops undefined values, so plain fields suffice.
          replyToMessageId: replyToMessageId ?? undefined,
          to: to?.length ? to : undefined,
          subject: subject ?? undefined,
          bodyHtml,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
    },

    emailUpdateDraft: async (
      _: unknown,
      { connectionRef, draftId, bodyHtml }: { connectionRef: string; draftId: string; bodyHtml: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'update-draft', { draftId, bodyHtml });
      return true;
    },

    emailSendDraft: async (
      _: unknown,
      {
        connectionRef,
        draftId,
        idempotencyKey,
      }: { connectionRef: string; draftId: string; idempotencyKey?: string | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'send-draft', {
        draftId,
        idempotencyKey: idempotencyKey ?? undefined,
      });
      return true;
    },

    emailDeleteMessage: async (
      _: unknown,
      { connectionRef, messageId }: { connectionRef: string; messageId: string },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'delete-message', { messageId });
      return true;
    },

    emailMarkRead: async (
      _: unknown,
      { connectionRef, messageId, isRead }: { connectionRef: string; messageId: string; isRead?: boolean | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'mark-read', {
        messageId,
        isRead: isRead ?? true,
      });
      return true;
    },

    emailFlagMessage: async (
      _: unknown,
      {
        connectionRef,
        messageId,
        flag,
      }: { connectionRef: string; messageId: string; flag?: 'FLAGGED' | 'NONE' | 'COMPLETE' | null },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'flag-message', {
        messageId,
        flag: (flag ?? 'FLAGGED').toLowerCase(),
      });
      return true;
    },

    emailCategorizeMessage: async (
      _: unknown,
      {
        connectionRef,
        messageId,
        categories,
      }: { connectionRef: string; messageId: string; categories: string[] },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'categorize-message', {
        messageId,
        categories,
      });
      return true;
    },

    // ── Calendar mutations (hadrontool-google-cal) ─────────────────────
    // All owner-only in v1: no OPERATION_SCOPES entry maps to these, so an
    // App/headless caller is denied fail-closed even with a grant. The tool
    // validates the either/or event-boundary shape and the response
    // vocabulary; its typed validation_error passes through verbatim.

    calendarCreateEvent: async (
      _: unknown,
      {
        connectionRef,
        calendarId,
        title,
        description,
        location,
        start,
        end,
        attendees,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        calendarId?: string | null;
        title: string;
        description?: string | null;
        location?: string | null;
        start: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
        end: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
        attendees?: string[] | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'create-event',
        {
          calendarId: calendarId ?? undefined,
          title,
          description: description ?? undefined,
          location: location ?? undefined,
          start: dropNulls(start),
          end: dropNulls(end),
          attendees: attendees?.length ? attendees : undefined,
          notifyAttendees: notifyAttendees ?? undefined,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
      return mapToolCalendarEvent(event);
    },

    calendarUpdateEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        calendarId,
        title,
        description,
        location,
        start,
        end,
        attendees,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        eventId: string;
        calendarId?: string | null;
        title?: string | null;
        description?: string | null;
        location?: string | null;
        start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
        end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
        attendees?: string[] | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'update-event',
        {
          eventId,
          calendarId: calendarId ?? undefined,
          title: title ?? undefined,
          description: description ?? undefined,
          location: location ?? undefined,
          start: start ? dropNulls(start) : undefined,
          end: end ? dropNulls(end) : undefined,
          // An explicit empty list is a real patch value (clear the set).
          attendees: attendees ?? undefined,
          notifyAttendees: notifyAttendees ?? undefined,
          idempotencyKey: idempotencyKey ?? undefined,
        },
      );
      return mapToolCalendarEvent(event);
    },

    calendarDeleteEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        calendarId,
        notifyAttendees,
        idempotencyKey,
      }: {
        connectionRef: string;
        eventId: string;
        calendarId?: string | null;
        notifyAttendees?: boolean | null;
        idempotencyKey?: string | null;
      },
      ctx: Context,
    ) => {
      await runOwnedEmailOperation(ctx, connectionRef, 'delete-event', {
        eventId,
        calendarId: calendarId ?? undefined,
        notifyAttendees: notifyAttendees ?? undefined,
        idempotencyKey: idempotencyKey ?? undefined,
      });
      return true;
    },

    calendarRespondToEvent: async (
      _: unknown,
      {
        connectionRef,
        eventId,
        response,
        calendarId,
      }: {
        connectionRef: string;
        eventId: string;
        response: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' | 'NONE';
        calendarId?: string | null;
      },
      ctx: Context,
    ) => {
      // NONE exists in the enum for READS (invited, not yet answered) but is
      // not a settable response for ANY provider — reject in core with a
      // stable code rather than leaning on the tool's validation wording
      // (PR-638 Copilot review). Unlike EmailFlag's COMPLETE, this is not
      // provider-dependent, so core is the right layer.
      if (response === 'NONE') {
        throw new GraphQLError('NONE is not a settable response — use ACCEPTED, DECLINED, or TENTATIVE.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'respond-to-event',
        {
          eventId,
          calendarId: calendarId ?? undefined,
          response: response.toLowerCase(),
        },
      );
      return mapToolCalendarEvent(event);
    },

    runTask: async (
      _: unknown,
      {
        nodeRef,
        args: argsInput,
        appRef,
        runAsSelf,
      }: {
        nodeRef: string;
        args?: unknown;
        appRef?: string | null;
        runAsSelf?: boolean | null;
      },
      ctx: Context,
    ) => {
      // #542 — the task node is identified by a single `nodeRef` (ID or a
      // fully-qualified node URN), resolved by the shared `resolveNodeRef`
      // (spec 007) exactly like every other `<object>Ref` arg. The loose
      // `task`/`memory` hint-matching + candidate-listing UX lives in the MCP
      // `hadron_run_task` tool (spec cor:api:060), which resolves to a concrete
      // node before delegating here — the GraphQL surface takes a definite ref.
      const ref = typeof nodeRef === 'string' ? nodeRef.trim() : '';
      // Normalize inputs defensively.
      const args =
        argsInput && typeof argsInput === 'object' && !Array.isArray(argsInput)
          ? (argsInput as Record<string, unknown>)
          : undefined;

      // Normalize args to string values ({{key}} substitution requires strings).
      const stringArgs = args
        ? Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, String(v ?? '')]),
          )
        : undefined;

      // Helper to load a node by URN and render it.
      const auth = {
        clientId: ctx.clientId,
        userId: ctx.userId,
        appId: ctx.appId,
        sessionId: ctx.sessionId,
        roles: ctx.roles,
        organizationId: ctx.organizationId,
      };

      const loadAndRender = async (targetNodeUrn: string) => {
        try {
          assertFullyQualifiedUrn(targetNodeUrn, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) {
            throw new GraphQLError(e.message, {
              extensions: { code: e.name },
            });
          }
          throw e;
        }

        const { memoryUrn: resolvedMemoryUrn, loc } = splitNodeUrn(targetNodeUrn);

        // Find the memory by URN using case-insensitive matching (legacy `:` and canonical `::` forms).
        const parsedMemUrn = parseUrnInput(resolvedMemoryUrn.trim());
        const normalizedMemUrn = normalizeUrnForLookup(parsedMemUrn.value);
        // Build the canonical form from the normalized (legacy) form. #352:
        // shared marker-aware helper so `app-user`/`anon` ids keep their
        // `marker:id` boundary instead of being severed.
        const canonicalMemUrn = legacyMemoryUrnToCanonical(normalizedMemUrn);

        const memory = await ctx.db.memory.findFirst({
          where: {
            OR: [
              { urn: normalizedMemUrn },
              { urn: canonicalMemUrn },
            ],
            deletedAt: null,
          },
          select: { id: true, urn: true },
        });

        if (!memory || !(await canReadMemory(ctx.db, auth, memory.id))) {
          throw new GraphQLError(`Memory not found: "${resolvedMemoryUrn}".`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        const node = await ctx.db.node.findUnique({
          where: { loc_memoryId: { loc, memoryId: memory.id } },
          include: { outgoingEdges: { include: { target: true } } },
        });
        if (!node) {
          throw new GraphQLError(`Node "${targetNodeUrn}" not found.`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        // Decrypt the node and its outgoing edge targets if the memory is encrypted.
        // An edge whose target was deleted can surface a null `target`; filter
        // those out so decryptNodesBatch never dereferences null.
        const nodesToDecrypt = [
          node,
          ...node.outgoingEdges
            .map((e) => e.target)
            .filter((t): t is NonNullable<typeof t> => t != null),
        ];
        await decryptNodesBatch(ctx.db, nodesToDecrypt);

        // #818 review: this assembly is now `assembleRunNodePrompt` in
        // src/lib/runNodeRender.ts, shared with the GraphQL `renderRunNode`
        // preview so a dry run predicts THIS prompt rather than approximating
        // it. Behavior here is unchanged — the Mustache compile, the
        // routing-edge skip and the dangling-target skip all moved verbatim.
        const assembled = await assembleRunNodePrompt(
          { ...node, loc },
          stringArgs ?? undefined,
          {
            memoryUrnOf: async (memoryId) =>
              (await ctx.db.memory.findUniqueOrThrow({ where: { id: memoryId }, select: { urn: true } })).urn,
            compileTemplate: (content, data, memoryId) =>
              compileTemplate(content, data, memoryId, ctx.db, {}),
          },
        );

        // Record usage event (fire-and-forget).
        ctx.db.usageEvent
          .create({
            data: {
              id: generateId(),
              type: 'action-run',
              nodeLoc: loc,
              nodeId: node.id,
              memoryId: node.memoryId, // #796
              appId: ctx.appId ?? null,
              // Same attribution gap as recordUsage above: action-run isn't
              // counted by usageActivity today, but the bucket surface is meant
              // to grow to other event types, and the MCP action-run recorder
              // already sets this.
              userId: ctx.userId ?? null,
              createdBy: ctx.userId ?? null,
              sessionId: ctx.sessionId ?? null,
              actionArgs: stringArgs,
            },
          })
          .catch(() => {});

        return assembled;
      };

      // #529 — when an `appRef` is supplied, EXECUTE the task instead of merely
      // rendering it: mint a MANUAL AppRun for the resolved task node under that
      // App and return the run id (poll `appRun(ref:)` for status + output). The
      // App-run kernel re-renders the same task via this resolver's assemble
      // path, so the two modes stay in lockstep. Without `appRef`, behavior is
      // unchanged — the rendered prompt is returned for an LLM agent to run.
      const dispatch = async (nodeUrn: string): Promise<string> => {
        if (!appRef) return loadAndRender(nodeUrn);
        assertFullyQualifiedUrn(nodeUrn, 'node');
        const run = await triggerManualRun(ctx, {
          appRef,
          entryNodeUrn: nodeUrn,
          // Pass the ORIGINAL structured args (not stringArgs) so eventData keeps
          // its JSON shape for audit + downstream consumers — the assemble path
          // stringifies for Mustache when it renders (#531 review, Copilot).
          eventData: args,
          runAsSelf,
        });
        return run.id;
      };

      if (!ref) {
        throw new GraphQLError('nodeRef is required.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }

      // Resolve the ref (ID or fully-qualified node URN) to a definite node.
      // No `contextMemoryId` at the API boundary (spec 022 FR-007a) — a bare
      // loc without a memory rejects as UrnNotQualifiedError.
      let resolvedNodeId: string;
      try {
        ({ id: resolvedNodeId } = await resolveNodeRef(ctx.db, ref));
      } catch (e) {
        if (e instanceof NodeNotFoundError || e instanceof UrnNotQualifiedError) {
          throw new GraphQLError(e.message, { extensions: { code: 'NOT_FOUND' } });
        }
        throw e;
      }

      // Compose the canonical node URN and hand off to the shared dispatch,
      // which enforces read access (canReadMemory) and renders or executes.
      const resolved = await ctx.db.node.findUnique({
        where: { id: resolvedNodeId },
        select: { loc: true, memory: { select: { urn: true } } },
      });
      if (!resolved) {
        throw new GraphQLError(`Node "${ref}" not found.`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return dispatch(emitNodeUrnV2(resolved.memory.urn, resolved.loc));
    },
};

