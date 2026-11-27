/**
 * #5027 (hrn:node:hadronmemory.com:specs:cor:acl:030:01, D-2026-11-26-008): a chat's home is named by memory
 * (`startChat(memoryRef:)`), and the default comes from the Agent (`Agent.defaultChatHome`). Access stays per memory:
 * a chat has no access layer of its own, so a home is judged by the memory's own read and write gates.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import { generateId } from '../../../lib/id.js';
import { type Context, getAccessibleMemoryIds, requireMemoryWriteAccess } from './resolvers.helpers.js';
import { heldAppUserMemoryClasses } from './appUserMemoryEligibility.js';
import { mintAppUserMemoryAddress, isUrnUniqueViolation, conflictWithoutUrn } from './resolvers.mutation.appMemory.js';

/** The four memory classes a chat may live in (D-2026-05-12-007, D-2026-11-26-008). */
export const CHAT_HOME_CLASSES = ['app', 'group', 'personal', 'private'] as const;
export type ChatHomeClass = (typeof CHAT_HOME_CLASSES)[number];
export type ChatHomeDefault = 'APP_SHARED' | 'PERSONAL' | 'PRIVATE';

/** `Chat.scope`, kept for installed clients, is a label derived from the home's class (confirmed mapping, #5027 Ask 6e). */
export function chatScopeLabel(memoryClass: string): 'private' | 'shared' {
  return memoryClass === 'app' || memoryClass === 'group' ? 'shared' : 'private';
}

/**
 * The one refusal for a home that cannot be used, byte-identical for every cause (missing, unreadable, not writable,
 * not a home class, not of this App's scope, an Agent default the caller may not create). It names no memory, App or
 * class, so it discloses nothing about a memory the caller cannot read.
 */
export function chatHomeInvalid(): GraphQLError {
  return new GraphQLError('That memory cannot hold this chat.', { extensions: { code: 'CHAT_HOME_INVALID' } });
}

export type JudgedChatHome = { id: string; class: ChatHomeClass; appId: string; isEncrypted: boolean };

/**
 * Judge `memoryId` as a home for a chat with `agentId`, as the principal `ctx` (pre-transaction, and again on the
 * transaction's context after the anchor wait). Order: exists, read gate (ids only, nothing decrypted), write gate as
 * themselves, home class, App scope (the memory's App must install and license the Agent, and an App-scoped principal
 * may only name its own App's memories). Every miss is {@link chatHomeInvalid}.
 */
export async function judgeChatHome(ctx: Context, memoryId: string, agentId: string): Promise<JudgedChatHome> {
  const row = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { id: true, class: true, appId: true, isEncrypted: true, deletedAt: true },
  });
  if (!row || row.deletedAt) throw chatHomeInvalid();
  const readable = await getAccessibleMemoryIds(ctx, memoryId);
  if (readable !== null && !readable.includes(memoryId)) throw chatHomeInvalid();
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
  } catch (e) {
    const code = (e as GraphQLError)?.extensions?.code;
    if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') throw chatHomeInvalid();
    throw e;
  }
  if (!(CHAT_HOME_CLASSES as readonly string[]).includes(row.class)) throw chatHomeInvalid();
  if (!row.appId) throw chatHomeInvalid();
  if (ctx.appId && ctx.appId !== row.appId) throw chatHomeInvalid();
  const licensed = await activeAppInstallLicenseIdsForAgent(ctx.db, agentId, [row.appId]);
  if (!licensed.has(row.appId)) throw chatHomeInvalid();
  return { id: row.id, class: row.class as ChatHomeClass, appId: row.appId, isEncrypted: row.isEncrypted };
}

/** The person's own marked memory of `klass` in the App (one per class, cor:dmo:060:20), or null. */
export async function findAppUserChatHome(
  db: Context['db'] | Prisma.TransactionClient,
  appId: string,
  userId: string,
  klass: 'personal' | 'private',
): Promise<string | null> {
  const row = await db.memory.findFirst({
    where: { appId, userId, class: klass, appUserMemory: true, deletedAt: null },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * #5027 Ask 3: the signed-in person's own `klass` memory in the App, created when they hold none, by createMemoryInApp's
 * rule (cor:dmo:060:20): the person's own row, derived name and URN, one per class. Runs inside startChat's authority
 * transaction. Lock order as createMemoryInApp: the caller's app_members row FOR UPDATE, then any own tombstone. A memory
 * that a concurrent create committed while we waited is reused, not refused. A URN race loss rolls back to a savepoint and
 * takes the next tail.
 */
export async function provisionAppUserChatHome(
  tx: Prisma.TransactionClient,
  args: { appId: string; userId: string; agentId: string; klass: 'personal' | 'private' },
): Promise<string> {
  const { appId, userId, agentId, klass } = args;
  const member = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id FROM app_members WHERE app_id = ${appId} AND user_id = ${userId} FOR UPDATE`;
  if (member.length === 0) throw chatHomeInvalid();
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await heldAppUserMemoryClasses(tx, appId, userId)).includes(klass)) {
      const existing = await findAppUserChatHome(tx, appId, userId, klass);
      if (existing) return existing;
    }
    await tx.$executeRaw`SAVEPOINT chat_home_provision`;
    try {
      const own = await mintAppUserMemoryAddress(tx, appId, userId, klass);
      const created = await tx.memory.create({
        data: {
          id: generateId(),
          organizationId: null,
          ownerUserId: userId,
          urn: own.urn,
          name: own.name,
          appUserMemory: true,
          tags: [],
          visibility: null,
          class: klass,
          appId,
          userMemoryOfAgentId: agentId,
          userId,
          createdBy: userId,
        },
        select: { id: true },
      });
      await tx.$executeRaw`RELEASE SAVEPOINT chat_home_provision`;
      return created.id;
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT chat_home_provision`;
      await tx.$executeRaw`RELEASE SAVEPOINT chat_home_provision`;
      if (!isUrnUniqueViolation(err)) throw err;
    }
  }
  throw conflictWithoutUrn();
}
