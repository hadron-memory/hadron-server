/**
 * Spec 049 Phase 4 — Channel creation and the App's default Channel
 * (D-2026-09-13-006 / -007 D2).
 *
 * ONE creation core for every path that makes a Channel: `createApp`'s eager
 * provisioning, the team-chat bootstrap (a root that exists gets its row on
 * touch), the `createChannel` mutation, and the one-shot backfill. A Channel
 * row, its chat root and the App default link are made in the SAME
 * transaction (eager one-to-one is load-bearing — D-006's adversarial round;
 * a root committed before its row is an unprotected address for the length
 * of the gap, Codex/Copilot on PR #1165), under the ancestor lock the chat
 * surface already takes, with create-OR-RESTORE on the `@@unique([loc,
 * memoryId])` tombstone (a soft-deleted root still occupies the address).
 *
 * Under that lock the core also decides the two things only the lock can
 * decide: that no other Channel's address overlaps this one (the resolver's
 * preflight cannot — two creates can both pass it), and that the address is
 * not occupied by a LIVE node that is not a chat root (a Channel adopting an
 * arbitrary record would later delete a node nobody made a Channel).
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
import { locsOverlap } from './protectedLoc.js';
import { ensureInstallRegisterRows } from './registerInstall.js';
import { resolveAppTeamSpaceMemoryIds } from '../api/graphql/schema/resolvers.helpers.js';

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
 * The memory-level advisory lock Channel creation and `deleteMemory` share,
 * so "is this memory live?" / "does this memory host a Channel?" cannot be
 * answered on both sides at once (Copilot on PR #1165, round 2). The
 * one-argument form keys a different space from the (memory, loc) pairs the
 * subtree locks use, so it never contends with them.
 */
export async function lockMemoryForChannelChange(tx: Prisma.TransactionClient, memoryId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'channel-host:' + memoryId}))`;
}

/**
 * Refuse an address that overlaps another Channel's in this memory (live or
 * tombstoned — the reservation is what protection means). The SAME address is
 * not a clash: that is the idempotent create-or-restore case. Run it under the
 * ancestor lock, where the answer is authoritative.
 */
export async function assertNoChannelOverlap(
  db: PrismaClient | Prisma.TransactionClient,
  memoryId: string,
  loc: string,
): Promise<void> {
  const rows = await db.channel.findMany({ where: { memoryId }, select: { loc: true, name: true } });
  const clash = rows.find((c) => c.loc !== loc && locsOverlap(c.loc, loc));
  if (clash) {
    throw new GraphQLError(`"${loc}" overlaps Channel "${clash.name}" (${clash.loc}).`, {
      extensions: { code: 'LOC_OVERLAPS_CHANNEL', loc, channelLoc: clash.loc },
    });
  }
}

/**
 * Give an EXISTING chat root its Channel row (create-or-restore, idempotent),
 * and make it the App's default when the App has none. Used by the creation
 * core (inside its transaction, under the lock), by the team-chat paths for a
 * root that predates Channels, and by the backfill; `lastSeq` is left to the
 * caller (the backfill seeds it, the allocator maintains it).
 *
 * Outside a lock two first posts can race to the row: the loser's P2002 is
 * absorbed and the winner's row used. Inside a transaction that P2002 would
 * poison the transaction — so a transactional caller MUST hold the ancestor
 * lock, which serializes the race away.
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
    const set = await db.app.updateMany({
      where: { id: args.asDefaultOfAppId, defaultChannelId: null },
      data: { defaultChannelId: row.id },
    });
    // Spec 049 Phase 5 (D2): the moment an App gets its default Channel,
    // every live install gets its materialised register row.
    if (set.count > 0) await ensureInstallRegisterRows(db, args.asDefaultOfAppId, { createdBy: args.createdBy });
  }
  return row;
}

/**
 * Create a Channel WITH its chat root — parents, root, `:messages` child, the
 * row and the App default link — in one transaction under the ancestor lock,
 * create-or-restore per node. Refuses a host memory that is not app-class
 * (the chat-host rule), an address overlapping another Channel's
 * (`LOC_OVERLAPS_CHANNEL`), and a live occupant that is not a chat root
 * (`LOC_OCCUPIED`).
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
  return db.$transaction(async (tx) => {
    // The Channel OWNS this address: it passes the gate every generic writer is
    // refused by. The lock set always includes `args.loc` itself (the
    // `:messages` child's parent), so a concurrent generic write of the root
    // and a concurrent Channel create on an overlapping address both queue
    // here and re-check after the grant.
    await lockMemoryForChannelChange(tx, args.memoryId);
    // Re-checked under that lock: the preflight above ran outside it.
    const live = await tx.memory.findFirst({ where: { id: args.memoryId, deletedAt: null }, select: { id: true } });
    if (!live) throw new GraphQLError('Host memory not found.', { extensions: { code: 'NOT_FOUND' } });
    await lockAncestorsForCreateMany(tx, args.memoryId, [args.loc, messagesLoc], { owns: 'channel' });
    await assertNoChannelOverlap(tx, args.memoryId, args.loc);
    const restoreOrCreate = async (
      loc: string,
      create: () => Promise<{ id: string }>,
      accept: (row: { nodeType: string; deletedAt: Date | null }) => boolean = () => true,
    ): Promise<string> => {
      const existing = await tx.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: args.memoryId } },
        select: { id: true, deletedAt: true, nodeType: true },
      });
      if (existing) {
        if (!accept(existing)) {
          throw new GraphQLError(
            `"${loc}" is occupied by a live ${existing.nodeType} node; a Channel adopts only a chat root. Move or delete it first.`,
            { extensions: { code: 'LOC_OCCUPIED', loc, nodeType: existing.nodeType } },
          );
        }
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
    const rootId = await restoreOrCreate(
      args.loc,
      () =>
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
      // A chat root (live or tombstoned) is adopted; anything else live is a
      // collision — a tombstoned non-chat is restored AS the root only if it
      // was a chat, so it is refused too.
      (row) => row.nodeType === 'chat',
    );
    await restoreOrCreate(messagesLoc, () =>
      tx.node.create({
        data: { id: generateId(), memoryId: args.memoryId, loc: messagesLoc, name: 'messages', nodeType: 'record', createdBy: args.createdBy },
        select: { id: true },
      }),
    );
    const channel = await ensureChannelRow(tx, { ...args, rootId });
    return { channel, rootId };
  });
}

/**
 * The App's team-space memory — the app-class memory hosting `chats:team` —
 * for a Channel to be provisioned in. Uses the canonical team-space resolver
 * (`resolveAppTeamSpaceMemoryIds`): a bare `appId + class:'app'` would admit
 * a Worker's casting memory or a name-addressable App memory (Copilot on PR
 * #1165). Oldest wins when several qualify — the order `locateTeamChatRoot`
 * uses for the root itself.
 */
export async function resolveTeamSpaceMemoryForApp(db: PrismaClient, appId: string): Promise<string | null> {
  const ids = await resolveAppTeamSpaceMemoryIds(db, appId);
  return ids[0] ?? null;
}

/**
 * The App's default Channel, created EAGERLY at App creation (D-006: nothing
 * is unprotected before the first post) in the App's team-space memory —
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
  const memoryId = await resolveTeamSpaceMemoryForApp(db, app.id);
  if (!memoryId) return null;
  const { channel } = await ensureChannelWithRoot(db, {
    memoryId,
    loc: 'chats:team',
    name: DEFAULT_CHANNEL_NAME,
    description: `Team chat — ${app.name}`,
    createdBy,
    asDefaultOfAppId: app.id,
    hostLabel: app.name,
  });
  return channel;
}
