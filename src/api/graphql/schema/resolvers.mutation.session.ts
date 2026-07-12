// sessionMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
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
  composeNodeUrn,
  normalizeUrnForLookup,
  legacyMemoryUrnToCanonical,
  agentSlugFromUrn,
} from '../../../lib/urn.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { isRoutingName, routingNameOf } from '../../../lib/runner/selectNextEdge.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { triggerManualRun } from './resolvers.appRun.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { serializeJson } from '../../../integrations/db/provider.js';
import { deleteToolConnection, type ToolCalendarEvent } from '../../../lib/emailClient.js';
import {
  type Context,
  requireOrgRole,
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
      return ctx.db.session.create({
        data: {
          id: input.id,
          type: (input.type as any) ?? 'DEVELOPER',
          appId: ctx.appId,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
          customerId: input.customerId,
          language: input.language,
          llmModel: input.llmModel,
          parentSessionId: input.parentSessionId,
          prevSessionId: input.prevSessionId,
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
      const node = event.nodeLoc
        ? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
          ?? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc } })
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
          appId: ctx.appId,
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
          user = await ctx.db.user.create({
            data: {
              externalAppId: ctx.appId,
              externalId: externalUserId,
              identityProvider: 'APP',
              createdBy: ctx.appId,
            },
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
          // #352: canonical `app-user` per-user role marker (was `user`).
          const memoryUrn = `${org.urn}:${agentSlugFromUrn(agent.urn)}:app-user:${opaqueId}`;
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
        const memoryUrn = `${org.urn}:${agentSlug}:anon:${opaqueId}`;
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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
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

      await ctx.db.node.create({
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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
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

      // Delete all current non-revision nodes in the system memory
      await ctx.db.node.updateMany({
        where: {
          memoryId: sysMemId,
          deletedAt: null,
          NOT: { loc: { startsWith: 'revisions' } },
        },
        data: { deletedAt: new Date() },
      });

      // Delete all edges in the system memory
      const currentNodeIds = (await ctx.db.node.findMany({
        where: { memoryId: sysMemId },
        select: { id: true },
      })).map((n) => n.id);
      await ctx.db.edge.updateMany({
        where: { sourceId: { in: currentNodeIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Restore nodes from snapshot (upsert to handle soft-deleted rows
      // that still hold the unique (loc, memoryId) constraint)
      const locToId = new Map<string, string>();
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
        const upserted = await ctx.db.node.upsert({
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
          await ctx.db.edge.create({
            data: {
              id: generateId(),
              memoryId: sysMemId,
              sourceId,
              targetId,
              loc: edgeLoc,
              name: edgeName,
              description: (e.description as string | null) ?? null,
              isRunnable: (e.isRunnable as boolean | null) ?? null,
              data: (e.data ?? null) as InputJsonValue,
            },
          });
        }
      }

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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

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
      const { event } = await runOwnedEmailOperation<{ event: ToolCalendarEvent }>(
        ctx,
        connectionRef,
        'respond-to-event',
        {
          eventId,
          calendarId: calendarId ?? undefined,
          // NONE is not settable — the tool's schema rejects it with a typed
          // validation_error (the EmailFlag COMPLETE precedent).
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

        // Render the node with Mustache template compilation and inlined edges.
        let actionContent = node.content || '';
        if (actionContent.includes('{{')) {
          // Use compileTemplate for proper Mustache template handling.
          // Pass stringArgs as the node data for variable substitution.
          actionContent = await compileTemplate(actionContent, stringArgs ?? null, memory.id, ctx.db, {});
        }

        const topicSections: string[] = [];
        for (const edge of node.outgoingEdges) {
          // Flow-routing edges (`next*`, plan-multi-node D-MN-4) are the
          // walker's rails, not references — inlining the NEXT step's prompt
          // into this one would pollute every hop of a multi-node flow.
          if (isRoutingName(routingNameOf(edge, loc))) continue;
          // target can be null for a dangling edge (deleted target row) — skip.
          const target = edge.target;
          if (target?.content) {
            // Compose the target node URN directly.
            const targetMemory = await ctx.db.memory.findUniqueOrThrow({
              where: { id: target.memoryId },
              select: { urn: true },
            });
            const targetUrn = composeNodeUrn(targetMemory.urn, target.loc);
            topicSections.push(
              `## Node: ${target.name} (${targetUrn})\n\n${target.content}`,
            );
          }
        }

        // Record usage event (fire-and-forget).
        ctx.db.usageEvent
          .create({
            data: {
              id: generateId(),
              type: 'action-run',
              nodeLoc: loc,
              nodeId: node.id,
              appId: ctx.appId ?? null,
              createdBy: ctx.userId ?? null,
              sessionId: ctx.sessionId ?? null,
              actionArgs: stringArgs,
            },
          })
          .catch(() => {});

        const parts = [`# Node: ${node.name}\n\n${actionContent}`];
        if (topicSections.length > 0) {
          parts.push(
            '---\n\n# Referenced Nodes\n\n' +
              topicSections.join('\n\n---\n\n'),
          );
        }
        return parts.join('\n\n');
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
      return dispatch(composeNodeUrn(resolved.memory.urn, resolved.loc));
    },
};

