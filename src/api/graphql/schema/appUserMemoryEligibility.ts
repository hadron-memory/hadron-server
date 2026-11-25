/**
 * #5183 / #5218 (cor:dmo:060:20): the two judgements `createMemoryInApp` makes for a personal or private memory,
 * shared so a read of "which classes may I still create" (#5218) runs the door's own check, never a copy.
 */
import type { Prisma, PrismaClient } from '../../../generated/prisma/index.js';
import { isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';
import { listAppInstallations } from '../../../lib/appInstallations.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import type { Context } from './resolvers.helpers.js';

/** S12 "Person only": true when the caller is NOT the signed-in member acting as themselves. Needs a user id too. */
export function refusedAppUserMemoryPrincipal(ctx: Context): boolean {
  return !ctx.userId || !!(ctx.appKeyId || ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx));
}

/** A user-owned App's personal/private creation is refused until #5186 (A4) builds it; the door and the read ask here. */
export function appAdmitsUserMemories(app: { organizationUrn: string | null }): boolean {
  return !!app.organizationUrn;
}

/** The classes in which the user already holds a live marked memory in the App (the limit's count; no id, no URN). */
export async function heldAppUserMemoryClasses(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  userId: string,
): Promise<Array<'personal' | 'private'>> {
  const rows = await db.memory.findMany({
    where: { appId, userId, appUserMemory: true, deletedAt: null, class: { in: ['personal', 'private'] } },
    select: { class: true },
    distinct: ['class'],
  });
  return rows.map((r) => r.class as 'personal' | 'private');
}

/**
 * #5218 (hrn:node:hadronmemory.com:specs:cor:dmo:060:20, "Asking which classes one may still create", Proposed): the
 * classes `createMemoryInApp` would not refuse for this caller in this App. Built from the caller's own rows only:
 * every query on a memory or a membership is keyed on `ctx.userId`.
 *
 * The door's refusals: the principal; membership; a deleted caller (the door's anchored transaction re-reads it); a
 * user-owned App; no installed and licensed Agent; the one-per-class limit. The door takes one Agent, so a class is
 * creatable when some installed Agent passes. A deleted or uninstalled App and a deleted organization are inside
 * {@link isAgentInstalledAndLicensed}: no Agent is licensed there.
 */
export async function creatableAppUserMemoryClasses(ctx: Context, appId: string): Promise<Array<'personal' | 'private'>> {
  if (refusedAppUserMemoryPrincipal(ctx)) return [];
  const userId = ctx.userId!;
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId, userId } },
    select: {
      user: { select: { deletedAt: true } },
      app: { select: { organization: { select: { urn: true } } } },
    },
  });
  if (!member || member.user.deletedAt) return [];
  if (!appAdmitsUserMemories({ organizationUrn: member.app.organization?.urn ?? null })) return [];
  let installed = false;
  for (const { agentId } of await listAppInstallations(ctx.db, appId)) {
    if (await isAgentInstalledAndLicensed(ctx.db, appId, agentId)) { installed = true; break; }
  }
  if (!installed) return [];
  const held = await heldAppUserMemoryClasses(ctx.db, appId, userId);
  return (['personal', 'private'] as const).filter((klass) => !held.includes(klass));
}
