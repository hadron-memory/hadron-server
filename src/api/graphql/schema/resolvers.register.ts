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
import { withAuthorizedTx } from './authorizedTx.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import { Prisma, type RegisterEntry } from '../../../generated/prisma/index.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  resolveOrgScope,
} from './resolvers.helpers.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveChannelRefId } from '../../../lib/entityRef/channelRef.js';
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
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { isAppParticipant } from './resolvers.helpers.js';
import { collectRegisterRows, resolveRegister, toGqlRegisterRows, type RegisterAttendee } from '../../../lib/resolveRegister.js';
import { advanceReadState, readStateIncarnations } from '../../../lib/channelReadState.js';
import { OPEN_SESSION_SCAN_CAP, isSessionLive, loadLastEventBySession, recentlyTouchedFilter } from '../../../lib/sessionActivity.js';

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

/** Register changes can revoke a batch's resolved channel policy. Use the
 * same owner domain that delivery acknowledgements hold shared, exclusively
 * through the write/commit. Org-owned defaults share the App's org anchor.
 */
async function withRegisterOwnerWrite<T>(
  ctx: Context,
  owner: { appId: string | null; organizationId: string | null },
  write: (tx: Prisma.TransactionClient, txCtx: Context) => Promise<T>,
): Promise<T> {
  const anchors: AuthorityAnchor[] = owner.appId
    ? [{ kind: 'app', id: owner.appId }]
    : [{ kind: 'org', id: owner.organizationId! }];
  return withAuthorizedTx(ctx, anchors, txCtx => requireRegisterOwnerWrite(txCtx, owner), write, { lockMode: 'exclusive' });
}

export const registerQueries = {
  registerEntry: async (_: unknown, { ref }: { ref: string }, ctx: Context) => readableEntry(ctx, ref),

  /**
   * Spec 049 Phase 6 — an attendee's resolved register. Gated on App
   * participation (the Worker's App, or the given App) — the same gate the
   * Worker's briefing sits behind; anything foreign or nonexistent is an
   * empty list, never an oracle.
   */
  attendeeRegister: async (
    _: unknown,
    { workerRef, agentRef, appRef }: { workerRef?: string | null; agentRef?: string | null; appRef?: string | null },
    ctx: Context,
  ) => {
    let attendee: RegisterAttendee | null = null;
    let appId: string | null = null;
    if (workerRef?.trim()) {
      try {
        const { id } = await resolveWorkerRef(ctx.db, workerRef);
        const w = await ctx.db.worker.findUnique({ where: { id }, select: { appId: true } });
        if (w) {
          attendee = { workerId: id };
          appId = w.appId;
        }
      } catch {
        return [];
      }
    } else if (agentRef?.trim() && appRef?.trim()) {
      try {
        const [{ id: agentId }, { id: resolvedAppId }] = await Promise.all([resolveAgentRef(ctx.db, agentRef), resolveAppRef(ctx.db, appRef)]);
        attendee = { agentId, appId: resolvedAppId };
        appId = resolvedAppId;
      } catch {
        return [];
      }
    } else {
      throw new GraphQLError('Pass workerRef, or agentRef with appRef.', { extensions: { code: 'BAD_USER_INPUT' } });
    }
    if (!attendee || !appId) return [];
    const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
    if (!app) return [];
    const admitted = ctx.userId ? await isAppParticipant(ctx, app) : ctx.appId === app.id;
    if (!admitted) return [];
    const view = await resolveRegister(ctx.db, { attendee, actor: ctx, accessActor: 'ATTENDEE' });
    return view ? toGqlRegisterRows(view) : [];
  },

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

/**
 * Phase 7 — resolve an attendee ref for the read-state surface and check the
 * caller may READ it (App participation, the briefing's gate). Null ⇒ "no
 * match" to this caller.
 */
async function readableAttendee(
  ctx: Context,
  attendeeRef: string,
  appRef: string | null | undefined,
): Promise<{ attendee: RegisterAttendee; appId: string; workerAppId: string | null } | null> {
  let attendee: RegisterAttendee | null = null;
  let appId: string | null = null;
  let workerAppId: string | null = null;
  try {
    const { id } = await resolveWorkerRef(ctx.db, attendeeRef);
    const w = await ctx.db.worker.findUnique({ where: { id }, select: { appId: true } });
    if (w) {
      attendee = { workerId: id };
      appId = w.appId;
      workerAppId = w.appId;
    }
  } catch {
    // not a Worker
  }
  if (!attendee) {
    if (!appRef?.trim()) return null;
    try {
      const [{ id: agentId }, { id: resolvedAppId }] = await Promise.all([resolveAgentRef(ctx.db, attendeeRef), resolveAppRef(ctx.db, appRef)]);
      // An Agent-in-App attendee EXISTS only as a live install — the same
      // rule resolveRegister's attendeeColumns applies (Codex P1 on PR #1168).
      const install = await ctx.db.appAgent.findUnique({ where: { appId_agentId: { appId: resolvedAppId, agentId } }, select: { agentId: true } });
      if (!install) return null;
      attendee = { agentId, appId: resolvedAppId };
      appId = resolvedAppId;
    } catch {
      return null;
    }
  }
  if (!attendee || !appId) return null;
  const app = await ctx.db.app.findFirst({ where: { id: appId, deletedAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
  if (!app) return null;
  const admitted = ctx.userId ? await isAppParticipant(ctx, app) : ctx.appId === app.id;
  return admitted ? { attendee, appId, workerAppId } : null;
}

/**
 * §8.7 — the read-state WRITER gate: the caller must be the attendee's
 * driver. A Worker attendee: a user with a LIVE session bound to that Worker
 * (the shared liveness predicate, cor:agt:020:11), or the App-key principal
 * of the Worker's App (the relay's shape). An Agent-in-App attendee has no
 * human driver: only its App's key principal. Anyone else is refused —
 * otherwise one caller could advance another attendee's cursor and silence
 * its attention.
 */
async function requireReadStateDriver(ctx: Context, attendee: RegisterAttendee, appId: string): Promise<void> {
  if (ctx.impersonation) throw new Error('Forbidden');
  if (!ctx.userId) {
    if (ctx.appId && ctx.appId === appId) return;
    throw new Error('Forbidden');
  }
  if (!('workerId' in attendee)) throw new Error('Forbidden');
  const now = new Date();
  const open = await ctx.db.session.findMany({
    where: { workerId: attendee.workerId, userId: ctx.userId, endedAt: null, deletedAt: null, ...recentlyTouchedFilter(now) },
    orderBy: [{ updatedAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
    select: { id: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
    take: OPEN_SESSION_SCAN_CAP,
  });
  const events = await loadLastEventBySession(ctx.db as never, open.map((s) => s.id));
  if (!open.some((s) => isSessionLive(s, events.get(s.id), now))) throw new Error('Forbidden');
}

/**
 * The Channel a read-state read/write names, admitted only when it is IN THE
 * ATTENDEE'S REGISTER (Codex P1 on PR #1168): a cursor exists per registered
 * Channel, and a foreign or unregistered Channel reads as "no match" — never
 * the way to learn it exists, never a row for a Channel nobody attends.
 */
async function registeredChannel(
  ctx: Context,
  attendee: RegisterAttendee,
  channelRef: string,
): Promise<{ id: string; lastSeq: number } | null> {
  // #1171: id OR the chat root's node URN. Resolved to an id FIRST, because
  // the register check compares ids — a URN compared against `r.channelId`
  // would miss every time and read as "not registered", which is the same
  // answer this returns for a foreign Channel and so would have been silent.
  const id = await resolveChannelRefId(ctx.db, channelRef ?? '');
  if (!id) return null;
  const collected = await collectRegisterRows(ctx.db, attendee);
  if (!collected || !collected.rows.some((r) => r.channelId === id)) return null;
  return ctx.db.channel.findFirst({ where: { id, deletedAt: null }, select: { id: true, lastSeq: true } });
}

async function readStateRow(ctx: Context, attendee: RegisterAttendee, channelId: string) {
  const row = await ctx.db.channelReadState.findFirst({
    where: { channelId, ...('workerId' in attendee ? { workerId: attendee.workerId } : { agentId: attendee.agentId, appId: attendee.appId }) },
  });
  // Only the attendee URN is needed here; no access fields are projected.
  const view = await resolveRegister(ctx.db, { attendee, rows: [] });
  const incarnations = await readStateIncarnations(ctx.db, attendee, channelId);
  return { attendeeUrn: view?.attendeeUrn ?? null, channelId, lastSeenSeq: row?.lastSeenSeq ?? 0, updatedAt: row?.updatedAt ?? new Date(0), ...incarnations };
}

export const readStateQueries = {
  channelReadState: async (
    _: unknown,
    { attendeeRef, appRef, channelRef }: { attendeeRef: string; appRef?: string | null; channelRef: string },
    ctx: Context,
  ) => {
    const resolved = await readableAttendee(ctx, attendeeRef, appRef);
    if (!resolved) return null;
    const channel = await registeredChannel(ctx, resolved.attendee, channelRef);
    if (!channel) return null;
    return readStateRow(ctx, resolved.attendee, channel.id);
  },
};

export const readStateMutations = {
  advanceChannelReadState: async (
    _: unknown,
    { attendeeRef, appRef, channelRef, seq }: { attendeeRef: string; appRef?: string | null; channelRef: string; seq: number },
    ctx: Context,
  ) => {
    const resolved = await readableAttendee(ctx, attendeeRef, appRef);
    if (!resolved) throw new GraphQLError(`No match for attendeeRef "${attendeeRef}".`, { extensions: { code: 'NOT_FOUND' } });
    await requireReadStateDriver(ctx, resolved.attendee, resolved.appId);
    const channel = await registeredChannel(ctx, resolved.attendee, channelRef);
    if (!channel) throw new GraphQLError(`No match for channelRef "${channelRef}".`, { extensions: { code: 'NOT_FOUND' } });
    if (!Number.isInteger(seq) || seq < 0) throw new GraphQLError('seq must be a non-negative integer.', { extensions: { code: 'BAD_USER_INPUT' } });
    // A cursor past the watermark could never be corrected downward (every
    // later write is GREATEST) and would suppress attention until the Channel
    // caught up — stale relay state after a restore is the realistic source
    // (Codex P2 on PR #1168). Refused, with the watermark named.
    if (seq > channel.lastSeq) {
      throw new GraphQLError(`seq ${seq} is beyond the Channel's watermark (${channel.lastSeq}).`, {
        extensions: { code: 'SEQ_BEYOND_WATERMARK', lastSeq: channel.lastSeq },
      });
    }
    await advanceReadState(ctx.db, resolved.attendee, channel.id, seq);
    return readStateRow(ctx, resolved.attendee, channel.id);
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
      return await withRegisterOwnerWrite(ctx, owner, tx => tx.registerEntry.create({
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
      }));
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
    return withRegisterOwnerWrite(ctx, row, async (tx, txCtx) => {
      const current = await writableEntry(txCtx, row.id);
      return tx.registerEntry.update({
        where: { id: current.id },
        data: {
          ...(input.role != null ? { role: input.role } : {}),
          ...(input.mentionOnly != null ? { mentionOnly: input.mentionOnly } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          updatedBy: ctx.userId ?? null,
        },
      });
    });
  },

  deleteRegisterEntry: async (_: unknown, { ref }: { ref: string }, ctx: Context): Promise<boolean> => {
    const row = await writableEntry(ctx, ref);
    return withRegisterOwnerWrite(ctx, row, async (tx, txCtx) => {
      const current = await writableEntry(txCtx, row.id);
      await tx.registerEntry.update({
        where: { id: current.id },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? null },
      });
      return true;
    });
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
      // #1172 (Codex): hydrate the host memory's urn, because `Channel`'s own
      // `chatRootUrn` needs it — a register page serves up to 200 rows, and
      // without this each one costs a SECOND query behind this one.
      const channel = await ctx.db.channel.findFirst({
        where: { id: r.channelId, deletedAt: null },
        include: { memory: { select: { urn: true } } },
      });
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
