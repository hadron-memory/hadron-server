// chatMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { generateId } from '../../../lib/id.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import {
  encryptNodeFields,
  decryptNodeFields,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import {
  formatUrn,
  agentSlugFromUrn,
} from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import {
  evaluateEdgeCondition,
  userMessageFor,
  type MemoryLayerHandle,
} from '../../../lib/edge-conditions/index.js';
import { buildPrismaMemoryLayer } from '../../../lib/edge-conditions/prisma-memory-layer.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { type MemoryVisibility } from '../../../generated/prisma/index.js';
import {
  validateChatScopeInvariants,
  findOrCreateAppClassMemory,
  chatScopeAccessFilter,
  ChatScopeError,
} from './chat-scope.js';
import {
  type Context,
  type SnapshotNode,
  requireRole,
  memoryAccessFilter,
  buildRespondToolSchema,
  pushGoal,
  appendRouteEntry,
  loadPublishedSnapshot,
} from './resolvers.helpers.js';

export const chatMutations = {
    startChat: async (
      _: unknown,
      {
        agentId,
        userId,
        conversationName,
        scope,
        isTestRun,
      }: {
        agentId: string;
        userId?: string;
        conversationName?: string;
        // Spec 017: chosen at chat creation, immutable afterward.
        scope?: 'private' | 'shared';
        // Spec 019: skip cross-cutting side-effects when the call comes
        // from the Tester. Defaults to false; see typeDefs for the
        // full rationale.
        isTestRun?: boolean;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Spec 017: default per FR-003. The GraphQL schema also defaults
      // scope to `private`; the resolver default is a defensive belt.
      const chatScope: 'private' | 'shared' = scope ?? 'private';

      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);

      // Resolve effective user id. The portal calls with userId omitted and
      // we use ctx.userId. The App Key path can pass an externalUserId.
      // Legacy callers with no user get "anonymous".
      const effectiveUserId = userId ?? ctx.userId ?? 'anonymous';

      // 005-agent-subscription FR-002: auto-provision an AgentSubscription
      // on the first user-attributed contact for (user, agent). Idempotent.
      // Skip for the "anonymous" sentinel — there is no User row.
      //
      // Spec 019: also skip when `isTestRun` is true. AgentSubscription is
      // the platform's license-grant entity, narrowed in
      // 2026-05-12-user-installing-app to "user is licensed to interact
      // with this Agent at all." A side-effect of clicking "Test" once
      // silently granting that license re-broadens what we narrowed.
      if (effectiveUserId !== 'anonymous' && !isTestRun) {
        await ensureAgentSubscription(ctx.db, effectiveUserId, resolvedAgentId);
      }

      // Load agent with system memory
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: { memoryItems: { include: { memory: true } } },
      });

      const systemMemoryId = (agent as any).systemMemoryId as string | null;
      if (!systemMemoryId) throw new Error('Agent has no system memory configured');

      // If the agent has a published revision, read conversation structure
      // from the snapshot (pin-to-version). Otherwise read from live nodes.
      const publishedLoc = (agent as any).publishedRevisionLoc as string | null;
      const snapshotLookup = await loadPublishedSnapshot(ctx.db, systemMemoryId, publishedLoc);

      // Helper: find a node either from snapshot or live DB
      async function findSystemNode(loc: string): Promise<SnapshotNode | null> {
        if (snapshotLookup) return snapshotLookup(loc);
        const n = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId!, loc, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return n as SnapshotNode | null;
      }

      // Helper: find all nodes matching a prefix (for conversation selection)
      async function findSystemNodesByPrefix(prefix: string): Promise<SnapshotNode[]> {
        if (snapshotLookup) {
          // Scan the snapshot — loadPublishedSnapshot builds a Map, but
          // we need prefix matching. Re-load the snapshot nodes.
          const revNode = await ctx.db.node.findFirst({
            where: { memoryId: systemMemoryId!, loc: publishedLoc!, deletedAt: null },
            select: { data: true },
          });
          const snap = ((revNode?.data as any)?.snapshot?.nodes as SnapshotNode[]) ?? [];
          return snap.filter((n) => n.loc.startsWith(prefix));
        }
        const nodes = await ctx.db.node.findMany({
          where: { memoryId: systemMemoryId!, loc: { startsWith: prefix }, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return nodes as SnapshotNode[];
      }

      // ── Conversation selection ───────────────────────────────────────
      let convName: string;
      if (conversationName) {
        convName = conversationName;
      } else {
        const allConvs = await findSystemNodesByPrefix('conversations:');
        const topLevel = allConvs.filter((n) => n.loc.split(':').length === 2);
        const nonSetup = topLevel.find((n) => {
          const d = (n.data as Record<string, unknown>) ?? {};
          return d.isSetup !== true && d.isFallback !== true;
        });
        const chosen = nonSetup ?? topLevel[0];
        if (!chosen) throw new Error('Agent has no conversations configured');
        convName = chosen.loc.split(':')[1];
      }

      const convNode = await findSystemNode(`conversations:${convName}`);
      if (!convNode) throw new Error(`Conversation "${convName}" not found in agent's system memory`);

      const convData = (convNode.data as Record<string, unknown>) ?? {};
      const stageOrder = (convData.stageOrder as string[]) ?? [];
      const firstStage = stageOrder[0];
      if (!firstStage) throw new Error(`Conversation "${convName}" has no stages`);

      // Load the first stage
      const stageNode = await findSystemNode(`conversations:${convName}:${firstStage}`);
      const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

      // Load the prompt
      const promptRef = stageData.promptRef as string | undefined;
      let promptContent = '';
      if (promptRef) {
        const promptNode = await findSystemNode(promptRef);
        promptContent = promptNode?.content ?? '';
      } else if (stageNode?.content) {
        promptContent = stageNode.content;
      }

      // ── Target memory selection ──────────────────────────────────────
      // The chat (and its future messages + extracted data) get stored
      // in a user-scoped memory. Four auth paths:
      //   0. (Spec 017) `scope: 'shared'` → app-class memory for the App
      //      the caller is an AppMember of (and whose agentId matches).
      //      JWT-user only in v1; App-key sessions stay private-only per
      //      research.md Q-R2.
      //   1. App Key session with an active sessionId → use session.memoryId
      //   2. JWT user → find-or-create a per-user memory for (agent, ctx.userId)
      //   3. Legacy fallback → first writable memory attached to the agent
      let targetMemoryId: string | null = null;
      if (chatScope === 'shared') {
        // Spec 017 FR-006 + research.md Q-R2: shared chats require a
        // JWT-user AppMember context. Two distinct rejection paths so
        // SC-005 callers see an actionable message:
        //   - MCP App-key session → shared chats not available in v1
        //   - JWT user but not an AppMember → not a member of any App
        //     that installs this Agent.
        if (ctx.appId) {
          throw new ChatScopeError(
            'SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS',
            'Shared chats are not available for MCP App-key sessions — start the chat from a signed-in user surface.',
          );
        }
        if (!ctx.userId) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            'Cannot create a shared chat — sign in as a user that belongs to an App that installs this Agent.',
          );
        }
        // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Find an
        // App that the user is an AppMember of AND that has this Agent
        // installed. With multi-Agent Apps, this may return any App that
        // matches both conditions; today it returns at most one.
        const membership = await ctx.db.appMember.findFirst({
          where: {
            userId: ctx.userId,
            app: {
              appAgents: { some: { agentId: resolvedAgentId } },
              deletedAt: null,
            },
          },
          select: {
            app: { select: { id: true, urn: true, name: true, organizationId: true } },
          },
        });
        if (!membership?.app) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            "Cannot create a shared chat — you are not a member of any App that installs this Agent.",
          );
        }
        // Idempotent: first shared chat under the (App, Agent) pair
        // provisions the app-class memory; subsequent calls reuse it.
        // Keyed per-agent (not per-app) so multi-Agent Apps — the model
        // the 2026-05-12-user-installing-app session settled on — get
        // one shared memory per installed Agent.
        targetMemoryId = await findOrCreateAppClassMemory({
          appId: membership.app.id,
          appUrn: membership.app.urn,
          appName: membership.app.name,
          agentUrn: agent.urn,
          agentName: agent.name,
          organizationId: membership.app.organizationId,
          actingUserId: ctx.userId,
          db: ctx.db,
        });
      } else if (ctx.appId && ctx.sessionId) {
        const session = await ctx.db.session.findUnique({
          where: { id: ctx.sessionId },
          select: { memoryId: true },
        });
        targetMemoryId = session?.memoryId ?? null;
      } else if (ctx.userId) {
        const existing = await ctx.db.memory.findFirst({
          where: {
            userMemoryOfAgentId: resolvedAgentId,
            createdBy: ctx.userId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (existing) {
          targetMemoryId = existing.id;
        } else {
          // Lazily provision a per-user memory for this (agent, user).
          // 008: personal-class memory requires app_id (chk_memory_class_app_id).
          // For a JWT-user chat we resolve the App via App.agent_id matching the
          // chat agent inside the user's accessible orgs. If no matching App
          // exists, we downgrade to a knowledge-class memory for this chat —
          // analogous to the migration's R-3 fallback for unattributed personal
          // memories.
          if (!agent.organizationId) {
            throw new GraphQLError('Lazy per-user memory provisioning is not supported for a user-owned Agent yet.', { extensions: { code: 'BAD_USER_INPUT' } });
          }
          const org = await ctx.db.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          const agentSlug = agentSlugFromUrn(agent.urn);
          // #697 Stage 3: flat single-atom v2 urn (`<org>:<opaqueId>`). The
          // per-user `app-user` scope lives in the row columns (class/userId/
          // userMemoryOfAgentId/appId), not the URN path. Fresh opaque id ⇒ no
          // collision, stored unaliased.
          const memoryUrn = await mintMemoryUrnV2(ctx.db, {
            root: org.urn,
            desiredSlug: opaqueId,
            authorRoot: agentSlug,
          });

          const ownerOrgIds = (
            await ctx.db.orgMember.findMany({
              where: { userId: ctx.userId, deletedAt: null },
              select: { organizationId: true },
            })
          ).map((m) => m.organizationId);

          const matchingApp =
            ownerOrgIds.length > 0
              ? await ctx.db.app.findFirst({
                  where: {
                    appAgents: { some: { agentId: resolvedAgentId } },
                    organizationId: { in: ownerOrgIds },
                    deletedAt: null,
                  },
                  select: { id: true },
                })
              : null;

          const memoryClass: 'personal' | 'knowledge' = matchingApp
            ? 'personal'
            : 'knowledge';
          // 035-visibility-enum-cleanup: personal memory → NULL visibility
          // (class-driven privacy); the no-App knowledge holding memory →
          // ORGANIZATION (owner-gating now rides on userMemoryOfAgentId in
          // getAccessibleMemoryIds, not visibility=PRIVATE).
          const visibility: MemoryVisibility | null = matchingApp
            ? null
            : 'ORGANIZATION';

          const created = await ctx.db.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `${agent.name} — ${ctx.userId}`,
              // 005-agent-subscription: personal-class memory; userId
              // owner-pivot is required by the bidirectional CHECK
              // constraint (class IN (personal,private) ⇔ userId NOT NULL). Note:
              // organizationId stays at agent.organizationId here for
              // the legacy JWT-user path; the spec's FR-015 (use
              // user's personal org) applies to the new App-keyed
              // AgentSubscription auto-provisioning path.
              userId: matchingApp ? ctx.userId : null,
              class: memoryClass,
              visibility,
              userMemoryOfAgentId: resolvedAgentId,
              appId: matchingApp?.id,
              createdBy: ctx.userId,
            },
          });
          targetMemoryId = created.id;
        }
      } else {
        // Legacy: use the agent's first writable attached memory.
        targetMemoryId = agent.memoryItems.find((m) => m.role === 'read-write')?.memory.id ?? null;
      }

      if (!targetMemoryId) {
        throw new Error('No target memory available for this chat');
      }

      // Compile the prompt with Mustache against the target memory's data.
      //
      // Spec 017 D5 — retrieval-time enforcement. compileTemplate spreads
      // the accessFilter AFTER the literal memoryId, so a permissive
      // filter (the caller's full memory set) effectively broadens the
      // ref lookup beyond the chat's holding memory. For SHARED chats
      // we must constrain to the chat's allowedReadSet (excludes any
      // personal memory) — see chat-scope.ts:chatScopeAccessFilter for
      // the full rationale. PRIVATE chats keep the legacy
      // memoryAccessFilter behavior: no regression for existing
      // private-chat templates, which can rely on cross-memory refs
      // within the caller's own access scope.
      let systemMessage = promptContent;
      if (promptContent.includes('{{')) {
        const access =
          chatScope === 'shared'
            ? chatScopeAccessFilter(
                {
                  scope: 'shared',
                  memoryId: targetMemoryId,
                  appId: null, // not needed by allowedReadSet
                  authorUserId: ctx.userId ?? effectiveUserId,
                  agentId: resolvedAgentId,
                },
                {
                  knowledgeMemoryIds: agent.memoryItems
                    .filter((m) => m.memory.class === 'knowledge')
                    .map((m) => m.memory.id),
                  systemMemoryId,
                  appClassMemoryId: targetMemoryId, // for shared, chat.memoryId IS the app-class memory
                },
              )
            : await memoryAccessFilter(ctx);
        systemMessage = await compileTemplate(promptContent, null, targetMemoryId, ctx.db, access);
      }

      // Build tool schema from hierarchical extraction spec
      // (agent-level config node + conversation-level + stage-level)
      const tools = await buildRespondToolSchema(ctx.db, systemMemoryId, convName, stageData);

      // Create chat node in the target memory. The loc needs a unique
      // suffix since two chats started in the same minute by the same user
      // on the same conversation would otherwise collide on (loc, memoryId).
      // Use the last 8 chars of a UUIDv7 (the random portion — the first
      // bytes are a timestamp and collide for calls in the same second).
      //
      // Sanitize `convName` to `[a-zA-Z0-9-]` before embedding in the
      // loc: ':' is the URN structural delimiter, and `myChats` /
      // chat_scope_backfill use `loc NOT LIKE '%:messages%'` to
      // distinguish chat-root nodes from message rows. A user-supplied
      // `conversationName` containing `:messages` would slip out of
      // both filters.
      const safeConvName = convName.replace(/[^a-zA-Z0-9-]/g, '-');
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const shortId = generateId().slice(-8);
      const chatName = `${ts}-${shortId}-${safeConvName}`;
      const chatLoc = `chats:${chatName}`;

      // Ensure the chats parent exists
      try {
        await ctx.db.node.upsert({
          where: { loc_memoryId: { loc: 'chats', memoryId: targetMemoryId } },
          create: {
            id: generateId(), memoryId: targetMemoryId, loc: 'chats',
            name: 'chats', nodeType: 'record',
          },
          update: {},
        });
      } catch { /* exists */ }

      // Look up the conversation's goal for the initial goal stack entry
      const convGoals = (convData.goalDescriptions as string[]) ?? [];
      const initialGoal = convGoals[0] ?? `${convName} conversation`;

      // Create the chat node with initial goal stack and route history.
      // Spec 017: data.scope carries the chosen tier (FR-001/FR-002,
      // immutable post-creation). The target-memory selection above
      // routed the chat into the matching memory class (personal for
      // private, app for shared); data.scope is the denormalization
      // that lets chat-list endpoints surface the tier without joining
      // Memory.class per row (data-model.md §2).
      const initialChatData: Record<string, unknown> = {
        scope: chatScope,
        conversationName: convName,
        stageName: firstStage,
        userId: effectiveUserId,
        startedWithRevision: publishedLoc ?? null,
        messageCount: 0,
        createdAt: new Date().toISOString(),
        goalStack: [{
          description: initialGoal,
          createdBy: 'USER',
          createdAt: new Date().toISOString(),
          conversationUrn: `conversations:${convName}`,
          nodeUrn: `conversations:${convName}:${firstStage}`,
          status: 'ACTIVE',
        }],
        routeHistory: [{
          conversationUrn: `conversations:${convName}`,
          nodeUrn: `conversations:${convName}:${firstStage}`,
          action: 'ENTER',
          trigger: { type: 'CHAT_START', content: convName },
          timestamp: new Date().toISOString(),
        }],
      };

      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: targetMemoryId, loc: chatLoc, name: chatName,
          nodeType: 'record',
          description: `Chat: ${convName}`,
          data: initialChatData as InputJsonValue,
        },
      });

      // Create the messages parent (so the chat subtree is well-formed)
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: targetMemoryId, loc: `${chatLoc}:messages`,
          name: 'messages', nodeType: 'record',
        },
      });

      // Prepend the agent's system prompt to the compiled stage prompt
      if (agent.systemPrompt) {
        systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
      }

      return { chatId: chatLoc, systemMessage, tools, conversationName: convName, stageName: firstStage };
    },

    sendChatMessage: async (
      _: unknown,
      { chatId, userMessage }: { chatId: string; userMessage: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Find the chat node
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      // Decrypt the chat node's metadata (it holds conversationName, stageName,
      // messageCount in `data`) if the memory is encrypted.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};

      // Spec 017 — chat-scope invariant gate (data-model.md §I-1):
      // assert the chat-root node's stored scope matches the holding
      // memory's class before doing any work. `allowMissingScope: true`
      // covers pre-feature chats whose `data.scope` is undefined until
      // the Phase 6 backfill runs (T036/T037); after backfill every chat
      // has an explicit scope and the legacy path falls cold.
      const chatScopeCheckMemory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { class: true },
      });
      validateChatScopeInvariants({
        scope: chatData.scope as 'private' | 'shared' | undefined,
        memoryClass: chatScopeCheckMemory.class,
        allowMissingScope: true,
      });
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;
      const convName = chatData.conversationName as string;
      const stageName = chatData.stageName as string;

      // Save user message. When the memory is encrypted we need to encrypt
      // the message content AND the chat node's updated `data`.
      // The `data.role` field is what the message-history reader uses to
      // decide user-vs-assistant — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      const msgNum = String(messageCount).padStart(3, '0');
      const userId = chatData.userId as string ?? 'user';
      const newMsgFields = encryptNodeFields(
        { content: userMessage, data: { role: 'user' } },
        memEncInfo,
      );
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-${userId}`, name: `${msgNum}-${userId}`,
          nodeType: 'record', content: newMsgFields.content ?? null,
          data: (newMsgFields.data ?? null) as InputJsonValue,
          seq: messageCount,
        },
      });

      // Update message count + lastMessageAt
      const newChatData = {
        ...(chatData as Record<string, unknown>),
        messageCount,
        lastMessageAt: new Date().toISOString(),
      };
      const encUpdate = encryptNodeFields({ content: null, data: newChatData }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (encUpdate.data ?? null) as InputJsonValue },
      });

      // Find the agent that owns this chat. Two ways a memory can belong
      // to an agent: (1) it's a user memory via userMemoryOfAgentId, or
      // (2) legacy — it's attached as a regular memoryItem with role
      // read-write. Check the user-memory path first since that's the
      // canonical portal chat path.
      const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
      if (!memory) throw new Error('Memory not found');
      let agent = null;
      if (memory.userMemoryOfAgentId) {
        agent = await ctx.db.agent.findUnique({
          where: { id: memory.userMemoryOfAgentId },
        });
      } else {
        const legacyAgents = await ctx.db.agent.findMany({
          where: { deletedAt: null, memoryItems: { some: { memoryId: chatNode.memoryId } } },
        });
        agent = legacyAgents.find((a) => (a as any).systemMemoryId) ?? null;
      }
      const systemMemoryId = agent ? (agent as any).systemMemoryId as string : null;

      // Pin to version: if the chat was started with a published revision,
      // read from that snapshot so mid-conversation publishes don't change
      // the prompts/stages under the user.
      const startedWithRevision = chatData.startedWithRevision as string | null;
      const snapshotLookup = systemMemoryId
        ? await loadPublishedSnapshot(ctx.db, systemMemoryId, startedWithRevision)
        : null;

      async function findSystemNode(loc: string): Promise<SnapshotNode | null> {
        if (snapshotLookup) return snapshotLookup(loc);
        if (!systemMemoryId) return null;
        const n = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId, loc, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return n as SnapshotNode | null;
      }

      // If the chat is in a fallback conversation, try to re-route on
      // every turn. The user may have clarified their intent — check if
      // any non-fallback conversation's goalSignals match the message.
      let activeConvName = convName;
      let activeStageName = stageName;

      if (systemMemoryId) {
        const currentConv = await findSystemNode(`conversations:${convName}`);
        const currentConvData = (currentConv?.data as Record<string, unknown>) ?? {};
        if (currentConvData.isFallback === true) {
          // Scan all conversations for a goal match
          const allConvNodes = await (async () => {
            if (snapshotLookup) {
              const revNode = await ctx.db.node.findFirst({
                where: { memoryId: systemMemoryId, loc: startedWithRevision!, deletedAt: null },
                select: { data: true },
              });
              return ((revNode?.data as any)?.snapshot?.nodes as SnapshotNode[] ?? [])
                .filter((n: SnapshotNode) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 2);
            }
            const nodes = await ctx.db.node.findMany({
              where: { memoryId: systemMemoryId, loc: { startsWith: 'conversations:' }, deletedAt: null },
              select: { loc: true, name: true, data: true, nodeType: true, description: true, content: true },
            });
            return nodes.filter((n) => n.loc.split(':').length === 2) as SnapshotNode[];
          })();

          const msgLower = userMessage.toLowerCase();
          let bestMatch: { convName: string; firstStage: string } | null = null;

          for (const conv of allConvNodes) {
            const cd = (conv.data as Record<string, unknown>) ?? {};
            if (cd.isSetup === true || cd.isFallback === true) continue;
            const signals = (cd.goalSignals as string[]) ?? [];
            const goals = (cd.goalDescriptions as string[]) ?? [];
            // Simple keyword matching: check if any signal appears in the message
            const matched = signals.some((s) => msgLower.includes(s.toLowerCase())) ||
              goals.some((g) => msgLower.includes(g.toLowerCase().split(' ').slice(0, 3).join(' ')));
            if (matched) {
              const stages = (cd.stageOrder as string[]) ?? [];
              if (stages[0]) {
                bestMatch = { convName: conv.loc.split(':')[1], firstStage: stages[0] };
                break;
              }
            }
          }

          // If no signal matched but the message is substantive (more than
          // a greeting), try picking the first non-setup, non-fallback
          // conversation as a reasonable default.
          if (!bestMatch && userMessage.trim().split(/\s+/).length >= 4) {
            for (const conv of allConvNodes) {
              const cd = (conv.data as Record<string, unknown>) ?? {};
              if (cd.isSetup === true || cd.isFallback === true) continue;
              const stages = (cd.stageOrder as string[]) ?? [];
              if (stages[0]) {
                bestMatch = { convName: conv.loc.split(':')[1], firstStage: stages[0] };
                break;
              }
            }
          }

          if (bestMatch) {
            activeConvName = bestMatch.convName;
            activeStageName = bestMatch.firstStage;
            // Update the chat node to reflect the re-route
            const updatedChatData = {
              ...(chatData as Record<string, unknown>),
              conversationName: activeConvName,
              stageName: activeStageName,
              messageCount,
              lastMessageAt: new Date().toISOString(),
            };
            appendRouteEntry(updatedChatData, {
              conversationUrn: `conversations:${activeConvName}`,
              nodeUrn: `conversations:${activeConvName}:${activeStageName}`,
              action: 'ENTER',
              trigger: { type: 'FALLBACK_REROUTE', content: userMessage.slice(0, 100) },
            });
            const encReroute = encryptNodeFields({ content: null, data: updatedChatData }, memEncInfo);
            await ctx.db.node.update({
              where: { id: chatNode.id },
              data: { data: (encReroute.data ?? null) as InputJsonValue },
            });
          }
        }
      }

      // Load current stage
      let systemMessage = '';
      let tools = null;

      if (systemMemoryId && activeConvName && activeStageName) {
        const stageNode = await findSystemNode(`conversations:${activeConvName}:${activeStageName}`);
        const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

        // Load prompt
        const promptRef = stageData.promptRef as string | undefined;
        let promptContent = '';
        if (promptRef) {
          const promptNode = await findSystemNode(promptRef);
          promptContent = promptNode?.content ?? '';
        } else if (stageNode?.content) {
          promptContent = stageNode.content;
        }

        // Compile with data.
        //
        // Spec 017 D5 — retrieval-time enforcement: for SHARED chats,
        // narrow the access filter to the chat's allowedReadSet so a
        // Mustache reference cannot resolve against the caller's
        // personal memory. PRIVATE chats keep the legacy
        // memoryAccessFilter behavior. See chat-scope.ts:
        // chatScopeAccessFilter for the full rationale.
        const isShared = chatData.scope === 'shared';
        let access: Record<string, unknown>;
        if (isShared && agent) {
          const knowledgeItems = await ctx.db.agentMemoryItem.findMany({
            where: { agentId: agent.id, memory: { class: 'knowledge', deletedAt: null } },
            select: { memoryId: true },
          });
          access = chatScopeAccessFilter(
            {
              scope: 'shared',
              memoryId: chatNode.memoryId,
              appId: null,
              authorUserId: (chatData.userId as string) ?? '',
              agentId: agent.id,
            },
            {
              knowledgeMemoryIds: knowledgeItems.map((k) => k.memoryId),
              systemMemoryId,
              appClassMemoryId: chatNode.memoryId, // chat IS in the app-class memory
            },
          );
        } else {
          access = await memoryAccessFilter(ctx);
        }
        if (promptContent.includes('{{')) {
          systemMessage = await compileTemplate(promptContent, null, chatNode.memoryId, ctx.db, access);
        } else {
          systemMessage = promptContent;
        }

        // Prepend agent system prompt
        if (agent?.systemPrompt) {
          systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
        }

        // Build tools from hierarchical extraction spec
        tools = await buildRespondToolSchema(ctx.db, systemMemoryId, activeConvName, stageData);
      }

      // Build message history (recent messages). For encrypted memories,
      // decrypt each message's content before formatting.
      const messages = await ctx.db.node.findMany({
        where: { loc: { startsWith: `${chatId}:messages:` }, memoryId: chatNode.memoryId, deletedAt: null },
        orderBy: { seq: 'asc' },
        take: 50,
        select: { loc: true, content: true, data: true, seq: true, nodeType: true, memoryId: true },
      });
      if (memEncInfo.isEncrypted) {
        for (const m of messages) decryptNodeFields(m, memEncInfo);
      }

      // Role detection is agent-agnostic (Constitution Invariant #14):
      // - Primary: read `data.role` from the message node. New messages
      //   created post-cleanup always carry this.
      // - Fallback: the loc/name suffix produced by the message-create
      //   path is deterministic — assistant messages always end with
      //   `-assistant`. Anything else is a user message (or a summary,
      //   which we treat as user to preserve pre-cleanup behavior).
      // - Legacy messages without `data.role` and without the suffix
      //   (vanishingly rare; only present in pre-006 fixtures) default
      //   to 'user'.
      const messageHistory = messages.map((m) => {
        const data = (m.data as { role?: unknown } | null) ?? null;
        const explicitRole = typeof data?.role === 'string' ? data.role : null;
        const role: 'user' | 'assistant' =
          explicitRole === 'assistant'
            ? 'assistant'
            : explicitRole === 'user'
              ? 'user'
              : (m.loc.split(':').pop() ?? '').endsWith('-assistant')
                ? 'assistant'
                : 'user';
        return { role, content: m.content ?? '' };
      });

      // Check if summarization is needed
      const triggerCount = 20; // TODO: read from agent/conversation config
      let summarizationNeeded = null;
      if (messageCount > 0 && messageCount % triggerCount === 0) {
        summarizationNeeded = {
          messageCount: triggerCount,
          prompt: 'Summarize the following conversation messages. Focus on key facts, decisions made, and any action items. Keep the summary concise but include all important details.',
        };
      }

      return { systemMessage, tools, messageHistory, summarizationNeeded };
    },

    processChatResponse: async (
      _: unknown,
      { chatId, toolResponse }: { chatId: string; toolResponse: Record<string, unknown> },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};

      // Spec 017 — chat-scope invariant gate (see sendChatMessage for
      // the rationale). The write side (extracted data lands in
      // chatNode.memoryId, line below at line ~4055) is bounded by the
      // chat's holding memory by construction; the validate-call here
      // ensures no corrupted chat-root can slip past.
      //
      // ── Phase-4/T015 (deferred from Phase 3) ──────────────────────
      // When the shared-chat branch lands and tools that accept a
      // memoryUrn/memoryId argument are added to the chat-tool schema,
      // this is the point where each such tool-handler dispatch MUST
      // pass through `allowedReadSet(chat)` and reject any out-of-set
      // reference before any DB content read. The chat-API surface
      // today only exposes the `respond` tool (which takes no memory
      // argument), so the gate has no current target — but the hook
      // belongs here.
      const chatScopeCheckMemory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { class: true },
      });
      validateChatScopeInvariants({
        scope: chatData.scope as 'private' | 'shared' | undefined,
        memoryClass: chatScopeCheckMemory.class,
        allowMissingScope: true,
      });

      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;

      const message = (toolResponse.message as string) ?? '';
      const data = toolResponse.data as Record<string, unknown> | undefined;
      const nextStage = toolResponse.next_stage as string | undefined;
      const onTrack = toolResponse.onTrack as boolean | undefined;
      const offTrackReason = toolResponse.offTrackReason as string | undefined;

      // Save assistant message (encrypted when memory is encrypted).
      // `data.role = 'assistant'` is what the message-history reader uses
      // to identify the role — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      const msgNum = String(messageCount).padStart(3, '0');
      const encMsg = encryptNodeFields(
        { content: message, data: { role: 'assistant' } },
        memEncInfo,
      );
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-assistant`, name: `${msgNum}-assistant`,
          nodeType: 'record', content: encMsg.content ?? null,
          data: (encMsg.data ?? null) as InputJsonValue,
          seq: messageCount,
        },
      });

      // Save extracted data to memory's default data node
      if (data && Object.keys(data).length > 0) {
        const dataNode = await ctx.db.node.findFirst({
          where: { loc: 'data', memoryId: chatNode.memoryId, deletedAt: null },
        });
        if (dataNode) {
          if (memEncInfo.isEncrypted) decryptNodeFields(dataNode, memEncInfo);
          const existingData = (dataNode.data as Record<string, unknown>) ?? {};
          const merged = { ...existingData, ...data };
          const encData = encryptNodeFields({ content: null, data: merged }, memEncInfo);
          await ctx.db.node.update({
            where: { id: dataNode.id },
            data: { data: (encData.data ?? null) as InputJsonValue },
          });
        } else {
          const encNew = encryptNodeFields({ content: null, data }, memEncInfo);
          await ctx.db.node.create({
            data: {
              id: generateId(), memoryId: chatNode.memoryId,
              loc: 'data', name: 'data', nodeType: 'info',
              data: (encNew.data ?? null) as InputJsonValue,
            },
          });
        }
      }

      // Handle stage transition + edge evaluation
      let stageTransitioned = false;
      let newStageName: string | null = null;
      let conversationHandoff: string | null = null;
      const updatedData: Record<string, unknown> = {
        ...(chatData as Record<string, unknown>),
        messageCount,
        lastMessageAt: new Date().toISOString(),
      };

      // 1. Explicit stage transition from the LLM
      if (nextStage && nextStage !== chatData.stageName) {
        updatedData.stageName = nextStage;
        stageTransitioned = true;
        newStageName = nextStage;
        appendRouteEntry(updatedData, {
          nodeUrn: `conversations:${chatData.conversationName}:${nextStage}`,
          conversationUrn: `conversations:${chatData.conversationName}`,
          action: 'ENTER',
          trigger: { type: 'STAGE_TRANSITION', content: `next_stage: ${nextStage}` },
        });
      }

      // 2. Evaluate on_complete edges when the conversation ends
      //    (next_stage is null and we're at the last stage)
      if (!nextStage || nextStage === null) {
        // Find the agent's system memory to look up edges
        const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
        const agentId = memory?.userMemoryOfAgentId;
        if (agentId) {
          const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
          const sysMemId = (agent as any)?.systemMemoryId as string | null;
          if (sysMemId) {
            // Find the current stage node and look for outgoing edges
            const currentStageLoc = `conversations:${chatData.conversationName}:${chatData.stageName}`;
            const stageNode = await ctx.db.node.findFirst({
              where: { memoryId: sysMemId, loc: currentStageLoc, deletedAt: null },
              select: { id: true },
            });
            if (stageNode) {
              const edges = await ctx.db.edge.findMany({
                where: { sourceId: stageNode.id, deletedAt: null },
                orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
                include: { target: { select: { loc: true, data: true } } },
              });
              // Load agent config once for the agent.* scope.
              const agentConfigNode = await ctx.db.node.findFirst({
                where: { memoryId: sysMemId, loc: 'config', deletedAt: null },
                select: { data: true },
              });
              const agentBag: Record<string, unknown> = {
                config: (agentConfigNode?.data as Record<string, unknown> | null) ?? {},
              };
              // Resolve the system memory's slug-path URN once so error-side
              // sourceNodeUrn composition stays canonical (urn:node:<mem>:<loc>)
              // instead of the legacy urn:memory:<PK>:<loc> form (issue #99).
              // TODO(#99-followup): this lookup-and-format pattern is now
              // duplicated with src/mcp/server.ts:nodeUrn(). Extract a shared
              // composer (likely a small package) per the audit's
              // recommendation in issue #99.
              const sysMem = await ctx.db.memory.findUnique({
                where: { id: sysMemId },
                select: { urn: true },
              });
              const sysMemUrn = sysMem?.urn ?? sysMemId;
              // Build the memory cascade for this turn:
              //   Layer A (defaults): agent's system memory — holds
              //     conversation/stage definitions and any agent-wide
              //     defaults under `loc: 'data'`. The source node lives
              //     here, so its parent-chain walk also happens here.
              //   Layer B (overrides): the user's per-user memory.
              //     Wins over Layer A on conflict (CSS cascade per spec
              //     FR-008/FR-009). For single-memory cases where the
              //     chat memory IS the system memory, we skip the
              //     duplicate layer.
              const memoryLayers: MemoryLayerHandle[] = [];
              memoryLayers.push(await buildPrismaMemoryLayer(
                ctx.db, 'edge-memory', sysMemId, currentStageLoc,
              ));
              if (chatNode.memoryId !== sysMemId) {
                memoryLayers.push(await buildPrismaMemoryLayer(
                  ctx.db, 'user-memory', chatNode.memoryId, currentStageLoc,
                ));
              }
              for (const edge of edges) {
                const edgeData = (edge.data as Record<string, unknown>) ?? {};
                const timing = edgeData.timing as string ?? 'on_complete';
                if (timing !== 'on_complete' && timing !== 'always') continue;

                // Evaluate the JSONLogic condition (Edge.condition column).
                // null = always fires.
                if (edge.condition !== null && edge.condition !== undefined) {
                  const evalResult = await evaluateEdgeCondition({
                    condition: edge.condition,
                    edge: {
                      id: edge.id,
                      sourceNodeUrn: formatUrn('node', `${sysMemUrn}:${currentStageLoc}`),
                    },
                    memoryLayers,
                    chat: {
                      message_count: messageCount,
                      conversation_name: chatData.conversationName,
                      stage: chatData.stageName,
                    },
                    agent: agentBag,
                    messageData: data ?? undefined,
                  });
                  if (!evalResult.ok) {
                    // FR-014/FR-015/FR-016: fail loud rather than silently
                    // firing or skipping the edge. Structured log carries
                    // edge id, field, memory URN, etc.; the user-facing
                    // message comes from the i18n-ready mapping.
                    console.error(
                      `[edge-conditions] evaluation failed`,
                      {
                        edgeId: edge.id,
                        code: evalResult.error.code,
                        message: evalResult.error.message,
                        detail: evalResult.error.detail,
                      },
                    );
                    const userMsg = userMessageFor(evalResult.error);
                    throw new GraphQLError(userMsg.text, {
                      extensions: {
                        code: 'EDGE_CONDITION_FAILED',
                        reason: evalResult.error.code,
                        messageId: userMsg.id,
                        detail: evalResult.error.detail,
                      },
                    });
                  }
                  if (!evalResult.fired) continue;
                }

                // Edge fires! Check behavior
                const targetLoc = edge.target?.loc;
                if (!targetLoc) continue;

                const behavior = edgeData.behavior as string ?? 'transition';

                if (targetLoc.startsWith('conversations:') && targetLoc.split(':').length === 2) {
                  // Target is a conversation — conversation handoff
                  const targetConvName = targetLoc.split(':')[1];

                  if (behavior === 'detour') {
                    // Push current goal, transition to the detour conversation
                    pushGoal(updatedData, {
                      description: (edgeData.label as string) ?? `Detour to ${targetConvName}`,
                      createdBy: 'ASSISTANT',
                      conversationUrn: targetLoc,
                    });
                  }

                  // Switch to the target conversation's first stage
                  const targetConv = await ctx.db.node.findFirst({
                    where: { memoryId: sysMemId, loc: targetLoc, deletedAt: null },
                    select: { data: true },
                  });
                  const targetConvData = (targetConv?.data as Record<string, unknown>) ?? {};
                  const targetStages = (targetConvData.stageOrder as string[]) ?? [];
                  const targetFirstStage = targetStages[0];

                  if (targetFirstStage) {
                    updatedData.conversationName = targetConvName;
                    updatedData.stageName = targetFirstStage;
                    conversationHandoff = targetConvName;
                    stageTransitioned = true;
                    newStageName = targetFirstStage;

                    appendRouteEntry(updatedData, {
                      conversationUrn: targetLoc,
                      nodeUrn: `${targetLoc}:${targetFirstStage}`,
                      action: 'ENTER',
                      edgeUrn: edge.id,
                      trigger: {
                        type: behavior === 'detour' ? 'DETOUR_EDGE' : 'TRANSITION_EDGE',
                        content: (edgeData.label as string) ?? undefined,
                      },
                    });
                  }
                  break; // Only follow one edge
                }
              }
            }
          }
        }
      }

      // 3. Track onTrack status
      if (onTrack === false) {
        updatedData.lastOffTrackReason = offTrackReason ?? 'unspecified';
        updatedData.lastOffTrackAt = new Date().toISOString();
      }

      const encUpdate = encryptNodeFields({ content: null, data: updatedData }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (encUpdate.data ?? null) as InputJsonValue },
      });

      return {
        displayMessage: message,
        stageTransitioned,
        newStageName,
        conversationHandoff,
        chatEnded: false,
        onTrack: onTrack ?? true,
        offTrackReason: offTrackReason ?? null,
      };
    },

    saveChatSummary: async (
      _: unknown,
      { chatId, summary }: { chatId: string; summary: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const messageCount = (chatData.messageCount as number) ?? 0;
      const summaryName = `${String(messageCount).padStart(3, '0')}a-summary`;

      const encSummary = encryptNodeFields({ content: summary, data: null }, memEncInfo);
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${summaryName}`, name: summaryName,
          nodeType: 'abstract', content: encSummary.content ?? null, seq: messageCount + 1,
          tags: ['summary'],
        },
      });

      return true;
    },

    // ── Agent AI config (org ADMIN) ─────────────────────────────────

    updateChatTitle: async (
      _: unknown,
      { chatId, title }: { chatId: string; title: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — write-ownership is author-only regardless of scope
      // (per design-discussion D7). A non-author AppMember of a shared
      // chat can read it but not rename it.
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      const isAuthor = chatNode.createdBy === ctx.userId;
      if (!isAdmin && !isAuthor) {
        // Legacy fallback: pre-feature chats may not have createdBy set
        // on the chat-root node (it was added later). Fall back to the
        // historical "memory owner" check for those.
        if (chatNode.createdBy === null) {
          const legacyMem = await ctx.db.memory.findUniqueOrThrow({
            where: { id: chatNode.memoryId },
            select: { createdBy: true },
          });
          if (legacyMem.createdBy !== ctx.userId) throw new Error('Forbidden');
        } else {
          throw new Error('Forbidden');
        }
      }
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);
      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const updated = { ...chatData, title: title.trim() };
      const enc = encryptNodeFields({ content: null, data: updated }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (enc.data ?? null) as InputJsonValue },
      });
      return true;
    },

    deleteChat: async (_: unknown, { chatId }: { chatId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — author-only deletion (D7). Legacy fallback to
      // memory owner for pre-feature chats that lack chat-root createdBy.
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      const isAuthor = chatNode.createdBy === ctx.userId;
      if (!isAdmin && !isAuthor) {
        if (chatNode.createdBy === null) {
          const legacyMem = await ctx.db.memory.findUniqueOrThrow({
            where: { id: chatNode.memoryId },
            select: { createdBy: true },
          });
          if (legacyMem.createdBy !== ctx.userId) throw new Error('Forbidden');
        } else {
          throw new Error('Forbidden');
        }
      }
      // Soft-delete the chat node and all its message children by loc prefix
      await ctx.db.node.updateMany({
        where: {
          memoryId: chatNode.memoryId,
          OR: [
            { id: chatNode.id },
            { loc: { startsWith: `${chatId}:` } },
          ],
        },
        data: { deletedAt: new Date(), deletedBy: ctx.userId },
      });
      return true;
    },

    // ── App management (org ADMIN) ──────────────────────────────────

};

