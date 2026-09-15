/**
 * Spec 049 Phase 4 — Channel creation and the App's default Channel
 * (D-2026-09-13-006 / -007 D2).
 *
 * ONE creation core for every path that makes a Channel: `createApp`'s eager
 * provisioning, the team-chat bootstrap (a root that exists gets its row on
 * touch), the `createChannel` mutation, and the one-shot backfill. A Channel
 * row and its chat root are made in the SAME transaction (eager one-to-one is
 * load-bearing — D-006's adversarial round), under the ancestor lock the chat
 * surface already takes, with create-OR-RESTORE on the `@@unique([loc,
 * memoryId])` tombstone (a soft-deleted root still occupies the address).
 *
 * The audience is the host memory's (`cor:acl:030:01`). Only app-class
 * memories host a chat today (`shared ⇔ app`), and this core enforces it: a
 * Channel in a personal memory waits on the chat-host typology (plan §12.1).
 */

import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';
import { generateId } from './id.js';
import { ancestorLocs, lockAncestorsForCreateMany } from './nodeSubtreeLock.js';
import { getMemoryEncryptionInfo, encryptNodeFields } from './nodeCrypto.js';

/** The name of every App's default Channel — the row `chats:team` became. */
export const DEFAULT_CHANNEL_NAME = 'team';

export interface ChannelRow {
  id: string;
  memoryId: string;
  loc: string;
  name: string;
  chatRootNodeId: string;
  lastSeq: number;
  deletedAt: Date | null;
}

/**
 * Give an EXISTING chat root its Channel row (create-or-restore, idempotent),
 * and make it the App's default when the App has none. Used by the team-chat
 * paths and by the backfill; `lastSeq` is left to the caller (the backfill
 * seeds it, the allocator maintains it).
 */
export async function ensureChannelRow(
  db: PrismaClient | Prisma.TransactionClient,
  args: {
    rootId: string;
    memoryId: string;
    loc: string;
    name: string;
    description?: string | null;
    createdBy: string | null;
    asDefaultOfAppId?: string | null;
    lastSeq?: number;
  },
): Promise<ChannelRow> {
  let row = await db.channel.findUnique({ where: { chatRootNodeId: args.rootId } });
  if (!row) {
    try {
      row = await db.channel.create({
        data: {
          id: generateId(),
          memoryId: args.memoryId,
          loc: args.loc,
          name: args.name,
          kind: 'CHAT',
          description: args.description ?? null,
          chatRootNodeId: args.rootId,
          lastSeq: args.lastSeq ?? 0,
          createdBy: args.createdBy,
        },
      });
    } catch (e) {
      // A concurrent first post won the race — use its row.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      row = await db.channel.findUniqueOrThrow({ where: { chatRootNodeId: args.rootId } });
    }
  } else if (row.deletedAt) {
    // The root was restored (the team chat's revive-not-recreate rule): the
    // row follows it, keeping its lastSeq so the watermark survives the cycle.
    row = await db.channel.update({ where: { id: row.id }, data: { deletedAt: null, deletedBy: null } });
  }
  if (args.asDefaultOfAppId) {
    await db.app.updateMany({
      where: { id: args.asDefaultOfAppId, defaultChannelId: null },
      data: { defaultChannelId: row.id },
    });
  }
  return row;
}

/**
 * Create a Channel WITH its chat root — parents, root and `:messages` child —
 * in one transaction under the ancestor lock, create-or-restore per node.
 * Refuses a host memory that is not app-class (the chat-host rule).
 */
export async function ensureChannelWithRoot(
  db: PrismaClient,
  args: {
    memoryId: string;
    loc: string;
    name: string;
    description?: string | null;
    createdBy: string | null;
    asDefaultOfAppId?: string | null;
    /** For the root's `description`. */
    hostLabel?: string;
  },
): Promise<{ channel: ChannelRow; rootId: string }> {
  const memory = await db.memory.findFirst({
    where: { id: args.memoryId, deletedAt: null },
    select: { id: true, class: true },
  });
  if (!memory) throw new GraphQLError('Host memory not found.', { extensions: { code: 'NOT_FOUND' } });
  if (memory.class !== 'app') {
    throw new GraphQLError(
      `A Channel is hosted in an app-class memory; "${memory.class}" cannot host one yet (the chat-host typology, spec 028, is not built).`,
      { extensions: { code: 'CHANNEL_HOST_NOT_APP_CLASS', memoryClass: memory.class } },
    );
  }
  const memEncInfo = await getMemoryEncryptionInfo(db, args.memoryId);
  // Storage keys top-level (D-2026-08-10-004); `scope: 'shared'` for the live
  // chat-scope invariant (`shared ⇔ app`) until D-2026-08-10-005 drops it.
  let rootFields: { content: string | null; data: unknown };
  try {
    rootFields = encryptNodeFields(
      { content: null, data: { scope: 'shared', messageCount: 0, createdAt: new Date().toISOString() } },
      memEncInfo,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('SESSION_EXPIRED')) {
      throw new GraphQLError(e.message, { extensions: { code: 'SESSION_EXPIRED', memoryId: args.memoryId } });
    }
    throw e;
  }
  const messagesLoc = `${args.loc}:messages`;
  const rootId = await db.$transaction(async (tx) => {
    // The Channel OWNS this address: it passes the gate every generic writer is refused by.
    await lockAncestorsForCreateMany(tx, args.memoryId, [args.loc, messagesLoc], { ownedByChannel: true });
    const restoreOrCreate = async (loc: string, create: () => Promise<{ id: string }>): Promise<string> => {
      const existing = await tx.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: args.memoryId } },
        select: { id: true, deletedAt: true },
      });
      if (existing) {
        if (existing.deletedAt) {
          await tx.node.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null } });
        }
        return existing.id;
      }
      return (await create()).id;
    };
    for (const parent of ancestorLocs(args.loc)) {
      await restoreOrCreate(parent, () =>
        tx.node.create({
          data: { id: generateId(), memoryId: args.memoryId, loc: parent, name: parent.split(':').pop()!, nodeType: 'record', createdBy: args.createdBy },
          select: { id: true },
        }),
      );
    }
    const id = await restoreOrCreate(args.loc, () =>
      tx.node.create({
        data: {
          id: generateId(),
          memoryId: args.memoryId,
          loc: args.loc,
          name: args.name === DEFAULT_CHANNEL_NAME ? 'Team chat' : args.name,
          nodeType: 'chat',
          description: args.description ?? (args.hostLabel ? `Channel — ${args.hostLabel}` : null),
          data: (rootFields.data ?? null) as InputJsonValue,
          // Provenance, never a gate (cor:acl:030:01).
          createdBy: args.createdBy,
        },
        select: { id: true },
      }),
    );
    await restoreOrCreate(messagesLoc, () =>
      tx.node.create({
        data: { id: generateId(), memoryId: args.memoryId, loc: messagesLoc, name: 'messages', nodeType: 'record', createdBy: args.createdBy },
        select: { id: true },
      }),
    );
    return id;
  });
  const channel = await ensureChannelRow(db, { ...args, rootId });
  return { channel, rootId };
}

/**
 * The App's default Channel, created EAGERLY at App creation (D-006: nothing
 * is unprotected before the first post) in the App's shared app-class memory —
 * the memory `provisionAppSharedMemory` makes for the founding Agent. Skips,
 * rather than fails, an App with no such memory yet (an Agent declaring
 * `appMemory: 'user' | 'none'`): the first post's bootstrap provisions both.
 */
export async function ensureDefaultChannelForApp(
  db: PrismaClient,
  app: { id: string; name: string },
  createdBy: string | null,
): Promise<ChannelRow | null> {
  const existing = await db.app.findUnique({ where: { id: app.id }, select: { defaultChannelId: true } });
  if (existing?.defaultChannelId) {
    return db.channel.findUnique({ where: { id: existing.defaultChannelId } });
  }
  const memory = await db.memory.findFirst({
    where: { appId: app.id, class: 'app', deletedAt: null, userMemoryOfAgentId: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!memory) return null;
  const { channel } = await ensureChannelWithRoot(db, {
    memoryId: memory.id,
    loc: 'chats:team',
    name: DEFAULT_CHANNEL_NAME,
    description: `Team chat — ${app.name}`,
    createdBy,
    asDefaultOfAppId: app.id,
    hostLabel: app.name,
  });
  return channel;
}
