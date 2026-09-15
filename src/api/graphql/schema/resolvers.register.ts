/**
 * Spec 049 Phase 5 — the register's read + write surface (D-2026-09-13-007).
 *
 * `registerEntry(ref)` / `registerEntries(filter, orgId, …)` follow §8.6: a
 * row is returned to a caller who may read its Channel's host memory or is on
 * the row's owner side; a filter naming a foreign Channel or attendee returns
 * the same empty page as a nonexistent one. Mutations go through the owner
 * gates in `lib/register.ts`; each owner removes its own rows (D4).
 *
 * Nested objects are gated on their OWN entity, never on the outer row
 * (findings:broadening-read-gate-leaks-nested-objects): `channel` is null to
 * an owner-side reader who may not read the host memory; the attendee is
 * exposed as ids + a URN, not as a Worker / Agent object.
 */

import { GraphQLError } from 'graphql';
import { Prisma, type RegisterEntry } from '../../../generated/prisma/index.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
} from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { normalizeUrnForLookup } from '../../../lib/urn.js';
import {
  canReadRegisterEntry,
  readableRegisterWhere,
  registerOwnerIdOf,
  registerOwnerTypeOf,
  requireRegisterOwnerWrite,
  resolveAttendeeFilter,
  resolveChannelFilter,
  resolveChannelForOwner,
  resolveRegisterAttendee,
  resolveRegisterOwnerForWrite,
} from '../../../lib/register.js';
import { generateId } from '../../../lib/id.js';
import { agentRegisterDefaults } from '../../../lib/registerInstall.js';

type RegisterRoleInput = 'WATCH' | 'POST' | 'BOTH';

async function readableEntry(ctx: Context, ref: string): Promise<RegisterEntry | null> {
  const row = await ctx.db.registerEntry.findFirst({
    where: { id: ref.trim(), deletedAt: null },
    include: { channel: { select: { memoryId: true } } },
  });
  if (!row) return null;
  return (await canReadRegisterEntry(ctx, row)) ? row : null;
}

async function writableEntry(ctx: Context, ref: string): Promise<RegisterEntry> {
  if (ctx.impersonation) throw new Error('Forbidden');
  const row = await readableEntry(ctx, ref);
  if (!row) throw new GraphQLError(`No match for registerEntryRef "${ref}".`, { extensions: { code: 'NOT_FOUND' } });
  await requireRegisterOwnerWrite(ctx, row);
  return row;
}

export const registerQueries = {
  registerEntry: async (_: unknown, { ref }: { ref: string }, ctx: Context) => readableEntry(ctx, ref),

  registerEntries: async (
    _: unknown,
    {
      filter,
      orgId,
      limit,
      offset,
    }: {
      filter?: { ownerRef?: string | null; channelRef?: string | null; attendeeRef?: string | null } | null;
      orgId?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    const empty = { items: [] as RegisterEntry[], total: 0 };
    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return empty;
    const and: Prisma.RegisterEntryWhereInput[] = [{ deletedAt: null }];
    const readable = await readableRegisterWhere(ctx);
    if (readable) and.push(readable);
    if (scope.scopedOrgId) {
      and.push({ OR: [{ organizationId: scope.scopedOrgId }, { app: { organizationId: scope.scopedOrgId } }] });
    }
    if (filter?.ownerRef?.trim()) {
      const ref = filter.ownerRef.trim();
      let ownerWhere: Prisma.RegisterEntryWhereInput | null = null;
      try {
        ownerWhere = { appId: (await resolveAppRef(ctx.db, ref)).id };
      } catch {
        try {
          ownerWhere = { organizationId: (await resolveOrgRef(ctx.db, ref)).id };
        } catch {
          return empty;
        }
      }
      and.push(ownerWhere);
    }
    if (filter?.channelRef?.trim()) {
      const channelId = await resolveChannelFilter(ctx, filter.channelRef);
      if (!channelId) return empty;
      and.push({ channelId });
    }
    if (filter?.attendeeRef?.trim()) {
      const attendee = await resolveAttendeeFilter(ctx, filter.attendeeRef);
      if (!attendee) return empty;
      and.push(attendee);
    }
    const where: Prisma.RegisterEntryWhereInput = { AND: and };
    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [total, items] = await Promise.all([
      ctx.db.registerEntry.count({ where }),
      take === 0
        ? Promise.resolve([] as RegisterEntry[])
        : ctx.db.registerEntry.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take, skip }),
    ]);
    return { items, total };
  },
};

export const registerMutations = {
  createRegisterEntry: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        ownerRef: string;
        channelRef: string;
        attendeeRef?: string | null;
        role?: RegisterRoleInput | null;
        mentionOnly?: boolean | null;
        description?: string | null;
      };
    },
    ctx: Context,
  ): Promise<RegisterEntry> => {
    if (ctx.impersonation) throw new Error('Forbidden');
    if (!ctx.userId) throw new Error('Unauthenticated');
    const owner = await resolveRegisterOwnerForWrite(ctx, input.ownerRef);
    const channel = await resolveChannelForOwner(ctx, input.channelRef, owner);
    const attendee = input.attendeeRef?.trim()
      ? await resolveRegisterAttendee(ctx, input.attendeeRef, owner)
      : { attendeeWorkerId: null, attendeeAgentId: null };
    try {
      return await ctx.db.registerEntry.create({
        data: {
          id: generateId(),
          ...owner,
          channelId: channel.id,
          ...attendee,
          role: input.role ?? 'BOTH',
          mentionOnly: input.mentionOnly ?? false,
          description: input.description?.trim() || null,
          createdBy: ctx.userId,
        },
      });
    } catch (e) {
      // The (owner, channel, attendee) partial unique: one live row per key.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new GraphQLError('A live register entry already exists for this owner, Channel and attendee.', {
          extensions: { code: 'REGISTER_ENTRY_EXISTS' },
        });
      }
      throw e;
    }
  },

  updateRegisterEntry: async (
    _: unknown,
    { ref, input }: { ref: string; input: { role?: RegisterRoleInput | null; mentionOnly?: boolean | null; description?: string | null } },
    ctx: Context,
  ): Promise<RegisterEntry> => {
    const row = await writableEntry(ctx, ref);
    return ctx.db.registerEntry.update({
      where: { id: row.id },
      data: {
        ...(input.role != null ? { role: input.role } : {}),
        ...(input.mentionOnly != null ? { mentionOnly: input.mentionOnly } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        updatedBy: ctx.userId ?? null,
      },
    });
  },

  deleteRegisterEntry: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<boolean> => {
    const row = await writableEntry(ctx, ref);
    await ctx.db.registerEntry.update({
      where: { id: row.id },
      data: { deletedAt: new Date(), deletedBy: ctx.userId ?? null },
    });
    return true;
  },
};

export const registerFieldResolvers = {
  Agent: {
    /** Spec 049 Phase 5 — the declared install-row defaults, normalised (null ⇒ platform defaults). */
    registerDefaults: (a: { registerDefaults: unknown }) => agentRegisterDefaults(a.registerDefaults),
  },
  RegisterEntry: {
    ownerType: (r: RegisterEntry) => registerOwnerTypeOf(r),
    ownerId: (r: RegisterEntry) => registerOwnerIdOf(r),
    /** Gated on the host memory — an owner-side reader who may not read it gets null. */
    channel: async (r: RegisterEntry, _: unknown, ctx: Context) => {
      const channel = await ctx.db.channel.findFirst({ where: { id: r.channelId, deletedAt: null } });
      if (!channel) return null;
      const accessible = await getAccessibleMemoryIds(ctx);
      return accessible === null || accessible.includes(channel.memoryId) ? channel : null;
    },
    /** The attendee's URN — a Worker's `hrn:worker:…` or the Agent's URN; null for "every attendee". */
    attendeeUrn: async (r: RegisterEntry, _: unknown, ctx: Context) => {
      if (r.attendeeWorkerId) {
        const w = await ctx.db.worker.findUnique({ where: { id: r.attendeeWorkerId }, select: { slug: true, app: { select: { urn: true } } } });
        if (!w) return null;
        try {
          return composeWorkerUrn(normalizeUrnForLookup(w.app.urn), w.slug);
        } catch {
          return null;
        }
      }
      if (r.attendeeAgentId) {
        return (await ctx.db.agent.findUnique({ where: { id: r.attendeeAgentId }, select: { urn: true } }))?.urn ?? null;
      }
      return null;
    },
  },
};
