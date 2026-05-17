/**
 * joinApp — spec 023-app-shape US2 (T027).
 *
 * Self-service AppMember create for the currently-logged-in user.
 * Crucially, NO OrgMember check is performed (FR-009) — this is the
 * affordance that unlocks B2C / therapy / consumer deployments where
 * end-users use an App without joining the operator's org.
 *
 * The role defaults to the first value in the Agent's
 * installation_policy.memberRoles (the conventional "guest"/"owner"
 * slot). maxMembers + orphan-App enforcement is delegated to the
 * existing `ensureAppMember` helper.
 *
 * Idempotent — if the user already has an AppMember row, the existing
 * row is returned with no role change.
 *
 * Note: per spec 023 FR-012 the invite/accept ceremony is OUT OF SCOPE
 * for this spec. v1 joinApp is open — anyone with the App's id can
 * join. A later spec will gate this behind an invitation.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import {
  ensureAppMember,
  OrphanAppError,
} from './ensureAppMember.js';
import { AppNotFoundError } from '../../lib/entityRef/errors.js';

export class NoMemberRolesError extends Error {
  constructor(appId: string) {
    super(
      `App ${appId}'s Agent declares no memberRoles in installationPolicy; ` +
        `joinApp cannot pick a default. Fix the Agent's installation_policy.memberRoles.`,
    );
    this.name = 'NoMemberRolesError';
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
  memberRoles?: string[];
};

export async function joinApp(
  db: PrismaClient,
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

  // Pick the default role from the primary installed Agent's policy.
  // `ensureAppMember` will validate; we just need to choose one of the
  // permitted roles to call it with.
  //
  // Note: this calls `getPrimaryAgentId` indirectly via ensureAppMember
  // (which throws OrphanAppError if there are no installed Agents).
  // For the default-role pick we need the Agent's policy directly, so
  // we look it up here. If there's no primary Agent, ensureAppMember
  // will surface OrphanAppError below.
  const defaultRole = await pickDefaultRole(db, args.appId);

  await ensureAppMember(db, args.appId, args.userId, defaultRole, {
    actorId: args.userId,
  });

  return { appId: args.appId, userId: args.userId, role: defaultRole };
}

async function pickDefaultRole(db: PrismaClient, appId: string): Promise<string> {
  // The Agent's installation_policy.memberRoles is the source of truth.
  // We look up the primary installed Agent's policy here, but defer
  // the "no installed Agent" error to ensureAppMember (it throws
  // OrphanAppError, which the caller already expects).
  const appAgent = await db.appAgent.findFirst({
    where: { appId },
    orderBy: { createdAt: 'asc' },
    select: { agent: { select: { installationPolicy: true } } },
  });
  if (!appAgent) {
    // Surface the same error ensureAppMember would, so the caller
    // doesn't have to handle two distinct shapes.
    throw new OrphanAppError(appId);
  }
  const policy = (appAgent.agent?.installationPolicy ?? {}) as InstallationPolicyShape;
  const roles = policy.memberRoles ?? [];
  if (roles.length === 0) {
    throw new NoMemberRolesError(appId);
  }
  return roles[0];
}
