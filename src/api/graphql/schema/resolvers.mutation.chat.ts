import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { personalOrgAgentLicenseHolds, personalOrgAgentServeAllowed } from '../../../lib/auth/personalOrgAgentInstall.js';
import { bootPromptRefusal } from '../../../lib/bootPrompt/refusal.js';
import { chatNotFoundError } from '../../../lib/chatNotFound.js';
import { ENGINE_KEYS, engineState, readTurnNames } from '../../../lib/chatRootEngineState.js';
import { appInstallationWhere } from '../../../lib/appInstallations.js';
// chatMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { assertAuthoring, attestedAuthoring, authoringFromRequest } from '../../../lib/authoringAttestation.js';
import { authoredContentChanged, clearNodeAuthorship } from '../../../lib/nodeAuthorship.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  editorFromAuth,
  ensureCurrentNodeRevisionInTransaction,
  revisionStateHashRefreshMarker,
} from '../../../lib/nodeRevisionSnapshot.js';
import { LINK_CAP_MEMORY_SELECT, linkWriteTargetAdmits } from '../../../lib/auth/agentMemoryLinkCap.js';
import { isDeepStrictEqual } from 'node:util';
import { clientReportedChatModel } from '../../../lib/bootPrompt/chatModel.js';
import { generateId } from '../../../lib/id.js';
import { lockAncestorsForCreateMany, lockLocForWrite, lockPathForCreateUnder } from '../../../lib/nodeSubtreeLock.js';
import {
  DATA_HOST_MEMORY_SELECT,
  declaredMemoryWideFields,
  isMultiHumanChatHost,
  mergeTurnExtraction,
} from '../../../lib/memoryDataView.js';
import {
  appendChatMessage,
  updateChatRootData,
  withChatRootLock,
  type ChatTxRunner,
} from '../../../lib/chatRoot.js';
import { mintMemoryUrnV2 } from '../../../lib/mintMemoryUrnV2.js';
import { translateSessionExpired } from '../../../lib/channels.js';
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
import { chargeRequestServed } from '../../../lib/includes/resolveNodeContent.js';
import { applyPlatformVariables } from '../../../lib/personaDescription.js';
import { noWorkerVariables } from '../../../lib/bootPrompt/variables.js';
import { recordServedPrompt, resolveServedBootPrompt, type ServedBootPrompt } from '../../../lib/bootPrompt/serve.js';
import {
  evaluateEdgeCondition,
  userMessageFor,
  type MemoryLayerHandle,
} from '../../../lib/edge-conditions/index.js';
import { buildPrismaMemoryLayer } from '../../../lib/edge-conditions/prisma-memory-layer.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError, UserNotFoundError } from '../../../lib/entityRef/errors.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { appKeyMayActFor, appKeySessionMatchesAgent, canChatWithAgent, chatAuthorityAnchors, chatCarrierApps } from './agentChatAccess.js';
import { withAuthorizedMemoryTx, withAuthorizedTx } from './authorizedTx.js';
import { activeAppInstallLicenseIdsForAgent, isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { type MemoryVisibility } from '../../../generated/prisma/index.js';
import {
  validateChatScopeInvariants,
  findOrCreateAppClassMemory,
  chatScopeAccessFilter,
  sharedChatKnowledgeMemoryIds,
  ChatScopeError,
} from './chat-scope.js';
import { chatLocFilter, pickChatNode } from '../../../lib/chatLoc.js';
import { reportPartialTurn } from '../../../lib/chatPartialTurn.js';
import { recordNodeUsage, recordNodeWrite } from '../../../lib/usageRecorder.js';
import {
  type Context,
  requireRole,
  requireMemoryWriteAccess,
  memoryAccessFilter,
  buildRespondToolSchema,
  pushGoal,
  appendRouteEntry,
  rethrowAiConfigTyped,
} from './resolvers.helpers.js';
import { normalizeChatAiConfigChoice } from '../../../lib/chatbotAiConfig.js';
import { assertNoMintedSpecRemoval } from '../../../lib/mintedSpecPermanence.js';
import { refuseDecisionFamily } from '../../../lib/decisions/index.js';
import { assertBatchMutable } from '../../../lib/bulkMutationGate.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { isNodeLocUniqueViolation } from '../../../lib/prismaErrors.js';
import { unauthenticatedError } from '../../../lib/refusals.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';
import { pickUnnamedStartConversation, topLevelConversations } from '../../../lib/chatConversationOrder.js';
import { loadChatScript, type ChatScript } from '../../../lib/chatScript.js';
import { decideNextStage, conversationStageOrder } from '../../../lib/chatRouting/nextStage.js';

/**
 * How many of a chat's most recent messages `sendChatMessage` hands the model.
 *
 * Named rather than inline because it is a CEILING on the model's view of the
 * conversation, not a page size: past it the transcript is silently truncated,
 * and #1111 is what that costs when the truncation takes the wrong end. A
 * summary-aware assembly (feeding `saveChatSummary`'s output back in place of
 * the messages it covers) is the real answer and is deliberately not this.
 */
const MODEL_HISTORY_LIMIT = 50;

/** A carrier App appeared after the anchors were chosen (#1585, Chip); retry with fresh anchors. */
class ChatAuthorityScopeChanged extends Error {}

/**
 * #1717 (Diego on #1725): the transaction every chat-by-loc write runs in. The
 * pre-transaction `requireMemoryWriteAccess` only fails fast; a membership
 * revoked while the write waited for its lock would still have been admitted.
 * So the gate runs again on the transaction, after the authority anchors a
 * revoker holds exclusively (the memory, its owners, the caller, and the App
 * an app-class memory belongs to) and before any chat lock or write.
 */
async function chatWriteTx(
  ctx: Context,
  memoryId: string,
): Promise<ChatTxRunner> {
  const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { appId: true, isEncrypted: true } });
  const anchors = memory?.appId ? [{ kind: 'app' as const, id: memory.appId }] : [];
  return (fn) => withAuthorizedMemoryTx(
    ctx, memoryId, anchors,
    async (txCtx) => {
      await requireMemoryWriteAccess(txCtx, memoryId);
      const fresh = await txCtx.db.memory.findUnique({ where: { id: memoryId }, select: { isEncrypted: true } });
      if (!fresh || fresh.isEncrypted !== memory?.isEncrypted) throw new GraphQLError('Chat authority changed; retry with fresh context.', { extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
    },
    (tx) => fn(tx),
  );
}

/**
 * #2047 (S10) — what a chat is served: the compiled boot prompt (approved revision, as-is), its platform
 * variables bound to the Agent (a chat binds no worker). Resolved BEFORE the chat is created or answered, so a refusal
 * is the same typed refusal a bind gives and leaves no chat behind. The App is the one the chat's holding memory belongs
 * to; a chat held in a memory with no App serves the Agent's own pointer and has no App to record under.
 */
export async function serveChatPrompt(
  db: Context['db'],
  agent: { id: string; name: string; urn: string; personaRole: string | null },
  appId: string | null,
  llmModel: string | null,
  caller: Context,
): Promise<{ text: string; served: ServedBootPrompt; variables: Record<string, string> }> {
  // The caller receives this text in systemMessage, so App participation alone cannot grant org text; a key with no
  // person is judged on the owner's licence (#3653).
  const current = await db.agent.findUnique({ where: { id: agent.id }, select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true } });
  if (!current || !(await canChatWithAgent(caller, current))) throw new AgentNotFoundError(agent.id);
  if (appId) {
    const app = await db.app.findUnique({ where: { id: appId }, select: { organizationId: true, ownerUserId: true } });
    if (app && !(await personalOrgAgentServeAllowed(db, app, agent.id, caller.userId))) {
      throw new AgentNotFoundError(agent.id);
    }
  }
  const served = await resolveServedBootPrompt(db, { surface: 'chat', appId, agent: { id: agent.id, name: agent.name } });
  const variables = noWorkerVariables(agent, llmModel);
  // #3096 / cor:dmo:150:08: provenance label is record metadata, never another prompt variable.
  return { text: applyPlatformVariables(served.content, variables), served, variables: {
    ...variables, 'session.llmModel.source': llmModel === null ? 'unspecified' : 'client-reported',
  } };
}

/**
 * #2047 (R37) — a chat records what it was served again only when the served revision or its filled variable values CHANGED (#3096). (chat, ordinal) is unique, so
 * two concurrent turns can race for one ordinal; the loser must not assume the winner recorded ITS revision (the two may
 * have resolved different revisions around an approval). It re-reads the latest record and retries at the next ordinal
 * until the latest record matches what this turn served, so a served revision or filled value set is never missing from the audit history.
 */
export async function recordChatServedIfChanged(
  db: Context['db'],
  chatId: string,
  agentId: string,
  appId: string | null,
  chatServed: { served: ServedBootPrompt; variables: Record<string, string> },
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await db.servedPrompt.findFirst({ where: { chatId }, orderBy: { ordinal: 'desc' }, select: { compiledNodeId: true, servedRevSeq: true, ordinal: true, variables: true } });
    if (last && last.compiledNodeId === chatServed.served.compiledNodeId && last.servedRevSeq === chatServed.served.servedRevSeq && isDeepStrictEqual(last.variables, chatServed.variables)) return;
    try {
      await recordServedPrompt(db, { kind: 'CHAT', chatId, appId, agentId, ordinal: (last?.ordinal ?? 0) + 1 }, chatServed.served, chatServed.variables);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error('chat served-prompt record kept conflicting');
}

export const chatMutations = {
    startChat: async (
      _: unknown,
      {
        agentId,
        userId,
        conversationName,
        scope,
        isTestRun,
        llmModel,
        aiConfigChoice,
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
        llmModel?: string | null;
        // #3957 (cor:dmo:050:10): the chat's AI config choice, stored with it.
        aiConfigChoice?: string | null;
      },
      ctx: Context,
    ) => {
      // #1581 review (Atilla, Copilot): a pure App key carries no platform
      // roles. It is authorized by canChatWithAgent's App-install rule below,
      // not by a role, so the role check applies to user principals only.
      const pureAppKey = Boolean(ctx.appId && !ctx.userId);
      if (!pureAppKey) requireRole(ctx, 'READER');
      // Validate before provisioning memory, nodes or a subscription. This input grants nothing.
      const reportedModel = clientReportedChatModel(llmModel);

      // Spec 017: default per FR-003. The GraphQL schema also defaults
      // scope to `private`; the resolver default is a defensive belt.
      const chatScope: 'private' | 'shared' = scope ?? 'private';

      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);

      // #1581: the caller must be able to reach this Agent BEFORE anything is
      // read from it (its system prompt is returned below) or provisioned for
      // it. Refused exactly like an unknown Agent, so it discloses nothing.
      const gateRow = await ctx.db.agent.findUnique({
        where: { id: resolvedAgentId },
        select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
      });
      if (!gateRow || !(await canChatWithAgent(ctx, gateRow))) {
        // #1148: an owner already knows their own retained install. Give its licence refusal,
        // without widening the Agent read gate or exposing another person's installation.
        if (gateRow && ctx.userId && !ctx.impersonation && !isRunPrincipal(ctx)) {
          const knownInstall = await ctx.db.app.findFirst({where:{
            ownerUserId:ctx.userId,organizationId:null,deletedAt:null,uninstalledAt:null,
            ...(ctx.appId ? {id:ctx.appId} : {}),appAgents:{some:{agentId:resolvedAgentId}},
          },select:{id:true,organizationId:true,ownerUserId:true}});
          if(knownInstall && !(await personalOrgAgentLicenseHolds(ctx.db,knownInstall,resolvedAgentId))) {
            throw bootPromptRefusal('BOOT_PROMPT_INSTALL_LICENSE_INACTIVE', { surface: 'chat', agentName: '' });
          }
        }
        throw new AgentNotFoundError(agentId);
      }
      // A session-bound App key chats only with its session's Agent: the chat
      // is hosted in the session's memory (Ada #6070).
      if (pureAppKey && !(await appKeySessionMatchesAgent(ctx, resolvedAgentId))) {
        throw new AgentNotFoundError(agentId);
      }

      // Resolve effective user id. The portal calls with userId omitted and
      // we use ctx.userId. The App Key path can pass an externalUserId.
      // Legacy callers with no user get "anonymous".
      //
      // #1581: only a pure App key acts on behalf of another user. A signed-in
      // user acts as themselves; naming someone else is refused rather than
      // provisioning a license onto that person's account.
      // The acting user. A session-bound App key ALWAYS acts as its session's
      // user (Chip, #1583 QA): omitting `userId` must not skip the check below
      // and write an "anonymous" chat into that user's session memory. A
      // supplied `userId` must equal the session's user.
      let actingUserId: string | undefined = userId ?? undefined;
      if (pureAppKey && ctx.sessionId) {
        const session = await ctx.db.session.findUnique({
          where: { id: ctx.sessionId },
          select: { userId: true },
        });
        if (session?.userId) {
          if (userId != null && userId !== session.userId) throw new UserNotFoundError(userId);
          actingUserId = session.userId;
        }
      }
      if (actingUserId != null && actingUserId !== ctx.userId) {
        if (!pureAppKey) {
          throw authorizationDenied('Forbidden: only an App key can start a chat on behalf of another user.');
        }
        // Ada's ruling (#6055, tightened #6070): an App key acts only for a
        // live AppMember of THAT App, and a session-bound key only for its
        // session's own user. Anything else reads as an unknown user.
        if (!(await appKeyMayActFor(ctx, actingUserId))) {
          throw new UserNotFoundError(actingUserId);
        }
      }
      const effectiveUserId = actingUserId ?? ctx.userId ?? 'anonymous';

      // Load agent with system memory
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: { memoryItems: { include: { memory: true } } },
      });

      const systemMemoryId = (agent as any).systemMemoryId as string | null;
      if (!systemMemoryId) throw new Error('Agent has no system memory configured');

      // If the agent has a published revision, the whole script (conversation structure, rules, extraction
      // spec) is read from that snapshot (pin-to-version, #4034); otherwise from the live nodes.
      const publishedLoc = (agent as any).publishedRevisionLoc as string | null;
      const script = await loadChatScript(ctx.db, systemMemoryId, publishedLoc);
      const findSystemNode = (loc: string) => script.node(loc);
      const findSystemNodesByPrefix = (prefix: string) => script.nodesByPrefix(prefix);

      // ── Conversation selection ───────────────────────────────────────
      let convName: string;
      if (conversationName) {
        convName = conversationName;
      } else {
        // #3405 (cor:cht:020:01 step 1, ruling 0127): ordinary by code-unit loc, then setup,
        // then fallback. Same rule on the live and the published-snapshot script.
        const chosen = pickUnnamedStartConversation(await findSystemNodesByPrefix('conversations:'));
        if (!chosen) {
          throw new ChatScopeError('AGENT_HAS_NO_CONVERSATIONS', 'Agent has no conversations configured.');
        }
        convName = chosen.loc.split(':')[1];
      }

      const convNode = await findSystemNode(`conversations:${convName}`);
      if (!convNode) {
        throw new ChatScopeError(
          'CONVERSATION_NOT_FOUND',
          `Conversation "${convName}" not found in agent's system memory.`,
        );
      }

      const convData = (convNode.data as Record<string, unknown>) ?? {};
      const stageOrder = (convData.stageOrder as string[]) ?? [];
      const firstStage = stageOrder[0];
      if (!firstStage) {
        throw new ChatScopeError('CONVERSATION_HAS_NO_STAGES', `Conversation "${convName}" has no stages.`);
      }

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
      let sharedAppId: string | null = null;
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
        // installed. Pick the first live licensed App in a stable order: a
        // retained install in one App must not hide another usable App.
        const memberships = await ctx.db.appMember.findMany({
          where: {
            userId: ctx.userId,
            app: {
              ...appInstallationWhere(resolvedAgentId),
              deletedAt: null,
            },
          },
          select: {
            app: { select: { id: true, urn: true, name: true, organizationId: true, ownerUserId: true } },
          },
          orderBy: { appId: 'asc' },
        });
        if (memberships.length === 0) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            "Cannot create a shared chat — you are not a member of any App that installs this Agent.",
          );
        }
        const licensedAppIds = await activeAppInstallLicenseIdsForAgent(
          ctx.db, resolvedAgentId, memberships.map((membership) => membership.app.id),
        );
        let selectedApp: (typeof memberships)[number]['app'] | null = null;
        for (const membership of memberships) {
          if (licensedAppIds.has(membership.app.id)) {
            selectedApp = membership.app;
            break;
          }
        }
        if (!selectedApp) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            'Cannot create a shared chat — the Agent is no longer active in this App.',
          );
        }
        sharedAppId = selectedApp.id;
        // Andi's F1 on #3960: a choice the App does not own is refused HERE, before the first chat provisions the
        // App-class memory, so a refused start leaves nothing behind. (The lazy per-user branch below judges it the same way before its own create.)
        if (aiConfigChoice != null) {
          await normalizeChatAiConfigChoice(ctx.db, selectedApp.id, aiConfigChoice).catch(rethrowAiConfigTyped);
        }
        // Idempotent: first shared chat under the (App, Agent) pair
        // provisions the app-class memory; subsequent calls reuse it.
        // Keyed per-agent (not per-app) so multi-Agent Apps — the model
        // the 2026-05-12-user-installing-app session settled on — get
        // one shared memory per installed Agent.
        targetMemoryId = await findOrCreateAppClassMemory({
          appId: selectedApp.id,
          appUrn: selectedApp.urn,
          appName: selectedApp.name,
          agentId: resolvedAgentId,
          agentUrn: agent.urn,
          agentName: agent.name,
          organizationId: selectedApp.organizationId,
          ownerUserId: selectedApp.ownerUserId,
          actingUserId: ctx.userId,
          db: ctx.db,
        });
      } else if (ctx.appId && ctx.sessionId && !ctx.userId) {
        // #934: PURE App-key shape only — user principals can now carry a
        // session binding too (heartbeat attribution), and a hybrid
        // user+selection principal entering this branch would write the chat
        // to the bound session's memoryId (often null for a coding session —
        // a hard failure) instead of taking the user-memory path below. Same
        // guard as the getAccessibleMemoryIds session branch (PR #983 review,
        // Codex/Copilot P1).
        const session = await ctx.db.session.findUnique({
          where: { id: ctx.sessionId },
          select: { memoryId: true },
        });
        // #1376: the bound session's memory is a target only inside the session's verified reach
        // (an item-linked org memory in Session.memoryId is not; Diego P1). The same set the read paths use,
        // so a user's personal/private session memory (read-only in the access map) stays a chat target.
        targetMemoryId = session?.memoryId &&
          (await sessionScopedMemoryIds(ctx.db, ctx.appId, ctx.sessionId)).includes(session.memoryId)
          ? session.memoryId : null;
        // #2895 (Vera, option a): an Agent's system memory is the Agent's own definition, not a chat space. The read
        // scope above keeps it (reads are unchanged), but no API path writes it into Session.memoryId, so a chat
        // never lands in it. Refused through the same null as any unreadable target, so nothing is disclosed.
        // (#3301 moved this check below the branch chain so every branch shares it.)
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
              where: { userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
              select: { organizationId: true },
            })
          ).map((m) => m.organizationId);

          const matchingApp =
            ownerOrgIds.length > 0
              ? await ctx.db.app.findFirst({
                  where: {
                    ...appInstallationWhere(resolvedAgentId),
                    organizationId: { in: ownerOrgIds },
                    deletedAt: null,
                  },
                  select: { id: true },
                })
              : null;

          // Andi's F1 on #3960, the private arm: the memory below would belong to `matchingApp` (else to no App), so a
          // choice that App does not own is refused before the memory exists. Same refusal as the later common check.
          if (aiConfigChoice != null) {
            await normalizeChatAiConfigChoice(ctx.db, matchingApp?.id ?? null, aiConfigChoice).catch(rethrowAiConfigTyped);
          }
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
        // #1349: one the Agent's tenant can WRITE on its own — a link is a
        // limit, never a grant (cor:dmo:050:09) — and live on both ends. This
        // branch has no user, so a personal or private memory is never the
        // target (Colin on #2002), and an app-class one never is (Riana).
        const tenant = {
          organizationId: agent.organizationId, ownerUserId: agent.ownerUserId,
          appId: ctx.appId ?? null, userId: ctx.userId ?? null,
        };
        const writable = await ctx.db.agentMemoryItem.findMany({
          where: { agentId: resolvedAgentId, deletedAt: null, role: 'read-write', memory: { deletedAt: null } },
          orderBy: { createdAt: 'asc' },
          select: { memoryId: true, role: true, memory: { select: LINK_CAP_MEMORY_SELECT } },
        });
        // #3292: an item never grants a userless principal, including an AppRun, a chat target (cor:dmo:050:09).
        targetMemoryId = !ctx.userId ? null : writable.find((m) => linkWriteTargetAdmits(tenant, m.memory, m.role))?.memoryId ?? null;
      }

      // #3301 (refs #2895, Vera's ruling option a; cor:cht:010:02): an Agent's system memory is the Agent's
      // own definition, never a chat's target, on EVERY branch (session, shared, user, legacy item). One
      // check after selection covers them all, so a branch added later is covered too. Refused through the
      // same null as any unreadable target, so the answer discloses nothing. It sits BEFORE the chat write
      // and, in the user branch, a found system row means nothing is provisioned.
      if (targetMemoryId && await ctx.db.agent.findFirst({ where: { systemMemoryId: targetMemoryId }, select: { id: true } })) {
        targetMemoryId = null;
      }

      if (!targetMemoryId) {
        throw new Error('No target memory available for this chat');
      }

      // Compile the prompt with Mustache against the target memory's data.
      //
      // Spec 017 D5: shared chats keep their allowedReadSet filter (no
      // personal memories); private chats retain the caller's read filter.
      // #1835 intersects either filter with targetMemoryId, so bare refs stay
      // in the holding memory without weakening the chat's authority gate.
      // #2047 (S10): the boot prompt is resolved first, so an unserveable one refuses before any chat exists.
      const chatAppId = (await ctx.db.memory.findUnique({ where: { id: targetMemoryId }, select: { appId: true } }))?.appId ?? null;
      // #3957: judged here, before any chat, node or subscription write; the same refusal for every id the App does not own.
      const startAiConfigChoice = aiConfigChoice == null
        ? null
        : await normalizeChatAiConfigChoice(ctx.db, chatAppId, aiConfigChoice).catch(rethrowAiConfigTyped);
      const chatServed = await serveChatPrompt(ctx.db, agent, chatAppId, reportedModel, ctx);
      let systemMessage = promptContent;
      if (promptContent.includes('{{')) {
        const access =
          chatScope === 'shared'
            ? chatScopeAccessFilter(
                {
                  scope: 'shared',
                  memoryId: targetMemoryId,
                  appId: sharedAppId,
                  authorUserId: ctx.userId ?? effectiveUserId,
                  agentId: resolvedAgentId,
                },
                {
                  knowledgeMemoryIds: await sharedChatKnowledgeMemoryIds(
                    ctx.db, resolvedAgentId, sharedAppId!, ctx.userId!,
                  ),
                  systemMemoryId,
                  appClassMemoryId: targetMemoryId, // for shared, chat.memoryId IS the app-class memory
                },
              )
            : await memoryAccessFilter(ctx);
        // #910: the first prompt reads the starter's own extracted values only.
        // #40: a served resolved read, so it counts toward the request's aggregate like any other.
        systemMessage = chargeRequestServed(ctx, promptContent, await compileTemplate(promptContent, null, targetMemoryId, ctx.db, access, ctx.userId ?? null));
      }

      // Build tool schema from hierarchical extraction spec
      // (agent-level config node + conversation-level + stage-level)
      const tools = await buildRespondToolSchema(script, convName, stageData);

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
      } catch (err) {
        // #2476: only the cold-path race loss means the parent exists.
        if (!isNodeLocUniqueViolation(err)) throw err;
      }

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
        ...(startAiConfigChoice ? { aiConfigChoice: startAiConfigChoice } : {}),
        scope: chatScope,
        conversationName: convName,
        stageName: firstStage,
        userId: effectiveUserId,
        startedWithRevision: publishedLoc ?? null,
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

      // #664/#752: the chat node and its messages parent live under the `chats`
      // subtree — a concurrent non-recursive delete of `chats` (or the chat)
      // could count zero descendants and orphan them. Create both under the
      // ancestor-path lock in one READ COMMITTED tx (advisory before row).
      // #1061 — the ids are minted inside the transaction; collected here so
      // the writes are recorded only after it commits.
      const startedNodes: { id: string; loc: string; memoryId: string }[] = [];
      // #1573: the gate and the license write commit together under every
      // authority anchor the gate can admit through (chatAuthorityAnchors),
      // the keys revokeAgentSubscription / removeAppMember / deleteApp /
      // uninstall / org-role changes hold exclusively. The gate re-runs on the
      // transaction after the anchor wait.
      // Chip (#1585 QA): the anchors are chosen BEFORE the transaction, so an
      // App that became a carrier in between (newly licensed, say) could admit
      // the caller unanchored. After the gate re-runs inside the transaction,
      // every carrier App (and its owner) must already be anchored; if not, the
      // attempt aborts before any write and retries with fresh anchors.
      let chatStarted = false;
      for (let attempt = 0; attempt < 3 && !chatStarted; attempt++) {
        const chatAnchors = await chatAuthorityAnchors(
          ctx, gateRow, effectiveUserId !== 'anonymous' ? effectiveUserId : null,
        );
        const anchored = new Set(chatAnchors.map((a) => `${a.kind}:${a.id}`));
        try {
          await withAuthorizedTx(ctx, chatAnchors, async (txCtx) => {
            const current = await txCtx.db.agent.findUnique({
              where: { id: resolvedAgentId },
              select: { id: true, organizationId: true, ownerUserId: true, visibility: true, deletedAt: true },
            });
            // Chip (#1585 QA): read the carrier Apps ONCE. Prove each is
            // anchored, then admit only from that same set. Two separate
            // reads let a carrier admit the gate, be deleted unanchored, and
            // vanish from the second read.
            const carriers = await chatCarrierApps(txCtx, resolvedAgentId);
            for (const app of carriers) {
              const needed = [
                `app:${app.id}`,
                ...(app.organizationId ? [`org:${app.organizationId}`] : []),
                ...(app.ownerUserId ? [`user:${app.ownerUserId}`] : []),
              ];
              if (needed.some((key) => !anchored.has(key))) throw new ChatAuthorityScopeChanged();
            }
            if (
              !current ||
              current.organizationId !== gateRow.organizationId ||
              current.ownerUserId !== gateRow.ownerUserId ||
              !(await canChatWithAgent(txCtx, current, { carriers }))
            ) {
              throw new AgentNotFoundError(agentId);
            }
            if (pureAppKey && !(await appKeySessionMatchesAgent(txCtx, resolvedAgentId))) {
              throw new AgentNotFoundError(agentId);
            }
            if (actingUserId != null && actingUserId !== ctx.userId && !(await appKeyMayActFor(txCtx, actingUserId))) {
              throw new UserNotFoundError(actingUserId);
            }
          }, async (tx) => {
            // 005-agent-subscription FR-002: auto-provision an AgentSubscription
            // on the first user-attributed contact for (user, agent). Idempotent.
            // Skip for the "anonymous" sentinel — there is no User row.
            //
            // Spec 019: also skip when `isTestRun` is true. AgentSubscription is
            // the platform's license-grant entity, narrowed in
            // 2026-05-12-user-installing-app to "user is licensed to interact
            // with this Agent at all." A side-effect of clicking "Test" once
            // silently granting that license re-broadens what we narrowed.
            //
            // #1581: provisioned in the SAME transaction that creates the chat,
            // after the Agent gate above, so a chat that fails leaves no license.
            if (effectiveUserId !== 'anonymous' && !isTestRun) {
              await ensureAgentSubscription(tx, effectiveUserId, resolvedAgentId);
            }
            // #3501: names and conversational text use the SAME fresh encryption decision.
            await tx.$queryRaw`SELECT id FROM memories WHERE id=${targetMemoryId} FOR SHARE`;
            const stateInfo = await tx.memory.findUniqueOrThrow({ where: { id: targetMemoryId }, select: { id: true, isEncrypted: true } });
            const initialState = engineState(JSON.parse(JSON.stringify(initialChatData)), false);
            const initialData = { ...initialChatData };
            // #3557: the state row is the only home of every engine key, the two names included (no rollback mirror).
            for (const key of ENGINE_KEYS) delete initialData[key];
            const storedRoot = encryptNodeFields({ data: initialData }, stateInfo);
            const storedState = encryptNodeFields({ data: initialState }, stateInfo);
            await lockAncestorsForCreateMany(tx, targetMemoryId, [chatLoc, `${chatLoc}:messages`]);
            const chatNodeId = generateId();
            startedNodes.push({ id: chatNodeId, loc: chatLoc, memoryId: targetMemoryId });
            await tx.node.create({
              data: {
                id: chatNodeId, memoryId: targetMemoryId, loc: chatLoc, name: chatName,
                nodeType: 'record',
                description: `Chat: ${convName}`,
                data: storedRoot.data as InputJsonValue,
                // #914: record the creator on the audit column too, not only
                // inside `data.userId`. The column survives encryption and is
                // what #915's audit expects to find. It stays PROVENANCE — the
                // chat's creator is never an authorization gate (cor:acl:030:01),
                // because every member of the host may post here.
                createdBy: ctx.userId ?? null,
              },
            });
            await tx.chatRootCounter.create({data:{chatRootNodeId:chatNodeId}});
            await tx.chatRootEngineState.create({ data: { chatRootNodeId: chatNodeId, state: storedState.data as InputJsonValue } });
            // #2047: the chat's record, written with the chat so neither exists without the other (R37).
            if (chatServed) {
              await recordServedPrompt(tx, { kind: 'CHAT', chatId: chatNodeId, appId: chatAppId, agentId: resolvedAgentId }, chatServed.served, chatServed.variables);
            }
            // Create the messages parent (so the chat subtree is well-formed)
            const messagesNodeId = generateId();
            startedNodes.push({
              id: messagesNodeId, loc: `${chatLoc}:messages`, memoryId: targetMemoryId,
            });
            await tx.node.create({
              data: {
                id: messagesNodeId, memoryId: targetMemoryId, loc: `${chatLoc}:messages`,
                name: 'messages', nodeType: 'record',
                createdBy: ctx.userId ?? null,
              },
            });
          });
          chatStarted = true;
        } catch (error) {
          if (error instanceof ChatAuthorityScopeChanged) continue;
          throw error;
        }
      }
      if (!chatStarted) throw new Error('The Agent\'s access changed repeatedly while starting the chat; retry.');

      // #1061 — starting a chat creates two real nodes (the chat record and its
      // messages parent), so it is two writes.
      recordNodeUsage(ctx.db, 'write', startedNodes, ctx);

      // The served boot prompt leads the system message (#2047).
      systemMessage = chatServed.text + '\n\n' + systemMessage;

      return { chatId: chatLoc, systemMessage, tools, conversationName: convName, stageName: firstStage };
    },

    sendChatMessage: async (
      _: unknown,
      { chatId, userMessage, llmModel, aiConfigChoice }: { chatId: string; userMessage: string; llmModel?: string | null; aiConfigChoice?: string | null },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      // Each turn reports independently: omission/null means empty, never an inferred model.
      const reportedModel = clientReportedChatModel(llmModel);

      // Find the chat node
      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw chatNotFoundError(chatId);
      // #1717: a chat has no ACL of its own (cor:acl:030:01) — writing it is
      // writing its host memory, so it takes CURRENT write access there. The
      // lookup's author and memory-creator arms only narrow candidates; they
      // outlive membership, so they must never be the grant.
      await requireMemoryWriteAccess(ctx, chatNode.memoryId);
      const inTx = await chatWriteTx(ctx, chatNode.memoryId);

      // Decrypt the chat node's metadata (`data`; the engine names live in the state row, #3557) if the memory is encrypted.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) translateSessionExpired(memEncInfo.id, () => decryptNodeFields(chatNode, memEncInfo));

      // #919: rebound below to the copy read under the chat lock. Before that point this copy supplies only the
      // immutable `scope` and `startedWithRevision`, plus (#3557) the legacy names for a root with NO state row; the
      // routing names themselves come from the state row (`readTurnNames`), and the locked re-check below judges them again.
      let chatData = (chatNode.data as Record<string, unknown>) ?? {};

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
      const chatRef = { id: chatNode.id, memoryId: chatNode.memoryId, loc: chatNode.loc };

      // #3654: resolved before the first write (was after the user message). Find the agent that owns this chat. Two ways a memory can belong
      // to an agent: (1) it's a user memory via userMemoryOfAgentId, or
      // (2) legacy — it's attached as a regular memoryItem with role
      // read-write. Check the user-memory path first since that's the
      // canonical portal chat path.
      const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
      if (!memory) throw new Error('Memory not found');
      // #3957 (cor:dmo:050:10): a person who may send this chat's user turns stores its AI config choice. Judged
      // before the first write of the turn; applied with the user message below, so this turn already follows it.
      const sendAiConfigChoice = aiConfigChoice == null
        ? null
        : await normalizeChatAiConfigChoice(ctx.db, memory.appId ?? null, aiConfigChoice).catch(rethrowAiConfigTyped);
      let agent = null;
      if (memory.sharedMemoryOfAgentId || memory.userMemoryOfAgentId) {
        agent = await ctx.db.agent.findUnique({
          where: { id: memory.sharedMemoryOfAgentId ?? memory.userMemoryOfAgentId! },
        });
      } else {
        const legacyAgents = await ctx.db.agent.findMany({
          where: { deletedAt: null, memoryItems: { some: { memoryId: chatNode.memoryId } } },
        });
        agent = legacyAgents.find((a) => (a as any).systemMemoryId) ?? null;
      }
      // Uninstall leaves the App's shared chat memory in place. Its historical
      // Agent pointer is not a live grant: after uninstall, participants may
      // still post to the chat, but its old system prompt and linked knowledge
      // must not re-enter template retrieval.
      if (memory.class === 'app' && agent) {
        const installed = memory.appId && await isAgentInstalledAndLicensed(ctx.db, memory.appId, agent.id);
        if (!installed) agent = null;
      }
      const systemMemoryId = agent ? (agent as any).systemMemoryId as string : null;

      // Pin to version: if the chat was started with a published revision,
      // read from that snapshot so mid-conversation publishes don't change
      // the prompts/stages under the user.
      const startedWithRevision = chatData.startedWithRevision as string | null;
      const script = systemMemoryId ? await loadChatScript(ctx.db, systemMemoryId, startedWithRevision) : null;

      async function findSystemNode(loc: string) {
        return script ? script.node(loc) : null;
      }

      // #3654: choose the fallback re-route target BEFORE any write, so the gate below sees the stage this turn will serve.
      // Pure reads; the chat root is updated only after the user message lands (see below).
      // #3557 R1: from the state row (the names are no longer mirrored into the root's data); legacy data only without a row.
      const { conversationName: preConvName, stageName: preStageName } = await readTurnNames(ctx.db, chatNode, memEncInfo, chatData);
      let rerouteTarget: { convName: string; firstStage: string } | null = null;
      if (systemMemoryId) {
        const currentConv = await findSystemNode(`conversations:${preConvName}`);
        const currentConvData = (currentConv?.data as Record<string, unknown>) ?? {};
        if (currentConvData.isFallback === true) {
          // Scan all conversations for a goal match
          const allConvNodes = topLevelConversations(await script!.nodesByPrefix('conversations:'));
          // #3405: both scans below walk top-level conversations in code-unit `loc` order
          // (cor:cht:030:02 step 3), so the first match and the default are deterministic.

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
          rerouteTarget = bestMatch;
        }
      }

      // #3654: the serve gate (canChatWithAgent, the licence check, the served boot prompt) runs BEFORE any write of this turn,
      // so a refused turn persists nothing: no user message, no message-count bump, no re-route, no served-prompt record.
      // The scope is as built (every turn, every App type; cor:dmo:050:02 is Proposed, not ruled). The stage test includes the
      // fallback re-route target chosen above, so a turn that only gains its stage by re-routing is gated before the write too.
      let chatServed: Awaited<ReturnType<typeof serveChatPrompt>> | null = null;
      if (agent && systemMemoryId && ((preConvName && preStageName) || rerouteTarget)) {
        chatServed = await serveChatPrompt(ctx.db, agent, memory?.appId ?? null, reportedModel, ctx);
      }

      // Save user message. When the memory is encrypted we need to encrypt
      // the message content AND the chat node's updated `data`.
      // The `data.role` field is what the message-history reader uses to
      // decide user-vs-assistant — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      //
      // #914 — the SENDER, not the chat's creator.
      //
      // Every chat in a multi-human memory is a group chat: a chat has no
      // ACL of its own, so read AND write both fall through the host
      // memory's per-class rules, and any member of an app-class host may
      // post into any chat in it (cor:acl:030:01). This path used to stamp
      // every user turn with `chatData.userId` — the id `startChat` stored
      // for whoever CREATED the chat — so a second participant's messages
      // were recorded under the creator's identity. Not merely unattributed:
      // confidently wrong, which is worse than a NULL that says "unknown".
      //
      // `createdBy` is the authoritative home (a plain column, so it stays
      // readable in an encrypted memory, unlike anything inside `data`).
      // Null when the caller carries no user identity — e.g. an App-key
      // principal — which reads as "unknown", never as the creator.
      const senderUserId = ctx.userId ?? null;
      const newMsgFields = encryptNodeFields(
        {
          content: userMessage,
          // `authorUserId` is a convenience for transcript readers that
          // already decrypt `data` — it rides the same encryption as the
          // rest, so `createdBy` above remains the attribution of record.
          // Omitted rather than blanked when there is no user identity, so
          // absent never reads as a claim.
          data: { role: 'user', ...(senderUserId ? { authorUserId: senderUserId } : {}) },
        },
        memEncInfo,
      );
      // #919: the number is allocated INSIDE the transaction that inserts,
      // under the chat lock, and written back there — so two concurrent sends
      // can no longer derive the same `seq` (arbitrary transcript order) or
      // land the same value in `messageCount` (a permanent under-count that
      // also shifts the summarization trigger and the `chat.message_count`
      // edge operand). The lock is the ancestor-path lock this insert already
      // took for #664/#752 — a message lands under `${chatId}:messages`, whose
      // ancestors include the chat root, so a concurrent non-recursive delete
      // of the chat still can't orphan it. See src/lib/chatRoot.ts.
      //
      // The suffix is the ROLE, mirroring `-assistant`, not an identity.
      // A loc is an address that lands in URNs, portal links, and search;
      // embedding a user id there both leaked it into those surfaces and
      // invited exactly this bug — reading the address as if it were the
      // author. Nothing ever parsed the id out of it: both transcript
      // readers take `data.role` first and fall back only to "does the
      // suffix end in `-assistant`", so `-user` is read identically to the
      // old `-<userId>` form and legacy rows keep resolving unchanged.
      //
      // The short random component predates the atomic allocation (#916 added
      // it while two sends could still derive the same `msgNum` and collide on
      // `@@unique([loc, memoryId])`, losing a message). It is no longer what
      // keeps locs unique, and it stays anyway: a loc is an immutable address,
      // so churning the format a second time buys nothing, and it remains a
      // cheap backstop for any future write path that skips the allocator.
      // #1061 — the message node's id + loc are minted inside the allocation
      // closure; they escape so the write is recorded once it has committed.
      let userMsgRef: { id: string; loc: string; memoryId: string } | null = null;
      const { seq: messageCount, chatData: allocatedChatData } = await appendChatMessage(
        ctx.db,
        chatRef,
        memEncInfo,
        async ({ tx, seq, msgNum, chatData: lockedChatData }) => {
          // #3654: the stage the turn will serve is judged on the root read under the chat lock. A stage that appeared since the
          // early read (a concurrent turn moved the chat) is gated HERE, before the insert, so the refusal rolls the whole
          // transaction back: nothing persists. Only a chat the early gate skipped (no stage then) reaches this.
          if (!chatServed && agent && systemMemoryId && lockedChatData.conversationName && lockedChatData.stageName) {
            chatServed = await serveChatPrompt(ctx.db, agent, memory?.appId ?? null, reportedModel, ctx);
          }
          const msgId = generateId();
          const msgLoc = `${chatId}:messages:${msgNum}-${generateId().slice(-8)}-user`;
          userMsgRef = { id: msgId, loc: msgLoc, memoryId: chatNode.memoryId };
          await tx.node.create({
            data: {
              id: msgId, memoryId: chatNode.memoryId,
              loc: msgLoc,
              name: `${msgNum}-user`,
              nodeType: 'record', content: newMsgFields.content ?? null,
              data: (newMsgFields.data ?? null) as InputJsonValue,
              seq,
              createdBy: senderUserId,
            },
          });
        },
        { inTx },
      );
      // A chat turn IS a node write on the chat's memory.
      recordNodeUsage(ctx.db, 'write', userMsgRef ? [userMsgRef] : [], ctx);
      // Everything downstream reads the copy the allocation committed, not the
      // pre-lock one — a turn that raced us has already been folded in.
      chatData = allocatedChatData;
      // #3965 (documented disposition; cor:dmo:050:10 needs only that a turn uses the chat's STORED config): this is a second
      // write, after the user message has committed and before the stage loads or any model call. If it throws, the message is
      // kept, no turn runs, and the chat's previous choice stands. A caller resends the choice, not the message (the message is stored; the choice rides on the next sendChatMessage). It is not moved
      // into the allocation transaction: nothing in the law asks for that, and a turn never runs under a choice that was not stored.
      if (sendAiConfigChoice !== null && chatData.aiConfigChoice !== sendAiConfigChoice) {
        // A fresh read under the chat lock (#919): contribute this one key, never replay a stale blob.
        chatData = await updateChatRootData(ctx.db, chatRef, memEncInfo, (fresh) => ({ ...fresh, aiConfigChoice: sendAiConfigChoice }), { inTx });
      }
      const convName = chatData.conversationName as string;
      const stageName = chatData.stageName as string;


      // If the chat is in a fallback conversation, try to re-route on
      // every turn. The user may have clarified their intent — check if
      // any non-fallback conversation's goalSignals match the message.
      let activeConvName = convName;
      let activeStageName = stageName;
      // #3654: the target was chosen before the first write (so the gate sees it); apply it only when no concurrent turn
      // already moved the chat off the conversation it was chosen from.
      if (rerouteTarget && convName === preConvName) {
        const bestMatch = rerouteTarget;
        activeConvName = bestMatch.convName;
        activeStageName = bestMatch.firstStage;
        // Update the chat node to reflect the re-route. #919: apply the
        // re-route to a FRESH read under the chat lock — writing the blob
        // we read before the allocation would roll back a turn that
        // committed since, `messageCount` included.
        chatData = await updateChatRootData(ctx.db, chatRef, memEncInfo, (fresh) => {
          const next = {
            ...fresh,
            conversationName: activeConvName,
            stageName: activeStageName,
            lastMessageAt: new Date().toISOString(),
          };
          appendRouteEntry(next, {
            conversationUrn: `conversations:${activeConvName}`,
            nodeUrn: `conversations:${activeConvName}:${activeStageName}`,
            action: 'ENTER',
            trigger: { type: 'FALLBACK_REROUTE', content: userMessage.slice(0, 100) },
          });
          return next;
        }, { inTx });
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
        // personal memory. PRIVATE chats keep memoryAccessFilter; #1835
        // intersects either filter with the holding memory. See chat-scope.ts:
        // chatScopeAccessFilter for the full rationale.
        const isShared = chatData.scope === 'shared';
        let access: Record<string, unknown>;
        if (isShared && agent) {
          if (!memory.appId) throw new Error('Shared chat has no App');
          access = chatScopeAccessFilter(
            {
              scope: 'shared',
              memoryId: chatNode.memoryId,
              appId: memory.appId,
              authorUserId: (chatData.userId as string) ?? '',
              agentId: agent.id,
            },
            {
              knowledgeMemoryIds: await sharedChatKnowledgeMemoryIds(
                ctx.db, agent.id, memory.appId, senderUserId ?? '',
              ),
              systemMemoryId,
              appClassMemoryId: chatNode.memoryId, // chat IS in the app-class memory
            },
          );
        } else {
          access = await memoryAccessFilter(ctx);
        }
        if (promptContent.includes('{{')) {
          // #910: the sender's own extracted values, never another participant's
          // (the same identity the user message is attributed to, #914).
          // #40: a served resolved read, so it counts toward the request's aggregate like any other.
          systemMessage = chargeRequestServed(ctx, promptContent, await compileTemplate(promptContent, null, chatNode.memoryId, ctx.db, access, senderUserId));
        } else {
          systemMessage = promptContent;
        }

        // Re-served on each chat turn so a newly approved revision takes effect.
        if (agent) {
          // #2047: the same refusal as a bind; and a chat records again only when its revision or filled values CHANGED (R37, #3096), never per unchanged message.
          chatServed ??= await serveChatPrompt(ctx.db, agent, memory?.appId ?? null, reportedModel, ctx);
          await recordChatServedIfChanged(ctx.db, chatNode.id, agent.id, memory?.appId ?? null, chatServed);
          systemMessage = chatServed.text + '\n\n' + systemMessage;
        }

        // Build tools from hierarchical extraction spec
        tools = await buildRespondToolSchema(script!, activeConvName, stageData);
      }

      // Build message history — the most recent MODEL_HISTORY_LIMIT messages.
      // For encrypted memories, decrypt each message's content before
      // formatting.
      //
      // #1111: this used to sort ASCENDING and `take` from the head, which is
      // the OLDEST N, not the newest. Past the cap the model was handed the
      // opening of the conversation on every turn and never saw the message it
      // was being asked to answer — the user's current turn is written to the
      // transcript above, so it fell outside the window along with everything
      // else recent. Same defect as the `chatHistory` reader; fixed the same
      // way, and for the same reason the inversion covers all three keys:
      // (seq, createdAt, loc) is a total order, so taking from the far end and
      // reversing yields exactly the last N.
      //
      // #919: the deterministic tiebreak the chatHistory reader uses — the
      // model's view of the transcript must not reorder between turns.
      //
      // `nulls: 'last'` is load-bearing here for the same reason it is in
      // `chatHistory`, and the consequence is sharper: `Node.seq` is nullable
      // and Postgres sorts NULLs FIRST on DESC, so a chat holding 50+ null-seq
      // legacy rows would fill the model's whole window with them and exclude
      // the just-appended user turn — the exact defect this change fixes,
      // returning by a different door. A row with no counter predates the
      // counter, so it sorts OLDEST. (Codex P2 on PR #1112.)
      const messages = await ctx.db.node.findMany({
        where: { loc: { startsWith: `${chatId}:messages:` }, memoryId: chatNode.memoryId, deletedAt: null },
        orderBy: [
          { seq: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { loc: 'desc' },
        ],
        take: MODEL_HISTORY_LIMIT,
        select: { loc: true, content: true, data: true, seq: true, nodeType: true, memoryId: true },
      });
      // Chronological again: the window is the newest N, but a model reads a
      // transcript oldest-first like everyone else.
      messages.reverse();
      if (memEncInfo.isEncrypted) {
        for (const m of messages) translateSessionExpired(memEncInfo.id, () => decryptNodeFields(m, memEncInfo));
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

      // SUMMARIZATION IS DISARMED, deliberately (#1115; @Holger's call
      // 2026-09-04: neutralize now, design later).
      //
      // The loop this used to start makes the transcript LONGER. Firing it told
      // the caller to produce a summary and POST it back via `saveChatSummary`,
      // which writes an `abstract` node under `${chatId}:messages:` — and
      // nothing anywhere reads that node back AS a summary:
      //
      //   * no predicate excludes the messages a summary covers; the window
      //     query above is the whole `:messages:` subtree;
      //   * role detection has no summary branch, so the node falls through to
      //     'user' (see the comment at that site, which says so outright).
      //
      // So the model received the summary as one more user turn ALONGSIDE
      // everything it summarised, and it competed for the 50-message window
      // with the recent messages it was supposed to replace.
      //
      // Not removed, because the loop is BUILT on the client side: hadron-portal
      // calls `saveChatSummary` and reads this field, and three hadron-docs
      // pages document it. Returning null breaks the loop at its first link
      // without a breaking schema change — the field stays nullable and every
      // caller already handles its absence, since it was absent 19 turns in 20.
      //
      // Nothing is lost by disarming it. Measured 2026-09-04: ZERO summary
      // nodes have ever been written, in production or dev, and the longest
      // ordinary chat in production is 11 messages — so the 20-message trigger
      // has never fired. This removes a latent regression rather than a
      // capability: the first real chat to reach 20 messages would have started
      // growing its own transcript.
      //
      // What re-arming needs is a DESIGN, not a flag, and #1115 states it:
      // does a summary REPLACE the messages it covers or sit alongside a
      // smaller window; what marks the covered range (today `messageCount`
      // lives only in the node's NAME, which is not a queryable boundary); and
      // should `chatHistory` hide summaries from human readers.
      const summarizationNeeded = null;

      return { systemMessage, tools, messageHistory, summarizationNeeded };
    },

    processChatResponse: async (
      _: unknown,
      { chatId, toolResponse }: { chatId: string; toolResponse: Record<string, unknown> },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw chatNotFoundError(chatId);
      // #1717: a chat has no ACL of its own (cor:acl:030:01) — writing it is
      // writing its host memory, so it takes CURRENT write access there. The
      // lookup's author and memory-creator arms only narrow candidates; they
      // outlive membership, so they must never be the grant.
      await requireMemoryWriteAccess(ctx, chatNode.memoryId);
      const inTx = await chatWriteTx(ctx, chatNode.memoryId);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) translateSessionExpired(memEncInfo.id, () => decryptNodeFields(chatNode, memEncInfo));

      // #919: rebound below to the copy read under the chat lock (see
      // sendChatMessage). Only `scope`, which is immutable, is read before.
      let chatData = (chatNode.data as Record<string, unknown>) ?? {};

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

      const chatRef = { id: chatNode.id, memoryId: chatNode.memoryId, loc: chatNode.loc };

      // #3992 (cor:cht:020:01 step 2): `message` is a required JSON string, the contract the `respond` tool schema
      // publishes. Missing, null or non-string is refused BEFORE any write (no turn, merge, routing or history).
      // The text names the field and type only: never the value or model text. An empty or whitespace-only string
      // is a valid string and is recorded as sent. The other fields below keep their casts (separate issue).
      if (typeof toolResponse.message !== 'string') {
        throw new GraphQLError('processChatResponse: toolResponse.message is required and must be a string.', {
          extensions: { code: 'BAD_USER_INPUT', field: 'message', expectedType: 'string' },
        });
      }
      const message = toolResponse.message;
      const data = toolResponse.data as Record<string, unknown> | undefined;
      const onTrack = toolResponse.onTrack as boolean | undefined;
      const offTrackReason = toolResponse.offTrackReason as string | undefined;

      // Save assistant message (encrypted when memory is encrypted).
      // `data.role = 'assistant'` is what the message-history reader uses
      // to identify the role — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      const encMsg = encryptNodeFields(
        { content: message, data: { role: 'assistant' } },
        memEncInfo,
      );
      // #919: the assistant turn allocates its number the same way a user turn
      // does — inside the inserting transaction, under the chat lock (which is
      // still the #664/#752 ancestor-path lock, so an ancestor delete can't
      // orphan the message). The two paths shared the counter and so shared the
      // race: a user send interleaved with an assistant turn produced two
      // messages at the same `seq`.
      // #914: `createdBy` is deliberately left unset on the assistant turn.
      // The platform authored it, and cor:dmo:010:01 admits the system as an
      // author — so NULL here means "the platform", not "unrecorded". Do NOT
      // stamp the sending user: that would assert a human wrote the model's
      // words. (Which user prompted it is recoverable from the preceding
      // message's `seq`.)
      // #1061 — as for the user turn above; see the note on attribution below.
      let assistantMsgRef: { id: string; loc: string; memoryId: string } | null = null;
      const { seq: messageCount, chatData: allocatedChatData } = await appendChatMessage(
        ctx.db,
        chatRef,
        memEncInfo,
        async ({ tx, seq, msgNum }) => {
          const msgId = generateId();
          const msgLoc = `${chatId}:messages:${msgNum}-assistant`;
          assistantMsgRef = { id: msgId, loc: msgLoc, memoryId: chatNode.memoryId };
          await tx.node.create({
            data: {
              id: msgId, memoryId: chatNode.memoryId,
              loc: msgLoc,
              name: `${msgNum}-assistant`,
              nodeType: 'record', content: encMsg.content ?? null,
              data: (encMsg.data ?? null) as InputJsonValue,
              seq,
            },
          });
        },
        { inTx },
      );
      // #1061 — the assistant turn is a node write too. Note the deliberate
      // divergence from `createdBy`, which is left NULL just above because the
      // PLATFORM authored the words (cor:dmo:010:01): the usage event still
      // attributes to `ctx`, because usage answers "whose activity caused this
      // row to exist", not "who wrote the prose". The caller's turn caused it.
      recordNodeUsage(ctx.db, 'write', assistantMsgRef ? [assistantMsgRef] : [], ctx);
      chatData = allocatedChatData;

      // Save extracted data to memory's default data node
      // #1717: under the same anchored gate as the turn itself; the write is
      // recorded once it has committed (#1061).
      // #910: in a multi-human host the values are filed per person — the
      // speaker's under `users.<speakerId>`, declared memory-wide ones flat —
      // so one member's answer is never another's prompt variable.
      const hasExtraction = !!data && Object.keys(data).length > 0;
      const hostMemory = hasExtraction
        ? await ctx.db.memory.findUniqueOrThrow({
            where: { id: chatNode.memoryId },
            select: DATA_HOST_MEMORY_SELECT,
          })
        : null;
      const declaredMemoryWide = hostMemory && isMultiHumanChatHost(hostMemory)
        ? await declaredMemoryWideFields(ctx.db, hostMemory)
        : null;
      const fold = (stored: Record<string, unknown> | null, extracted: Record<string, unknown>) =>
        declaredMemoryWide
          ? mergeTurnExtraction(stored, extracted, declaredMemoryWide, ctx.userId ?? null)
          : { ...(stored ?? {}), ...extracted };
      if (data && hasExtraction) recordNodeWrite(ctx.db, await inTx(async (tx) => {
        // #910: two members extract into the same memory from different chats,
        // under different chat locks. Serialize the read-modify-write on the
        // `data` loc so neither turn loses the other's bucket.
        await lockLocForWrite(tx, chatNode.memoryId, 'data');
        const dataNodeWhere = { loc: 'data', memoryId: chatNode.memoryId, deletedAt: null };
        // #1328 — the row lock, not only the loc lock: the check below judges
        // this row, and a writer that takes no loc lock (git sync) can change it.
        const located = await tx.node.findFirst({ where: dataNodeWhere, select: { id: true } });
        if (located) await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${located.id} FOR UPDATE`;
        const dataNode = located ? await tx.node.findFirst({ where: dataNodeWhere }) : null;
        if (dataNode) {
          if (memEncInfo.isEncrypted) translateSessionExpired(memEncInfo.id, () => decryptNodeFields(dataNode, memEncInfo));
          const existingData = (dataNode.data as Record<string, unknown>) ?? {};
          const merged = fold(existingData, data);
          // #1328 — extraction states no task, so it cannot change a `data`
          // node a rule governs. Compared on plaintext: a turn that extracts
          // what is stored changes nothing authored, and needs no claim.
          const authoredChange = authoredContentChanged(diffNodeChanges({ data: existingData }, { data: merged }));
          const stamp = await assertAuthoring(tx, chatNode.memoryId, {
            priorRole: dataNode.role, priorRunnable: dataNode.isRunnable,
            role: dataNode.role, runnable: dataNode.isRunnable, mintHuman: true, authoredChange,
          }, attestedAuthoring(ctx));
          // Nothing changed, so nothing is written. Rewriting would re-encrypt
          // an encrypted row, and fresh ciphertext reads as drift that clears the stamp.
          if (!authoredChange) return null;
          // A stamp is about to go: keep the stamped predecessor in history.
          // Reconciling first means a stamp raw drift already falsified is
          // dropped rather than snapshotted as if it described this content.
          // An unstamped row has no attribution to lose, and keeps the
          // revision-free write extraction has always made.
          let revisioned = false;
          if (dataNode.authorshipKind != null) {
            await ensureCurrentNodeRevisionInTransaction(tx, dataNode.id, { expectedMemoryId: chatNode.memoryId });
            const current = await tx.node.findUniqueOrThrow({ where: { id: dataNode.id } });
            if (current.authorshipKind != null) {
              await createNodeRevision(tx, buildNodeRevisionSnapshot(current, editorFromAuth(ctx), { changes: ['data'] }));
              revisioned = true;
            }
          }
          const encData = encryptNodeFields({ content: null, data: merged }, memEncInfo);
          await tx.node.update({
            where: { id: dataNode.id },
            data: {
              data: (encData.data ?? null) as InputJsonValue,
              updatedBy: ctx.userId ?? null,
              ...(stamp ?? clearNodeAuthorship()),
              ...(revisioned ? { revisionContentHash: revisionStateHashRefreshMarker() } : {}),
            },
          });
          // #1061 — folding extracted data into the memory's `data` node
          // rewrites a real node, so it is its own write.
          return { id: dataNode.id, loc: dataNode.loc, memoryId: dataNode.memoryId };
        } else {
          const encNew = encryptNodeFields({ content: null, data: fold(null, data) }, memEncInfo);
          const dataNodeId = generateId();
          await tx.node.create({
            data: {
              id: dataNodeId, memoryId: chatNode.memoryId,
              loc: 'data', name: 'data', nodeType: 'info',
              createdBy: ctx.userId ?? null, // cor:dmo:010:01 — submitting principal, independent of Worker lineage.
              data: (encNew.data ?? null) as InputJsonValue,
            },
          });
          // #1061 — first extraction into this memory mints the `data` node.
          return { id: dataNodeId, loc: 'data', memoryId: chatNode.memoryId };
        }
      // #3514: the assistant message and counter are already committed above; a refused extraction says so.
      }).catch(reportPartialTurn), ctx);

      // Handle stage transition + edge evaluation
      let stageTransitioned = false;
      let newStageName: string | null = null;
      let conversationHandoff: string | null = null;
      // #919: what this turn CHANGES about the chat root, recorded as edits and
      // replayed at the end against a freshly read blob. Edge evaluation below
      // is unbounded in wall-clock terms, and the root is stored whole — so
      // writing back a snapshot taken at the top of the turn would roll back
      // any send that committed while we were evaluating, `messageCount`
      // included. Edits run in the order they were pushed.
      const chatRootEdits: Array<(chatData: Record<string, unknown>) => void> = [];

      // 1. Explicit stage transition from the LLM. #4035: the name is checked against the stages of the
      // conversation the chat is pinned to; an unknown name moves nothing and comes back as rejectedNextStage.
      let rejectedNextStage: string | null = null;
      let turnSysMemId: string | null = null;
      let turnScript: ChatScript | null = null;
      {
        const turnMemory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
        const turnAgentId = turnMemory?.userMemoryOfAgentId;
        if (turnAgentId) {
          const turnAgent = await ctx.db.agent.findUnique({ where: { id: turnAgentId } });
          turnSysMemId = ((turnAgent as any)?.systemMemoryId as string | null) ?? null;
          if (turnSysMemId) {
            turnScript = await loadChatScript(ctx.db, turnSysMemId, (chatData.startedWithRevision as string | null) ?? null);
          }
        }
      }
      const stageOrder = turnScript
        ? await conversationStageOrder(turnScript, (chatData.conversationName as string | null) ?? null)
        : null;
      const stageDecision = decideNextStage(toolResponse.next_stage, chatData.stageName as string | undefined, stageOrder);
      if (stageDecision.kind === 'rejected') {
        rejectedNextStage = stageDecision.name;
      } else if (stageDecision.kind === 'move') {
        const moveTo = stageDecision.stage;
        stageTransitioned = true;
        newStageName = moveTo;
        chatRootEdits.push((d) => {
          d.stageName = moveTo;
          appendRouteEntry(d, {
            nodeUrn: `conversations:${chatData.conversationName}:${moveTo}`,
            conversationUrn: `conversations:${chatData.conversationName}`,
            action: 'ENTER',
            trigger: { type: 'STAGE_TRANSITION', content: `next_stage: ${moveTo}` },
          });
        });
      }

      // 2. Evaluate on_complete edges when the conversation ends
      //    (next_stage is null and we're at the last stage)
      // R1 (a): a rejected name still NAMED a stage, so no rule runs on it.
      if (stageDecision.kind === 'none') {
        {
          const sysMemId = turnSysMemId;
          if (sysMemId && turnScript) {
            // #4034: the rules, the agent config and the condition defaults come from the revision the chat
            // is pinned to (`startedWithRevision`), not from the live draft (cor:cht:020:01, cor:cht:030:02).
            const currentStageLoc = `conversations:${chatData.conversationName}:${chatData.stageName}`;
            const script = turnScript;
            const stageNode = await script.node(currentStageLoc);
            if (stageNode) {
              const edges = await script.outgoingRules(currentStageLoc);
              const agentBag: Record<string, unknown> = {
                config: await script.agentConfig(),
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
              // #910: conditions read the turn's own person's values only.
              const turnPersonId = ctx.userId ?? null;
              memoryLayers.push(await script.conditionLayerA('edge-memory', currentStageLoc, turnPersonId));
              // #4034: when layer A is the pinned snapshot, the chat's own memory is ALWAYS added live, even when it
              // is the system memory (single-memory chat): otherwise the facts the chat extracts would vanish from
              // its conditions. Unpinned, layer A already is the live system memory, so the duplicate stays skipped.
              // (Today the chat-scope invariant refuses a chat held by a system-class memory, so this branch is
              // not reachable through the API and carries no pin; the guard keeps the plan's rule if that changes.)
              if (chatNode.memoryId !== sysMemId || script.pinned) {
                memoryLayers.push(await buildPrismaMemoryLayer(
                  ctx.db, 'user-memory', chatNode.memoryId, currentStageLoc, turnPersonId,
                ));
              }
              for (const edge of edges) {
                const edgeData = edge.data;
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
                const targetLoc = edge.targetLoc;
                if (!targetLoc) continue;

                const behavior = edgeData.behavior as string ?? 'transition';

                if (targetLoc.startsWith('conversations:') && targetLoc.split(':').length === 2) {
                  // Target is a conversation — conversation handoff
                  const targetConvName = targetLoc.split(':')[1];

                  if (behavior === 'detour') {
                    // Push current goal, transition to the detour conversation
                    chatRootEdits.push((d) => {
                      pushGoal(d, {
                        description: (edgeData.label as string) ?? `Detour to ${targetConvName}`,
                        createdBy: 'ASSISTANT',
                        conversationUrn: targetLoc,
                      });
                    });
                  }

                  // Switch to the target conversation's first stage
                  const targetConv = await script.node(targetLoc);
                  const targetConvData = (targetConv?.data as Record<string, unknown>) ?? {};
                  const targetStages = (targetConvData.stageOrder as string[]) ?? [];
                  const targetFirstStage = targetStages[0];

                  if (targetFirstStage) {
                    conversationHandoff = targetConvName;
                    stageTransitioned = true;
                    newStageName = targetFirstStage;

                    chatRootEdits.push((d) => {
                      d.conversationName = targetConvName;
                      d.stageName = targetFirstStage;
                      appendRouteEntry(d, {
                        conversationUrn: targetLoc,
                        nodeUrn: `${targetLoc}:${targetFirstStage}`,
                        action: 'ENTER',
                        edgeUrn: edge.id,
                        trigger: {
                          type: behavior === 'detour' ? 'DETOUR_EDGE' : 'TRANSITION_EDGE',
                          content: (edgeData.label as string) ?? undefined,
                        },
                      });
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
        chatRootEdits.push((d) => {
          d.lastOffTrackReason = offTrackReason ?? 'unspecified';
          d.lastOffTrackAt = new Date().toISOString();
        });
      }

      // #919: `messageCount` is deliberately absent here — the allocation above
      // already committed it, and `fresh` carries whatever the latest turn
      // wrote, which may be higher than the value this turn allocated.
      await updateChatRootData(ctx.db, chatRef, memEncInfo, (fresh) => {
        const next = { ...fresh, lastMessageAt: new Date().toISOString() };
        for (const edit of chatRootEdits) edit(next);
        return next;
      }, { inTx });

      return {
        displayMessage: message,
        stageTransitioned,
        newStageName,
        // Present only when a name was rejected, so the shape of every other turn's result is unchanged (GraphQL fills null).
        ...(rejectedNextStage !== null ? { rejectedNextStage } : {}),
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

      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw chatNotFoundError(chatId);
      // #1717: a chat has no ACL of its own (cor:acl:030:01) — writing it is
      // writing its host memory, so it takes CURRENT write access there. The
      // lookup's author and memory-creator arms only narrow candidates; they
      // outlive membership, so they must never be the grant.
      await requireMemoryWriteAccess(ctx, chatNode.memoryId);
      const inTx = await chatWriteTx(ctx, chatNode.memoryId);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      const chatRef = { id: chatNode.id, memoryId: chatNode.memoryId, loc: chatNode.loc };

      const encSummary = encryptNodeFields({ content: summary, data: null }, memEncInfo);
      // #664/#752: summary lands under `${chatId}:messages` — lock the ancestor
      // path across the insert (see the message creates above).
      // #919: a summary does NOT consume a message number, but it is named and
      // ordered from the counter, so it reads it under the same lock — against
      // a value no in-flight turn can still change out from under it.
      // #1061 — minted under the lock, recorded after it releases.
      let summaryRef: { id: string; loc: string; memoryId: string } | null = null;
      await withChatRootLock(ctx.db, chatRef, memEncInfo, async ({ tx, counter }) => {
        const messageCount = counter.messageCount;
        const summaryName = `${String(messageCount).padStart(3, '0')}a-summary`;
        const summaryId = generateId();
        const summaryLoc = `${chatId}:messages:${summaryName}`;
        summaryRef = { id: summaryId, loc: summaryLoc, memoryId: chatNode.memoryId };
        await tx.node.create({
          data: {
            id: summaryId, memoryId: chatNode.memoryId,
            loc: summaryLoc, name: summaryName,
            nodeType: 'abstract', content: encSummary.content ?? null, seq: messageCount + 1,
            tags: ['summary'],
            createdBy: ctx.userId ?? null, // Supplied summary: attribute its submitter, not the chat creator.
          },
        });
        // No chat-root write: the summary is not a message.
        return { value: undefined };
      }, { inTx });
      // A summary is not a message, but it IS a node — so it is a write.
      recordNodeUsage(ctx.db, 'write', summaryRef ? [summaryRef] : [], ctx);

      return true;
    },

    // ── Agent AI config (org ADMIN) ─────────────────────────────────

    updateChatTitle: async (
      _: unknown,
      { chatId, title }: { chatId: string; title: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw chatNotFoundError(chatId);
      // #1717: a chat has no ACL of its own (cor:acl:030:01) — writing it is
      // writing its host memory, so it takes CURRENT write access there. The
      // lookup's author and memory-creator arms only narrow candidates; they
      // outlive membership, so they must never be the grant.
      await requireMemoryWriteAccess(ctx, chatNode.memoryId);
      // #1991: provenance is not authority; the shared gate re-runs in tx.
      const inTx = await chatWriteTx(ctx, chatNode.memoryId);
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      // #3501/0208: no-op is checked under the same root lock, before any maintenance.
      await inTx(async tx => {
        await lockPathForCreateUnder(tx, chatNode.memoryId, `${chatNode.loc}:messages`);
        await tx.$queryRaw`SELECT id FROM nodes WHERE id=${chatNode.id} FOR UPDATE`;
        const locked = await tx.node.findUniqueOrThrow({ where: { id: chatNode.id } });
        if (locked.memoryId !== chatNode.memoryId || locked.loc !== chatNode.loc) throw new GraphQLError('Chat authority changed.', { extensions: { code: 'CHAT_AUTHORITY_SCOPE_CHANGED' } });
        const plain = translateSessionExpired(memEncInfo.id, () => decryptNodeFields({ data: locked.data }, memEncInfo)).data as Record<string, unknown> | null;
        if (plain?.title === title.trim()) return;
        await withChatRootLock(ctx.db, chatNode, memEncInfo, async ({ chatData }) => {
          // Only trusted portal identity mints HUMAN; governed token/run/App writes refuse.
          const stamp = await assertAuthoring(tx, chatNode.memoryId, {
            priorRole: locked.role, priorRunnable: locked.isRunnable,
            role: locked.role, runnable: locked.isRunnable, mintHuman: true, authoredChange: true,
          }, authoringFromRequest(ctx));
          return { chatData: { ...chatData, title: title.trim() }, value: undefined,
            persist: async (_tx, stored) => {
              await ensureCurrentNodeRevisionInTransaction(tx, chatNode.id, { expectedMemoryId: chatNode.memoryId });
              const current = await tx.node.findUniqueOrThrow({ where: { id: chatNode.id } });
              await createNodeRevision(tx, buildNodeRevisionSnapshot(current, editorFromAuth(ctx), { changes: ['data'] }));
              await tx.node.update({ where: { id: chatNode.id }, data: {
                data: stored, revisionContentHash: revisionStateHashRefreshMarker(),
                ...clearNodeAuthorship(), ...stamp,
              } });
            },
          };
        }, { inTx: fn => fn(tx) });
      });
      return true;
    },

    deleteChat: async (_: unknown, { chatId }: { chatId: string }, ctx: Context) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #829: narrow to chats this caller is entitled to BEFORE picking one.
      // `loc` is unique per memory, so an attacker who learns a chat id could
      // plant a node at that loc; filtering by entitlement first means it can
      // neither be picked nor block the read. The site's own gate still runs.
      const chatNode = pickChatNode(
        await ctx.db.node.findMany({
          where: await chatLocFilter(ctx.db, chatId, ctx),
          // Oldest wins — a planted duplicate is always newer (#829).
          orderBy: { createdAt: 'asc' as const },
          take: 2,
        }),
        chatId,
      );
      if (!chatNode) throw chatNotFoundError(chatId);
      // #1717: a chat has no ACL of its own (cor:acl:030:01) — writing it is
      // writing its host memory, so it takes CURRENT write access there. The
      // lookup's author and memory-creator arms only narrow candidates; they
      // outlive membership, so they must never be the grant.
      await requireMemoryWriteAccess(ctx, chatNode.memoryId);
      // #1991: provenance is not authority; the shared gate re-runs in tx.
      const inTx = await chatWriteTx(ctx, chatNode.memoryId);
      // Soft-delete the chat node and its messages.
      // #1468 (Codex on #1475) — a legacy chat is an ordinary writable node,
      // so it can carry the spec marker in a minted corpus: the rows are
      // locked and checked before the tombstone, and only those are written.
      // #1717 — bounded to the chat itself: the root and its `:messages`
      // subtree, never every row under the root's loc (that took other
      // users' nodes with it). The prefix is re-checked in JS because a Prisma
      // `startsWith` is an unescaped LIKE; the batch gate then refuses any
      // comment, governed or protected row in scope.
      const messages = `${chatNode.loc}:messages`;
      await inTx(async (tx) => {
        const rows = (await tx.node.findMany({
          where: {
            memoryId: chatNode.memoryId,
            deletedAt: null,
            OR: [
              { id: chatNode.id },
              { loc: messages },
              { loc: { startsWith: `${messages}:` } },
            ],
          },
          select: { id: true, loc: true, role: true, isRunnable: true },
        })).filter((n) => n.id === chatNode.id || n.loc === messages || n.loc.startsWith(`${messages}:`));
        const scope = rows.map((n) => n.id);
        // #1641 — a chat root is never a decision or a log (chatLocFilter), but
        // the subtree it takes may hold a log beneath it; withdrawn, never
        // deleted. Checked before the general governed-kind gate below, which
        // also refuses it, so the caller gets the specific reason.
        await refuseDecisionFamily(tx, scope, 'deleteChat');
        await assertBatchMutable(tx, [chatNode.memoryId], rows, 'delete the chat holding');
        await assertNoMintedSpecRemoval(tx, chatNode.memoryId, scope, 'delete the chat holding');
        await tx.node.updateMany({
          where: { id: { in: scope }, deletedAt: null },
          data: { deletedAt: new Date(), deletedBy: ctx.userId },
        });
      });
      return true;
    },

    // ── App management (org ADMIN) ──────────────────────────────────

};
