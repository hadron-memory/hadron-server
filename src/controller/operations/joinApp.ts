/**
 * joinApp — spec 023-app-shape US2 (T027), gated by #1714.
 *
 * Self-service AppMember create for the currently-logged-in user. NO
 * OrgMember check is performed (FR-009) — this is the affordance that
 * unlocks B2C / therapy / consumer deployments where end-users use an App
 * without joining the operator's org.
 *
 * #1714 (Holger's ruling, option D): self-join is CLOSED by default. It is
 * open only when the App's primary Agent opts in by declaring
 * `installation_policy.selfJoinRole` — a role that is one of its
 * `memberRoles` and is never `owner`. Before this, joinApp granted
 * `memberRoles[0]`, which the schema default makes `owner`, so any
 * authenticated user who knew an App's URN could make themselves an App
 * member manager. Promotion to owner or any privileged role stays with the
 * App's managers (the GraphQL `ensureAppMember`), never with self-service.
 *
 * Order: lifecycle errors, then the idempotent re-join (unchanged), then the
 * gate — BEFORE maxMembers / orphan handling, so a refused caller learns
 * nothing about the App's capacity or installation.
 *
 * Idempotent — if the user already has an AppMember row, the existing
 * row is returned with no role change.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { ensureAppMember } from './ensureAppMember.js';
import { AppNotFoundError } from '../../lib/entityRef/errors.js';
import { loadOfferedMemberRoles } from '../../lib/memberRoles.js';

/**
 * #1714: the App's Agent has not opted into self-service joining (no valid
 * `installation_policy.selfJoinRole`). Deliberately says nothing about why,
 * so a stranger cannot probe an App's policy, capacity or installation.
 */
export class SelfJoinNotAllowedError extends Error {
  constructor(appId: string) {
    super(
      `App ${appId} does not allow self-service joining. ` +
        `Ask an App owner or org admin to add you.`,
    );
    this.name = 'SelfJoinNotAllowedError';
  }
}

/**
 * Thrown when joinApp is called against an App in the soft-uninstalled
 * lifecycle phase (spec 021 FR-026). The App row exists but write
 * operations are rejected. Lives in the controller (not the resolver)
 * so direct callers — not just the GraphQL surface — get consistent
 * lifecycle enforcement.
 */
export class AppUninstalledError extends Error {
  constructor(appId: string) {
    super(`Cannot join an uninstalled App (id=${appId}).`);
    this.name = 'AppUninstalledError';
  }
}

type InstallationPolicyShape = {
  memberRoles?: unknown;
  selfJoinRole?: unknown;
};

/** Self-join can never mint an App member manager, whatever the policy says. */
const NEVER_SELF_GRANTED = 'owner';

export async function joinApp(
  db: PrismaClient | Prisma.TransactionClient,
  args: { appId: string; userId: string },
): Promise<{ appId: string; userId: string; role: string }> {
  // Verify the App exists, isn't soft-deleted, and isn't in the
  // soft-uninstalled lifecycle phase (spec 021 FR-026) before either
  // the idempotent return path OR the create path runs. Each state
  // throws its own typed error so callers (GraphQL or direct) get a
  // clear extensions.code mapping rather than a misleading
  // "orphan-no-installed-Agents" message for a missing App.
  const app = await db.app.findUnique({
    where: { id: args.appId },
    select: { id: true, deletedAt: true, uninstalledAt: true },
  });
  if (!app || app.deletedAt) {
    throw new AppNotFoundError(args.appId);
  }
  if (app.uninstalledAt) {
    throw new AppUninstalledError(args.appId);
  }

  // Idempotent: return the existing row if already a member, with no
  // role change. This is the spec's "re-join is a no-op" semantics.
  const existing = await db.appMember.findUnique({
    where: { appId_userId: { appId: args.appId, userId: args.userId } },
  });
  if (existing) {
    return {
      appId: existing.appId,
      userId: existing.userId,
      role: existing.role,
    };
  }

  // #1714 gate: runs before ensureAppMember, so capacity and orphan errors
  // are reachable only by a caller the App admits.
  const selfJoinRole = await resolveSelfJoinRole(db, args.appId);

  await ensureAppMember(db, args.appId, args.userId, selfJoinRole, {
    actorId: args.userId,
  });

  return { appId: args.appId, userId: args.userId, role: selfJoinRole };
}

async function resolveSelfJoinRole(db: PrismaClient | Prisma.TransactionClient, appId: string): Promise<string> {
  // The primary installed Agent's policy, the same Agent ensureAppMember
  // validates against (getPrimaryAgentId: oldest AppAgent). No installed
  // Agent means nothing opted in: refuse rather than reveal the orphan state.
  const appAgent = await db.appAgent.findFirst({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agent: { select: { installationPolicy: true } } },
  });
  const policy = (appAgent?.agent?.installationPolicy ?? {}) as InstallationPolicyShape;
  const role = policy.selfJoinRole;
  // #2171 (R211): the role must be offered by the App, the union over its
  // installed Agents, the same reader ensureAppMember decides with.
  const { roles: memberRoles } = await loadOfferedMemberRoles(db, appId);
  if (typeof role !== 'string' || role === NEVER_SELF_GRANTED || !memberRoles.includes(role)) {
    throw new SelfJoinNotAllowedError(appId);
  }
  return role;
}
