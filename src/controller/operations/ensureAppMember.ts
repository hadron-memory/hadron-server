/**
 * Idempotent UPSERT of an AppMember row. Per spec 008-agent-installation
 * FR-004 + FR-016, plus the data-model.md §"maxMembers enforcement" rules.
 *
 * Validation:
 *   1. The role MUST be one the App offers: the union of the installed
 *      Agents' `installation_policy.memberRoles` (#2171, R211,
 *      cor:dmo:050:04). Decided inside the transaction, under the install
 *      and Agent row fences, so an uninstall or a role edit cannot land
 *      between the read and the insert. Throws `InvalidRoleError` otherwise.
 *      `maxMembers` stays the primary Agent's.
 *   2. When creating a new member (the row does not yet exist), the App's
 *      current member count MUST be strictly less than the Agent's
 *      `installation_policy.maxMembers`. Throws `MaxMembersExceededError`
 *      otherwise. Updating an existing member's role does NOT trigger the
 *      maxMembers check.
 *   3. The App must have at least one installed Agent (an AppAgent
 *      row). An orphan App (no installed Agents) cannot accept members —
 *      throws `OrphanAppError`. Pre-023-Phase-2b this was a `App.agent_id`
 *      check; the column was dropped, so the predicate now consults the
 *      `AppAgent` join via `getPrimaryAgentId`.
 *
 * The maxMembers check is at *invite-acceptance time* (when the row is
 * inserted), not invite-creation time, consistent with the existing
 * OrgMember invite flow.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { getPrimaryAgentId } from '../../lib/appAgent.js';
import { lockAndLoadOfferedMemberRoles } from '../../lib/memberRoles.js';

export class InvalidRoleError extends Error {
  constructor(role: string, allowed: string[]) {
    super(
      `Role "${role}" is not allowed for this App's Agent (allowed: ${allowed.join(', ')})`,
    );
    this.name = 'InvalidRoleError';
  }
}

export class MaxMembersExceededError extends Error {
  constructor(maxMembers: number) {
    super(
      `This App's membership is full — at most ${maxMembers} members can join.`,
    );
    this.name = 'MaxMembersExceededError';
  }
}

export class OrphanAppError extends Error {
  constructor(appId: string) {
    super(
      `App ${appId} has no installed Agents (orphan). Install an Agent ` +
        `via installAgentIntoApp / addAgentToApp before inviting members.`,
    );
    this.name = 'OrphanAppError';
  }
}

type InstallationPolicy = {
  maxMembers: number | 'unlimited';
  memberRoles: string[];
};

export async function ensureAppMember(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  userId: string,
  role: string,
  ctx: { actorId?: string | null } = {},
): Promise<{ priorRole: string | null }> {
  await db.app.findUniqueOrThrow({
    where: { id: appId },
    select: { id: true },
  });
  // 023-app-shape Phase 2b: App→Agent goes through AppAgent (N:M).
  // The primary installed Agent governs capacity (maxMembers); roles are the
  // union over every installed Agent (#2171), read below inside the
  // transaction.
  const primaryAgentId = await getPrimaryAgentId(db, appId);
  if (primaryAgentId === null) throw new OrphanAppError(appId);

  const agent = await db.agent.findUniqueOrThrow({
    where: { id: primaryAgentId },
    select: { installationPolicy: true },
  });
  const policy = agent.installationPolicy as unknown as InstallationPolicy;

  // Updating an existing member's role: skip the maxMembers check (no new
  // seat is being consumed). Creating a new member: count + compare.
  const maxMembers = policy.maxMembers;
  const admit = async (tx: Prisma.TransactionClient): Promise<{ priorRole: string | null }> => {
    // #1573: maxMembers is count-then-act. Every door that adds a member
    // (joinApp, the GraphQL ensureAppMember) reaches this point, so one
    // exclusive per-App capacity lock held through the count and the insert
    // serializes them; two concurrent joins can no longer both see room.
    // A dedicated advisory key rather than an App-row lock: callers already
    // hold the App row FOR SHARE (withAuthorizedTx), and upgrading that to
    // FOR UPDATE would deadlock two joiners.
    if (maxMembers !== 'unlimited') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('app-capacity'), hashtext(${appId}))`;
    }
    // #2171: the deciding role check, after the capacity lock and under the
    // install-row and Agent-row fences, read together as one admission step.
    const offered = await lockAndLoadOfferedMemberRoles(tx, appId);
    if (!offered.installed) throw new OrphanAppError(appId);
    if (!offered.roles.includes(role)) throw new InvalidRoleError(role, offered.roles);
    const existing = await tx.appMember.findUnique({
      where: { appId_userId: { appId, userId } },
    });
    if (!existing && maxMembers !== 'unlimited') {
      const current = await tx.appMember.count({ where: { appId } });
      if (current >= maxMembers) {
        throw new MaxMembersExceededError(maxMembers);
      }
    }

    await tx.appMember.upsert({
      where: { appId_userId: { appId, userId } },
      create: {
        appId,
        userId,
        role,
        createdBy: ctx.actorId ?? null,
      },
      update: {
        role,
        updatedBy: ctx.actorId ?? null,
      },
    });
    // #2766: the role the member held before this call, for the door that records the act.
    return { priorRole: existing?.role ?? null };
  };
  // A transaction-scoped lock needs a transaction: run in the caller's, or
  // open one.
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    return (db as PrismaClient).$transaction((tx) => admit(tx));
  }
  return admit(db as Prisma.TransactionClient);
}
