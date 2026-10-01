/**
 * requireOrgAction — the grant-model org gate (design:grant-model, P2a).
 *
 * Action-vocabulary replacement for `requireOrgRole` on the memory
 * management mutations: the caller's effective allow-set is
 * union(role bundle, live individual grants), evaluated by
 * `@hadron-memory/access-control`'s `evaluateActionAuthorization`.
 *
 * Behavior-preserving by construction: `DEFAULT_ROLE_BUNDLES` is a faithful
 * transcription of the `requireOrgRole` ladder this gate replaces
 * (ADMIN/OWNER hold memory.create/clone/delete; CONTRIBUTOR does not), and
 * with no PrincipalGrant rows the union adds nothing. A grant row is the
 * NEW capability: it lets a specific member perform a specific action
 * without a role change (the additive exception; cor:acl:040:05).
 *
 * Deliberately NOT here (each a separate, documented decision):
 *   - CEILINGS: the org/user/app policy chain is NOT consulted for
 *     interactive management actions — existing `Organization.policy` rows
 *     were authored to constrain headless RUNS (spec 040), and silently
 *     re-scoping them to interactive mutations would change their meaning.
 *     Wiring ceilings into management actions is a future product decision.
 *   - The platform ADMIN/OWNER bypass stays OUTSIDE the evaluator (same
 *     position as requireOrgRole), per the package's evaluation order.
 *   - cloneMemory's cross-org DESTINATION gate (#604: actual non-reader
 *     membership, no bypass) keeps its bespoke rule — the destination-side
 *     verb has no bundle mapping yet.
 */

import {
  evaluateActionAuthorization,
  type OrgRole,
  type PolicyAction,
} from '@hadron-memory/access-control';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { authorizationDenied } from './authorizationDenied.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/** Minimal caller shape — `Context` satisfies this structurally. */
export interface OrgActionCaller {
  db: PrismaClient;
  userId?: string | null;
  roles?: string[] | null;
  // Admin impersonation (read-only session): management actions are all
  // mutations and already blocked by the read-only plugin; the guard below is
  // belt-and-braces so a future non-mutation caller of this gate stays scoped.
  impersonation?: { orgId: string };
}

/**
 * Throw `Forbidden` unless the caller may perform `action` in org `orgId`.
 *
 * Order: platform ADMIN/OWNER bypass → load the caller's live OrgMember
 * role (findFirst + deletedAt: null — a revoked membership never
 * authorizes, findings:revoked-membership-auth-gates) and live in-scope
 * PrincipalGrants (expiry IN the query: `expiresAt IS NULL OR > now`, the
 * ConnectionGrant-gate pattern) → evaluate the additive union.
 */
export async function requireOrgAction(
  ctx: OrgActionCaller,
  orgId: string,
  action: PolicyAction,
): Promise<void> {
  // Impersonation: only the session's shared org is in scope (mirrors
  // requireOrgRole; checked before the platform bypass).
  if (ctx.impersonation && orgId !== ctx.impersonation.orgId) throw authorizationDenied();
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw authorizationDenied();

  const [member, grants] = await Promise.all([
    ctx.db.orgMember.findFirst({
      where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
      select: { role: true },
    }),
    ctx.db.principalGrant.findMany({
      where: {
        principalType: 'USER',
        principalId: ctx.userId,
        organizationId: orgId,
        deletedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { actions: true },
    }),
  ]);

  // A grant is an exception ON TOP of membership, never a membership
  // substitute: with no LIVE OrgMember row, even a live grant row does not
  // authorize (findings:revoked-membership-auth-gates — revoking the
  // membership instantly cuts every capability, grants included).
  if (!member) throw authorizationDenied();

  const roles: OrgRole[] = [member.role as OrgRole];
  const { allowed } = evaluateActionAuthorization({ action, roles, grants });
  if (!allowed) throw authorizationDenied();
}
