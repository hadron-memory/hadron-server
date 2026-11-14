/**
 * #3957 (cor:dmo:050:10, :12) — an App's chatbot AI config and the list a chat chooses from.
 *
 *  - `App.chatbotAiConfigId`: readable by whoever may read the App's properties' audience (a member, or whoever
 *    manages the App); anyone else reads null. It is an id, never a key.
 *  - `setAppChatbotAiConfig(appRef, configId)`: whoever manages the App — a platform admin included, even on a
 *    user-owned App (choosing a config never reads, sets or tests a key). A person acting as themselves; an App
 *    key, an impersonation, a run and a worker-bound request are refused. A config that is not one of THIS App's
 *    own (another App's, a deleted one, one that never existed) is refused as one missing-config answer.
 *  - `chatAiConfigChoices(appRef)`: any App member (a platform admin too). A caller who is not a member gets the
 *    answer a missing App gets. The projection carries no key, key preview, params or endpoint.
 *  - `chatEffectiveToolChoice(chatId)` (#4042): the tool-choice decision of the config the chat's turn would use,
 *    through the single-chat read gate `chatHistory` uses (cor:acl:030:01); an unreadable chat answers as a missing one.
 *  - `chatToolChoiceFor(provider, model)` (#4042): the same one predicate for an unsaved pair; pure, any signed-in caller.
 */
import { Prisma } from '../../../generated/prisma/index.js';
import { AiServiceConfigNotFoundError } from '../../../lib/aiConfig.js';
import { effectiveChatToolChoice, listChatAiConfigChoices } from '../../../lib/chatbotAiConfig.js';
import { chatToolChoiceFor } from '../../../lib/llm/chatToolChoice.js';
import { resolveChatHomeAgent } from '../../../lib/chatHomeAgent.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { isRefusedPrincipal } from '../../../lib/auth/requestPrincipal.js';
import { currentActor } from '../../../lib/requestActor.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';
import { chatLocFilter, pickChatNode } from '../../../lib/chatLoc.js';
import { chatNotFoundError } from '../../../lib/chatNotFound.js';
import { translateSessionExpired } from '../../../lib/channels.js';
import { decryptNodeFields, getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { isMemoryReadableCached, isPlatformAdmin, rethrowAiConfigTyped, type Context } from './resolvers.helpers.js';

type AppRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/** A person acting as themself: no App key, impersonation, run, or worker-bound request. */
function isDirectPerson(ctx: Context): boolean {
  return !isRefusedPrincipal(ctx) && currentActor().workerId === null;
}

async function loadApp(ctx: Context, appRef: string): Promise<AppRow> {
  const { id } = await resolveAppRef(ctx.db, appRef);
  const app = await ctx.db.app.findUnique({ where: { id }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app) throw new AppNotFoundError(appRef);
  return app;
}

async function isMember(ctx: Context, app: AppRow): Promise<boolean> {
  if (!ctx.userId) return false;
  const row = await ctx.db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: ctx.userId } }, select: { userId: true } });
  return row !== null;
}

/** Manage, or platform admin: choosing a config reads no key, so the user-owned-App key exception does not apply. */
async function mayChoose(ctx: Context, app: AppRow): Promise<boolean> {
  return isPlatformAdmin(ctx) || managesApp(ctx, app);
}

export const chatbotAiConfigTypeResolvers = {
  chatbotAiConfigId: async (a: { id: string; chatbotAiConfigId?: string | null; organizationId?: string | null; ownerUserId?: string | null }, _: unknown, ctx: Context) => {
    if (!isDirectPerson(ctx)) return null;
    const app = a.organizationId !== undefined && a.ownerUserId !== undefined
      ? { id: a.id, organizationId: a.organizationId, ownerUserId: a.ownerUserId }
      : await ctx.db.app.findUnique({ where: { id: a.id }, select: { id: true, organizationId: true, ownerUserId: true } });
    if (!app) return null;
    if (!(await isMember(ctx, app)) && !(await mayChoose(ctx, app))) return null;
    if (a.chatbotAiConfigId !== undefined) return a.chatbotAiConfigId;
    return (await ctx.db.app.findUnique({ where: { id: a.id }, select: { chatbotAiConfigId: true } }))?.chatbotAiConfigId ?? null;
  },
};

/**
 * #4042: the chat a caller may read, for `chatEffectiveToolChoice`. The same steps `chatHistory` runs, in the same
 * order, built from the same shared pieces (`chatLocFilter`, `pickChatNode`, `isMemoryReadableCached`) and copying
 * none of its rules: sign-in, no impersonation (#876), entitlement-filtered lookup with the oldest node winning
 * (#829), then the host memory's content-read gate (cor:acl:030:01). Unlike `chatHistory`, a denied read answers
 * `chatNotFoundError`, byte-identical to a chat that does not exist, so the answer reveals nothing about which chats exist.
 */
async function readableChatForToolChoice(ctx: Context, chatId: string) {
  if (!ctx.userId) throw unauthenticatedError();
  if (ctx.impersonation) throw forbiddenError();
  const chatNode = pickChatNode(
    await ctx.db.node.findMany({
      where: await chatLocFilter(ctx.db, chatId, ctx),
      orderBy: { createdAt: 'asc' as const },
      take: 2,
    }),
    chatId,
  );
  if (!chatNode) throw chatNotFoundError(chatId);
  if (!(await isMemoryReadableCached(ctx, chatNode.memoryId))) throw chatNotFoundError(chatId);
  return chatNode;
}

export const chatbotAiConfigQueries = {
  chatEffectiveToolChoice: async (_: unknown, { chatId }: { chatId: string }, ctx: Context) => {
    const chatNode = await readableChatForToolChoice(ctx, chatId);
    const memory = await ctx.db.memory.findUnique({
      where: { id: chatNode.memoryId },
      select: { id: true, appId: true, sharedMemoryOfAgentId: true, userMemoryOfAgentId: true },
    });
    if (!memory) throw chatNotFoundError(chatId);
    const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
    const readable = memEncInfo.isEncrypted ? translateSessionExpired(memEncInfo.id, () => decryptNodeFields(chatNode, memEncInfo)) : chatNode;
    const storedChoice = ((readable.data as Record<string, unknown> | null) ?? {}).aiConfigChoice;
    try {
      // The Agent comes from the turn's own lookup (#4076), so a retained pointer, an uninstalled Agent, a soft-deleted
      // one and the legacy-link order all resolve exactly as the turn resolves them.
      const { agent } = await resolveChatHomeAgent(ctx.db, memory, ctx);
      return await effectiveChatToolChoice(ctx.db, { appId: memory.appId, agentId: (agent as { id: string } | null)?.id ?? null, storedChoice });
    } catch (e) {
      return rethrowAiConfigTyped(e);
    }
  },

  // A function of the public predicate, not of any tenant row: no database read, no decrypt, no provider call, no usage.
  chatToolChoiceFor: async (_: unknown, { provider, model }: { provider: string; model: string }, ctx: Context) => {
    if (!ctx.userId && !ctx.appId) throw unauthenticatedError();
    return chatToolChoiceFor(provider, model);
  },

  chatAiConfigChoices: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
    try {
      if (!isDirectPerson(ctx)) throw new AppNotFoundError(appRef);
      const app = await loadApp(ctx, appRef);
      // One answer for a missing App and an App the caller is not in.
      if (!(await isMember(ctx, app)) && !isPlatformAdmin(ctx)) throw new AppNotFoundError(appRef);
      return await listChatAiConfigChoices(ctx.db, app.id);
    } catch (e) {
      return rethrowAiConfigTyped(e);
    }
  },
};

export const chatbotAiConfigMutations = {
  setAppChatbotAiConfig: async (_: unknown, { appRef, configId }: { appRef: string; configId?: string | null }, ctx: Context) => {
    try {
      if (!isDirectPerson(ctx)) throw forbiddenError();
      const app = await loadApp(ctx, appRef);
      if (!(await mayChoose(ctx, app))) {
        // A member knows the App exists; anyone else gets the missing-App answer.
        if (await isMember(ctx, app)) throw forbiddenError();
        throw new AppNotFoundError(appRef);
      }
      // Andi's F2 on #3960: the manager check and the write share one transaction holding the authority anchors, and the
      // gate is judged on the transaction's live context, so a demotion that committed first is seen and refused.
      const anchors = [
        ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
        ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
        { kind: 'app' as const, id: app.id },
      ];
      try {
        await withAuthorizedTx(
          ctx,
          anchors,
          async (txCtx) => {
            if (!(await mayChoose(txCtx, app))) throw forbiddenError();
          },
          async (tx) => {
            if (configId != null) {
              const own = await tx.aiServiceConfig.findFirst({ where: { id: configId, appId: app.id }, select: { id: true } });
              if (!own) throw new AiServiceConfigNotFoundError(configId.slice(0, 128));
            }
            await tx.app.update({ where: { id: app.id }, data: { chatbotAiConfigId: configId ?? null } });
          },
        );
      } catch (e) {
        // The config was deleted between the check and the write: the same answer as a missing one.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
          throw new AiServiceConfigNotFoundError(String(configId).slice(0, 128));
        }
        throw e;
      }
      return await ctx.db.app.findUniqueOrThrow({ where: { id: app.id } });
    } catch (e) {
      return rethrowAiConfigTyped(e);
    }
  },
};

/**
 * The AI config choice stored with a chat, for `resolveAIConfig(chatId:)`. The chat must be one of `appId`'s: a
 * chat of another App, one the caller's chat gate does not admit and an unknown id all answer as a missing chat.
 */
export async function storedChatAiConfigChoice(ctx: Context, chatId: string, appId: string | null): Promise<unknown> {
  const chatNode = pickChatNode(
    await ctx.db.node.findMany({
      where: await chatLocFilter(ctx.db, chatId, ctx),
      orderBy: { createdAt: 'asc' as const },
      take: 2,
    }),
    chatId,
  );
  if (!chatNode || !appId) throw chatNotFoundError(chatId);
  const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId }, select: { appId: true } });
  if (!memory || memory.appId !== appId) throw chatNotFoundError(chatId);
  const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
  if (memEncInfo.isEncrypted) translateSessionExpired(memEncInfo.id, () => decryptNodeFields(chatNode, memEncInfo));
  return ((chatNode.data as Record<string, unknown> | null) ?? {}).aiConfigChoice;
}
