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
