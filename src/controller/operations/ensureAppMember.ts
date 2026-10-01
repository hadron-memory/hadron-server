/**
 * Idempotent UPSERT of an AppMember row. Per spec 008-agent-installation
 * FR-004 + FR-016, plus the data-model.md §"maxMembers enforcement" rules.
 *
 * Validation:
 *   1. The role MUST be one of the values in the parent Agent's
 *      `installation_policy.memberRoles`. Throws `InvalidRoleError`
 *      otherwise.
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
): Promise<void> {
  await db.app.findUniqueOrThrow({
    where: { id: appId },
    select: { id: true },
  });
  // 023-app-shape Phase 2b: App→Agent goes through AppAgent (N:M).
  // For installation-policy enforcement at member-add time, use the
  // primary installed Agent. Multi-Agent semantics (which Agent's
  // policy gates which membership) will be revisited in the US1
  // resolvers.
  const primaryAgentId = await getPrimaryAgentId(db, appId);
  if (primaryAgentId === null) throw new OrphanAppError(appId);

  const agent = await db.agent.findUniqueOrThrow({
    where: { id: primaryAgentId },
    select: { installationPolicy: true },
  });
  const policy = agent.installationPolicy as unknown as InstallationPolicy;

  if (!policy.memberRoles.includes(role)) {
    throw new InvalidRoleError(role, policy.memberRoles);
  }

  // Updating an existing member's role: skip the maxMembers check (no new
  // seat is being consumed). Creating a new member: count + compare.
  const maxMembers = policy.maxMembers;
  const admit = async (tx: Prisma.TransactionClient): Promise<void> => {
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
  };
  // A transaction-scoped lock needs a transaction: run in the caller's, or
  // open one.
  if ('$transaction' in db && typeof db.$transaction === 'function') {
    await (db as PrismaClient).$transaction((tx) => admit(tx));
  } else {
    await admit(db as Prisma.TransactionClient);
  }
}
