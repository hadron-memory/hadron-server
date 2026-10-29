/**
 * Spec 049 Phase 5 — the chat register's gates and reference resolution
 * (D-2026-09-13-007, §14 corrections 1–2; plan §3.5, §8.3, §8.6).
 *
 * A RegisterEntry is OWNED by exactly one of an organization or an App (S1,
 * parameterised: Agent-owned rows do not exist) and names an ATTENDEE — a
 * Worker when cast, otherwise an Agent in an App — or nobody, meaning every
 * attendee in the owner's context. The register never grants (D-008): what a
 * row's attendee may actually read or post is the Channel's host memory's
 * decision, evaluated by `resolveRegister` (Phase 6). Everything that decides
 * what a row MEANS lives here so the GraphQL resolvers and the MCP tools
 * cannot drift.
 *
 * Gates (plan §8.3 / §8.6):
 *   - write: org rows need org CONTRIBUTOR+; App rows need ADMIN of the owning
 *     org or the owner of a user-owned App — the shared predicates, never a
 *     bespoke check;
 *   - read: a row is returned to a caller who may read the Channel's host
 *     memory OR is the row's owner-side (org member for an org row, App
 *     participant for an App row); a foreign ref reads as "no match".
 */

import { GraphQLError } from 'graphql';
import type { Prisma, RegisterEntry } from '../generated/prisma/index.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import {
  getAccessibleMemoryIds,
  isAppParticipant,
  isOrgMemberOrAdmin,
  requireOrgRole,
  requireOwnerOrOrgRole,
} from '../api/graphql/schema/resolvers.helpers.js';
import { resolveAppRef } from './entityRef/appRef.js';
import { resolveChannelRefId } from './entityRef/channelRef.js';
import { resolveOrgRef } from './entityRef/orgRef.js';
import { resolveWorkerRef } from './entityRef/workerRef.js';
import { resolveAgentRef } from './entityRef/agentRef.js';
import { LIVE_ORG_MEMBERSHIP } from './auth/liveOrgMembership.js';
import { forbiddenError } from './refusals.js';

export type RegisterOwnerType = 'ORGANIZATION' | 'APP';

/** The S1 owner columns — exactly one non-null (CHECK `chk_register_owner`). */
export interface RegisterOwnerColumns {
  organizationId: string | null;
  appId: string | null;
}

export interface RegisterAttendeeColumns {
  attendeeWorkerId: string | null;
  attendeeAgentId: string | null;
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

export function registerOwnerTypeOf(r: RegisterOwnerColumns): RegisterOwnerType {
  return r.appId ? 'APP' : 'ORGANIZATION';
}

export function registerOwnerIdOf(r: RegisterOwnerColumns): string {
  return (r.appId ?? r.organizationId) as string;
}

/**
 * Turn a caller's owner ref (an App or an organization — URN or id) into the
 * S1 columns, gated for WRITE. An App ref is tried first; a ref that names
 * neither is "no match" (no existence oracle across the two kinds).
 */
export async function resolveRegisterOwnerForWrite(ctx: Context, ownerRef: string): Promise<RegisterOwnerColumns> {
  const ref = ownerRef.trim();
  if (!ref) throw badInput('ownerRef is required: an App or an organization (URN or id).');
  // An App first; anything the App resolver refuses (not found, or an org-shaped
  // URN it will not qualify) falls through to the organization resolver.
  let appId: string | null = null;
  try {
    appId = (await resolveAppRef(ctx.db, ref)).id;
  } catch {
    appId = null;
  }
  if (appId) {
    const owner = { organizationId: null, appId };
    await requireRegisterOwnerWrite(ctx, owner);
    return owner;
  }
  let organizationId: string;
  try {
    organizationId = (await resolveOrgRef(ctx.db, ref)).id;
  } catch {
    throw badInput(`No match for ownerRef "${ref}".`);
  }
  const owner = { organizationId, appId: null };
  await requireRegisterOwnerWrite(ctx, owner);
  return owner;
}

/** The WRITE gate on a row's owner — the same rules at create, update and delete. */
export async function requireRegisterOwnerWrite(ctx: Context, owner: RegisterOwnerColumns): Promise<void> {
  if (owner.organizationId) return requireOrgRole(ctx, owner.organizationId, 'CONTRIBUTOR');
  // Live AND installed: an uninstalled App must not keep supplying its owner
  // to the write gate (the scope rule, Copilot on PR #1160).
  const app = await ctx.db.app.findFirst({
    where: { id: owner.appId!, deletedAt: null, uninstalledAt: null },
    select: { organizationId: true, ownerUserId: true },
  });
  if (!app) throw forbiddenError();
  return requireOwnerOrOrgRole(ctx, app, 'ADMIN');
}

/**
 * The READ gate (§8.6): the Channel's host memory readable, OR the caller is
 * on the row's owner side. A pure App-key principal reads its own App's rows
 * and whatever its memory access admits.
 */
export async function canReadRegisterEntry(
  ctx: Context,
  row: RegisterOwnerColumns & { channel: { memoryId: string } },
): Promise<boolean> {
  const accessible = await getAccessibleMemoryIds(ctx);
  if (accessible === null || accessible.includes(row.channel.memoryId)) return true;
  if (row.appId) {
    if (!ctx.userId) return ctx.appId === row.appId;
    const app = await ctx.db.app.findFirst({
      where: { id: row.appId, deletedAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    return !!app && (await isAppParticipant(ctx, app));
  }
  if (!ctx.userId) return false;
  return isOrgMemberOrAdmin(ctx, row.organizationId!);
}

/**
 * The Channel a row names, as the OWNER may see it (§8.6): live, and either
 * its host memory is readable by the caller or it is hosted inside the
 * owner's own context — the owner App's memory, or a memory of the owner
 * organization. Anything else is "no match": a register row is never the way
 * to learn a foreign Channel exists.
 */
export async function resolveChannelForOwner(
  ctx: Context,
  channelRef: string,
  owner: RegisterOwnerColumns,
): Promise<{ id: string; memoryId: string }> {
  const ref = channelRef.trim();
  const refuse = () => badInput(`No match for channelRef "${ref}".`);
  // #1171: id OR the chat root's node URN; an unresolvable ref is the same
  // refusal a foreign one gets — the register never discloses a Channel.
  const id = await resolveChannelRefId(ctx.db, ref);
  if (!id) throw refuse();
  const row = await ctx.db.channel.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, memoryId: true, memory: { select: { appId: true, organizationId: true } } },
  });
  if (!row) throw refuse();
  const accessible = await getAccessibleMemoryIds(ctx);
  const readable = accessible === null || accessible.includes(row.memoryId);
  const inOwnerContext = owner.appId
    ? row.memory.appId === owner.appId
    : row.memory.organizationId !== null && row.memory.organizationId === owner.organizationId;
  if (!readable && !inOwnerContext) throw refuse();
  return { id: row.id, memoryId: row.memoryId };
}

/**
 * A Channel ref for a LIST filter — the rows themselves are bounded by
 * `readableRegisterWhere`. Takes the id or the chat root's node URN (#1171);
 * `null` for anything that resolves to nothing, which the caller turns into an
 * empty page rather than a refusal (a filter naming nothing matches nothing).
 */
export async function resolveChannelFilter(ctx: Context, channelRef: string): Promise<string | null> {
  const id = await resolveChannelRefId(ctx.db, channelRef);
  if (!id) return null;
  const row = await ctx.db.channel.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * Resolve an attendee ref — a Worker (URN or id) or an Agent (URN or id) —
 * and check it is IN THE OWNER'S CONTEXT: a Worker cast in the row's App (or
 * in an App of the row's org); an Agent installed in the row's App (or in an
 * App of the row's org). Anything else is "no match".
 */
export async function resolveRegisterAttendee(
  ctx: Context,
  attendeeRef: string,
  owner: RegisterOwnerColumns,
): Promise<RegisterAttendeeColumns> {
  const ref = attendeeRef.trim();
  const refuse = () => badInput(`No match for attendeeRef "${ref}" in this owner's context.`);
  // A Worker first; anything the Worker resolver refuses (not found, or an
  // Agent-shaped URN) falls through to the Agent resolver.
  let workerId: string | null = null;
  try {
    workerId = (await resolveWorkerRef(ctx.db, ref)).id;
  } catch {
    workerId = null;
  }
  if (workerId) {
    const worker = await ctx.db.worker.findFirst({
      where: { id: workerId },
      select: { appId: true, app: { select: { organizationId: true } } },
    });
    if (!worker) throw refuse();
    const inContext = owner.appId ? worker.appId === owner.appId : worker.app.organizationId === owner.organizationId;
    if (!inContext) throw refuse();
    return { attendeeWorkerId: workerId, attendeeAgentId: null };
  }
  let agentId: string;
  try {
    agentId = (await resolveAgentRef(ctx.db, ref)).id;
  } catch {
    throw refuse();
  }
  const install = await ctx.db.appAgent.findFirst({
    where: owner.appId
      ? { appId: owner.appId, agentId }
      : { agentId, app: { organizationId: owner.organizationId, deletedAt: null } },
    select: { agentId: true },
  });
  if (!install) throw refuse();
  return { attendeeWorkerId: null, attendeeAgentId: agentId };
}

/** A row's attendee, resolved from a ref for a LIST filter — null when it names nothing (⇒ empty page, no oracle). */
export async function resolveAttendeeFilter(
  ctx: Context,
  attendeeRef: string,
): Promise<Prisma.RegisterEntryWhereInput | null> {
  const ref = attendeeRef.trim();
  try {
    const { id } = await resolveWorkerRef(ctx.db, ref);
    return { attendeeWorkerId: id };
  } catch {
    // not a Worker — try an Agent
  }
  try {
    const { id } = await resolveAgentRef(ctx.db, ref);
    return { attendeeAgentId: id };
  } catch {
    return null;
  }
}

/** The rows a caller may READ, as a where-clause: the §8.6 gate in SQL for the list surface. */
export async function readableRegisterWhere(ctx: Context): Promise<Prisma.RegisterEntryWhereInput | null> {
  const accessible = await getAccessibleMemoryIds(ctx);
  if (accessible === null) return null;
  const arms: Prisma.RegisterEntryWhereInput[] = [{ channel: { memoryId: { in: accessible } } }];
  if (!ctx.userId) {
    if (ctx.appId) arms.push({ appId: ctx.appId });
    return { OR: arms };
  }
  const memberships = await ctx.db.orgMember.findMany({
    where: {
      userId: ctx.userId,
      ...LIVE_ORG_MEMBERSHIP,
      ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
    },
    select: { organizationId: true, role: true },
  });
  const memberOrgIds = memberships.map((m) => m.organizationId);
  const contributorOrgIds = memberships.filter((m) => m.role !== 'READER').map((m) => m.organizationId);
  if (memberOrgIds.length) arms.push({ organizationId: { in: memberOrgIds } });
  // App participation as `isAppParticipant` defines it: AppMember at any
  // role, org CONTRIBUTOR+, or the owner of a user-owned App. Under
  // impersonation the whole arm is bounded to the support session's single
  // org and the user-owned arm is dropped — exactly what `isAppParticipant`
  // does for the single-row path (Codex/Copilot on PR #1166): a list must
  // never enumerate what the single read denies.
  const impersonatedOrg = ctx.impersonation?.orgId ?? null;
  arms.push({
    app: {
      deletedAt: null,
      ...(impersonatedOrg ? { organizationId: impersonatedOrg } : {}),
      OR: [
        { members: { some: { userId: ctx.userId } } },
        ...(impersonatedOrg ? [] : [{ ownerUserId: ctx.userId }]),
        ...(contributorOrgIds.length ? [{ organizationId: { in: contributorOrgIds } }] : []),
      ],
    },
  });
  return { OR: arms };
}

export type { RegisterEntry };
