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
 */
import { Prisma } from '../../../generated/prisma/index.js';
import { AiServiceConfigNotFoundError } from '../../../lib/aiConfig.js';
import { listChatAiConfigChoices } from '../../../lib/chatbotAiConfig.js';
import { managesApp } from '../../../lib/auth/appManagement.js';
import { isRefusedPrincipal } from '../../../lib/auth/requestPrincipal.js';
import { currentActor } from '../../../lib/requestActor.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { forbiddenError } from '../../../lib/refusals.js';
import { chatLocFilter, pickChatNode } from '../../../lib/chatLoc.js';
import { chatNotFoundError } from '../../../lib/chatNotFound.js';
import { translateSessionExpired } from '../../../lib/channels.js';
import { decryptNodeFields, getMemoryEncryptionInfo } from '../../../lib/nodeCrypto.js';
import { isPlatformAdmin, rethrowAiConfigTyped, type Context } from './resolvers.helpers.js';

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

export const chatbotAiConfigQueries = {
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
      if (configId != null) {
        const own = await ctx.db.aiServiceConfig.findFirst({ where: { id: configId, appId: app.id }, select: { id: true } });
        if (!own) throw new AiServiceConfigNotFoundError(configId.slice(0, 128));
      }
      try {
        await ctx.db.app.update({ where: { id: app.id }, data: { chatbotAiConfigId: configId ?? null } });
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
