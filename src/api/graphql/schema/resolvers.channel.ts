/**
 * Spec 049 Phase 4 — the Channel read + write surface (D-2026-09-13-006).
 *
 * Reads follow the HOST MEMORY (plan §8.6, `cor:acl:030:01`): a Channel is
 * returned to a caller who may read its memory; a foreign or nonexistent ref
 * reads the same. Writes need host-memory write access; creation goes
 * through the one core (`lib/channels.ts`) every path uses. A Channel and its
 * root are deleted together and the address stays protected while either
 * exists (§8.5 / §12 item 7).
 */

import { GraphQLError } from 'graphql';
import type { Channel, Prisma } from '../../../generated/prisma/index.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  requireMemoryWriteAccess,
  resolveOrgScope,
} from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { ensureChannelWithRoot } from '../../../lib/channels.js';
import { locsOverlap } from '../../../lib/protectedLoc.js';
import { validateLoc } from '../../../lib/validateLoc.js';

/** The caller's readable-memory clause, or null for the unrestricted principal. */
async function readableMemoryWhere(ctx: Context): Promise<Prisma.MemoryWhereInput | null> {
  const accessible = await getAccessibleMemoryIds(ctx);
  return accessible === null ? null : { id: { in: accessible } };
}

async function readableChannel(ctx: Context, ref: string): Promise<Channel | null> {
  const row = await ctx.db.channel.findFirst({ where: { id: ref.trim(), deletedAt: null } });
  if (!row) return null;
  const accessible = await getAccessibleMemoryIds(ctx);
  if (accessible !== null && !accessible.includes(row.memoryId)) return null;
  return row;
}

async function writableChannel(ctx: Context, ref: string): Promise<Channel> {
  const row = await readableChannel(ctx, ref);
  if (!row) throw new GraphQLError(`No match for channelRef "${ref}".`, { extensions: { code: 'NOT_FOUND' } });
  await requireMemoryWriteAccess(ctx, row.memoryId);
  return row;
}

export const channelQueries = {
  channel: async (_: unknown, { ref }: { ref: string }, ctx: Context) => readableChannel(ctx, ref),

  channels: async (
    _: unknown,
    { filter, orgId, limit, offset }: { filter?: { appRef?: string | null; memoryRef?: string | null } | null; orgId?: string | null; limit?: number | null; offset?: number | null },
    ctx: Context,
  ) => {
    const empty = { items: [] as Channel[], total: 0 };
    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return empty;
    const memoryWhere: Prisma.MemoryWhereInput[] = [{ deletedAt: null }];
    const readable = await readableMemoryWhere(ctx);
    if (readable) memoryWhere.push(readable);
    if (scope.scopedOrgId) memoryWhere.push({ organizationId: scope.scopedOrgId });
    if (filter?.memoryRef) {
      try {
        memoryWhere.push({ id: (await resolveMemoryRef(ctx.db, filter.memoryRef.trim())).id });
      } catch {
        return empty;
      }
    }
    if (filter?.appRef) {
      try {
        memoryWhere.push({ appId: (await resolveAppRef(ctx.db, filter.appRef.trim())).id });
      } catch {
        return empty;
      }
    }
    const where: Prisma.ChannelWhereInput = { deletedAt: null, memory: { AND: memoryWhere } };
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [total, items] = await Promise.all([
      ctx.db.channel.count({ where }),
      take === 0 ? Promise.resolve([] as Channel[]) : ctx.db.channel.findMany({ where, orderBy: [{ loc: 'asc' }, { id: 'asc' }], take, skip }),
    ]);
    return { items, total };
  },
};

export const channelMutations = {
  createChannel: async (
    _: unknown,
    { input }: { input: { memoryRef: string; loc: string; name: string; description?: string | null } },
    ctx: Context,
  ): Promise<Channel> => {
    if (ctx.impersonation) throw new Error('Forbidden');
    if (!ctx.userId) throw new Error('Unauthenticated');
    const { id: memoryId } = await resolveMemoryRef(ctx.db, input.memoryRef.trim());
    await requireMemoryWriteAccess(ctx, memoryId);
    const loc = input.loc.trim();
    validateLoc(loc);
    const name = input.name.trim();
    if (!name) throw new GraphQLError('name is required.', { extensions: { code: 'BAD_USER_INPUT' } });
    // No overlap with an existing Channel's address (live or tombstoned):
    // the reservation is what protection means.
    const existing = await ctx.db.channel.findMany({ where: { memoryId }, select: { loc: true, name: true } });
    const clash = existing.find((c) => locsOverlap(c.loc, loc));
    if (clash) {
      throw new GraphQLError(`"${loc}" overlaps Channel "${clash.name}" (${clash.loc}).`, {
        extensions: { code: 'LOC_OVERLAPS_CHANNEL', channelLoc: clash.loc },
      });
    }
    const { channel } = await ensureChannelWithRoot(ctx.db, {
      memoryId,
      loc,
      name,
      description: input.description ?? null,
      createdBy: ctx.userId,
    });
    return ctx.db.channel.findUniqueOrThrow({ where: { id: channel.id } });
  },

  updateChannel: async (
    _: unknown,
    { ref, input }: { ref: string; input: { name?: string | null; description?: string | null } },
    ctx: Context,
  ): Promise<Channel> => {
    if (ctx.impersonation) throw new Error('Forbidden');
    const row = await writableChannel(ctx, ref);
    const name = input.name != null ? input.name.trim() : undefined;
    if (name !== undefined && !name) throw new GraphQLError('name must be non-empty.', { extensions: { code: 'BAD_USER_INPUT' } });
    return ctx.db.channel.update({
      where: { id: row.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        updatedBy: ctx.userId ?? null,
      },
    });
  },

  deleteChannel: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<boolean> => {
    if (ctx.impersonation) throw new Error('Forbidden');
    const row = await writableChannel(ctx, ref);
    const now = new Date();
    await ctx.db.$transaction(async (tx) => {
      // Row and root together; the address stays protected while either
      // exists (a tombstoned Channel still guards — protectedLoc.ts).
      await tx.channel.update({ where: { id: row.id }, data: { deletedAt: now, deletedBy: ctx.userId ?? null } });
      await tx.node.updateMany({
        where: { id: row.chatRootNodeId, deletedAt: null },
        data: { deletedAt: now, deletedBy: ctx.userId ?? null },
      });
      await tx.app.updateMany({ where: { defaultChannelId: row.id }, data: { defaultChannelId: null } });
    });
    return true;
  },
};

export const channelFieldResolvers = {
  Channel: {
    memory: (c: Channel, _: unknown, ctx: Context) => ctx.db.memory.findUnique({ where: { id: c.memoryId } }),
  },
};
