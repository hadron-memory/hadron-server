/**
 * Admin impersonation — shared types + config for the read-only,
 * shared-org-scoped support sessions (start/stop surface:
 * `resolvers.mutation.impersonation.ts`; token resolution:
 * `src/middleware/auth.ts` resolveJwt).
 *
 * Contract (Holger, 2026-08-04):
 *   - a live org ADMIN/OWNER (or platform admin) may impersonate another
 *     active member of the same org, peer-or-below (ADMIN may not
 *     impersonate an OWNER);
 *   - the impersonated context is READ-ONLY (Apollo plugin blocks every
 *     mutation except stopImpersonation) and carries `roles: []`;
 *   - reads are scoped to the ONE shared org: other org memberships and all
 *     personal/private/user-owned resources are invisible (the org-scope
 *     chokepoints consult `ctx.impersonation`);
 *   - the ImpersonationSession row is both the audit record and the
 *     revocation source of truth.
 */

/**
 * THE peer-or-below authorization rule, shared by `startImpersonation` (mint
 * time) and `resolveJwt` (every request) so the two cannot drift.
 *
 * Both must apply it: re-checking only at mint leaves a live token valid
 * across a role change — promote the target to OWNER, or demote an OWNER
 * actor to ADMIN, and an org ADMIN would be impersonating an org OWNER until
 * expiry (both PR #875 reviewers flagged this independently).
 *
 * @param actorIsPlatformAdmin platform ADMIN/OWNER — OWNER-equivalent, and
 *   needs no membership in the org.
 * @param actorOrgRole the actor's LIVE OrgMember role in the session's org,
 *   or null when they hold none.
 * @param targetOrgRole the target's LIVE OrgMember role, or null when the
 *   target is not (or is no longer) a member.
 */
export function canImpersonate(args: {
  actorIsPlatformAdmin: boolean;
  actorOrgRole: string | null;
  targetOrgRole: string | null;
}): boolean {
  const { actorIsPlatformAdmin, actorOrgRole, targetOrgRole } = args;
  // The target must be a live member of the shared org.
  if (targetOrgRole === null) return false;
  // The actor must administer that org (or be a platform admin).
  if (!actorIsPlatformAdmin && actorOrgRole !== 'ADMIN' && actorOrgRole !== 'OWNER') return false;
  // Peer-or-below: only an OWNER-equivalent may impersonate an org OWNER.
  if (targetOrgRole === 'OWNER' && !actorIsPlatformAdmin && actorOrgRole !== 'OWNER') return false;
  return true;
}

/** Request-context shape attached to `AuthContext.impersonation`. */
export interface ImpersonationContext {
  /** ImpersonationSession.id — the audit row backing this token. */
  sessionId: string;
  /** The admin behind the curtain (User.id). NOT the request's userId. */
  actorUserId: string;
  /** The single org the impersonated session may see into. */
  orgId: string;
  /** Session expiry (mirrors the JWT exp; the row is authoritative). */
  expiresAt: Date;
}

const DEFAULT_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86400;

/**
 * Impersonation-session lifetime in seconds. `IMPERSONATION_TTL_SECONDS`
 * env-tunable, default 1h, clamped to [60s, 24h] so a typo can neither mint
 * an unusably short session nor an effectively unexpiring one.
 */
export function impersonationTtlSeconds(): number {
  const raw = process.env.IMPERSONATION_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed));
}

/**
 * Intersect an org-id set with the impersonation scope: under impersonation
 * only the session's shared org survives; otherwise the set is unchanged.
 * Leaf org-scope helpers take a `restrictToOrgId` param instead where they
 * can push the narrowing into the DB query — this is for post-query sets.
 */
export function narrowOrgIds(
  imp: ImpersonationContext | undefined,
  orgIds: string[],
): string[] {
  return imp ? orgIds.filter((id) => id === imp.orgId) : orgIds;
}
