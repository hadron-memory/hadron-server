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
  concealUnreadableDenial,
  loadReadableMemoryRecord,
  resolveOrgScope,
} from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveChannelRefId } from '../../../lib/entityRef/channelRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { nodeUrnRoundTrips, safeNodeUrnV2 } from '../../../lib/urnEmit.js';
import { ensureChannelWithRoot, lockMemoryForChannelChange } from '../../../lib/channels.js';
import { lockPathForCreateUnder } from '../../../lib/nodeSubtreeLock.js';
import { validateLoc } from '../../../lib/validateLoc.js';
import { assertNoMintedSpecRemoval } from '../../../lib/mintedSpecPermanence.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

/**
 * A Channel row as a field resolver may receive it: the `channels` page
 * eager-loads its host memory's urn (below), every other path does not.
 */
type ChannelWithHostUrn = Channel & { memory?: { urn: string } | null };

/** The caller's readable-memory clause, or null for the unrestricted principal. */
async function readableMemoryWhere(ctx: Context): Promise<Prisma.MemoryWhereInput | null> {
  const accessible = await getAccessibleMemoryIds(ctx);
  return accessible === null ? null : { id: { in: accessible } };
}

async function readableChannel(ctx: Context, ref: string): Promise<Channel | null> {
  // #1171: the ref is the Channel's id OR its chat root's node URN — the
  // address `createChannel` accepts. An unresolvable ref reads as a missing
  // one, which is the same answer an unreadable one gets below (§8.6).
  const id = await resolveChannelRefId(ctx.db, ref);
  if (!id) return null;
  const row = await ctx.db.channel.findFirst({ where: { id, deletedAt: null } });
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
      take === 0
        ? Promise.resolve([] as Channel[])
        : ctx.db.channel.findMany({
            where,
            orderBy: [{ loc: 'asc' }, { id: 'asc' }],
            take,
            skip,
            // #1172 (Copilot): `chatRootUrn` needs its host memory's urn, and
            // this page serves up to 200 rows — a per-row field resolver is a
            // straight N+1, and the repo has no DataLoader (see
            // SESSION_INCLUDE in resolvers.helpers.ts, the same call for the
            // same reason). Eager-load the ONE column it needs; the field
            // resolver still falls back for a Channel that arrived by any
            // other path.
            include: { memory: { select: { urn: true } } },
          }),
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
    if (ctx.impersonation) throw forbiddenError();
    if (!ctx.userId) throw unauthenticatedError();
    const memoryRef = input.memoryRef.trim();
    const { id: memoryId } = await resolveMemoryRef(ctx.db, memoryRef);
    // #1316: a memory the caller cannot open answers as resolveMemoryRef's miss.
    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => requireMemoryWriteAccess(ctx, memoryId));
    const loc = input.loc.trim();
    validateLoc(loc);
    const name = input.name.trim();
    if (!name) throw new GraphQLError('name is required.', { extensions: { code: 'BAD_USER_INPUT' } });
    // The overlap check (LOC_OVERLAPS_CHANNEL) and the live-occupant check
    // (LOC_OCCUPIED) live in the core, under the ancestor lock — a preflight
    // here is a decision two concurrent creates can both get wrong.
    const { channel } = await ensureChannelWithRoot(ctx.db, {
      memoryId,
      loc,
      name,
      description: input.description ?? null,
      createdBy: ctx.userId,
      authorizeLockedHost: (tx) => {
        const txCtx = { ...ctx, db: tx } as Context;
        return concealUnreadableDenial(txCtx, memoryId, memoryRef, () => requireMemoryWriteAccess(txCtx, memoryId));
      },
    });
    return ctx.db.channel.findUniqueOrThrow({ where: { id: channel.id } });
  },

  updateChannel: async (
    _: unknown,
    { ref, input }: { ref: string; input: { name?: string | null; description?: string | null } },
    ctx: Context,
  ): Promise<Channel> => {
    if (ctx.impersonation) throw forbiddenError();
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
    if (ctx.impersonation) throw forbiddenError();
    const row = await writableChannel(ctx, ref);
    const now = new Date();
    await ctx.db.$transaction(async (tx) => {
      // Reuse and delete serialize on the host memory. The explicit
      // incarnation token distinguishes reuse from ordinary posts/metadata
      // updates while the stable Channel and root ids stay the same.
      await lockMemoryForChannelChange(tx, row.memoryId);
      // The same key a post takes (`appendChatMessage` locks `<loc>:messages`'
      // path): a post in flight finishes before the tombstone lands and none
      // starts after it, so a deleted Channel never gains messages (Copilot
      // on PR #1165, round 2).
      await lockPathForCreateUnder(tx, row.memoryId, `${row.loc}:messages`, { owns: 'channel' });
      const current = await tx.channel.findUnique({
        where: { id: row.id },
        select: { deletedAt: true, incarnation: true },
      });
      if (
        !current ||
        current.deletedAt ||
        current.incarnation !== row.incarnation
      ) {
        throw new GraphQLError(`No match for channelRef "${ref}".`, { extensions: { code: 'NOT_FOUND' } });
      }
      // Row and root together; the address stays protected while either
      // exists (a tombstoned Channel still guards — protectedLoc.ts).
      // #1468 — the root is a node like any other; a marked one in a minted
      // corpus is permanent.
      await assertNoMintedSpecRemoval(tx, row.memoryId, [row.chatRootNodeId], 'delete the Channel whose root is');
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
    // #2509 (cor:acl:110, cor:api:140:03): the record as Query.memory answers it to this caller, else null. The
    // channel list that handed this row out authorized the CHANNEL; a preloaded host memory authorizes nothing.
    memory: (c: Channel, _: unknown, ctx: Context) => loadReadableMemoryRecord(ctx, c.memoryId),

    /**
     * #1171 — the Channel's address as ONE string every `channelRef` accepts:
     * its chat root's node URN. Emitted here so no client ever COMPOSES it
     * (`conventions:portal-links-from-server-output`, the same rule as node
     * reads' `URL:` line) — a hand-built URN is how a caller ends up addressing
     * a Channel that is not the one they meant. Sibling of `memory`, so it
     * costs the same one lookup that field does.
     *
     * **Null when the address would not round-trip** — a host memory whose
     * STORED urn is pre-v2 compound (the legacy team space
     * `<org>:<app>:<agent>:shared`), one carrying an `@` owner sigil, or a loc
     * `safeEmit` can only serve best-effort. Emitting any of those would hand
     * a client an address this very server refuses (Copilot + Codex on PR
     * #1172, measured), so `nodeUrnRoundTrips` performs the round trip rather
     * than reasoning about the shape. Those Channels are addressed by id — no
     * address beats a broken one, the same call `Node.portalUrl` makes about a
     * link.
     */
    chatRootUrn: async (c: ChannelWithHostUrn, _: unknown, ctx: Context) => {
      const urn =
        c.memory?.urn ??
        (await ctx.db.memory.findUniqueOrThrow({ where: { id: c.memoryId }, select: { urn: true } })).urn;
      return nodeUrnRoundTrips(urn, c.loc) ? safeNodeUrnV2(urn, c.loc) : null;
    },
  },
};
