/** #3332: existing App participation gates, extracted without body changes. */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { cachedManagerOrgRole } from './managerOrgRoles.js';
import { authorizationDenied } from './authorizationDenied.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';
import { ROLE_ORDER } from './orgRole.js';

export async function requireOrgRole(
  ctx: Context,
  orgId: string,
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  // Impersonation: the session may only see into its ONE shared org. Without
  // this, a read resolver gating on a NAMED org (dashboard, usage, org detail)
  // would honor the target's memberships in their OTHER orgs. Checked before
  // the platform short-circuit (inert under impersonation anyway — roles: []).
  if (ctx.impersonation && orgId !== ctx.impersonation.orgId) {
    throw authorizationDenied();
  }
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw authorizationDenied();
  // findFirst (not findUnique on the composite PK) so a REVOKED (soft-deleted)
  // membership no longer authorizes — matches getMemberOrgIds / resolveOrgScope
  // and the memory(ref) resolver's own membership check (PR-475 review, Codex
  // P1: a removed member who still knew an agent/app ref could read it).
  const cached = cachedManagerOrgRole(ctx, orgId);
  const member = cached !== undefined ? (cached === null ? null : { role: cached }) : await ctx.db.orgMember.findFirst({
    where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw authorizationDenied();
  }
}


export async function isAppParticipant(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  if (!ctx.userId) return false;
  if (app.ownerUserId !== null) {
    // spec 047 + cor:acl:010:01 (Holger "A", #8151/#8155, #1764): a user-owned App admits its owner and every
    // AppMember at any role, and nobody else. The App has no org, so no org arm exists and no platform-admin arm either
    // (findings:org-xor-owner-null-comparison-bypass — branch on the ownership CLASS first; for two different users'
    // entities BOTH `organizationId`s are NULL, so an org comparison would read `null !== null` and admit exactly the
    // cross-tenant case). Identity-scoped, so never via impersonation (isOwnerOrOrgMember's rule; the team-chat caller
    // already denies org-less Apps under impersonation — this keeps the predicate safe for any future caller that
    // doesn't). User-owned MEMORIES and AGENTS stay strictly owner-only; this is the App's participation alone.
    if (ctx.impersonation) return false;
    if (ctx.userId === app.ownerUserId) return true;
    const member = await ctx.db.appMember.findUnique({
      where: { appId_userId: { appId: app.id, userId: ctx.userId } },
      select: { userId: true },
    });
    return member !== null;
  }
  // #1094 — impersonation NARROWS this predicate to the session's ONE shared
  // org, stated once here rather than per arm. `ctx.userId` is the TARGET under
  // impersonation, so the AppMember lookup below would otherwise answer a
  // question about the target's memberships ANYWHERE — admitting an App in an
  // org the support session was never scoped to. Fifth instance of the #876
  // class (`ctx.userId = target` fails open against identity-keyed predicates),
  // and the first one inside a shared predicate rather than a resolver, which
  // is why `impersonationSweep.test.ts` — a case per resolver MODULE — could
  // not see it.
  //
  // Bounded, not denied, and that is the neighbours' rule rather than a choice
  // made here: `requireOrgRole` and `isOrgMemberOrAdmin` both already read
  // "under impersonation only the shared org may admit". A blanket
  // `if (ctx.impersonation) return false` would have made this arm the only one
  // of the three saying something different, and would have cost an impersonated
  // admin the in-scope team chat and worklog they can legitimately support.
  //
  // The owner arm above denies outright for the SAME rule, not a different one:
  // a user-owned App has no org, so it can never satisfy this bound.
  if (ctx.impersonation && app.organizationId !== ctx.impersonation.orgId) return false;
  if (app.organizationId !== null) {
    const liveOrg = await ctx.db.organization.findFirst({
      where: { id: app.organizationId, deletedAt: null }, select: { id: true },
    });
    if (!liveOrg) return false;
  }
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId: app.id, userId: ctx.userId } },
    select: { userId: true },
  });
  if (member) return true;
  if (app.organizationId !== null) {
    try {
      await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
      return true;
    } catch (e) {
      // requireOrgRole signals denial with a FORBIDDEN GraphQLError whose message
      // is 'Forbidden' (#1493), which this match still catches; anything
      // else (a DB failure inside the membership lookup) must propagate rather
      // than read as "not a member" (review:narrow-catch-blocks — the
      // team-chat original swallowed everything here).
      if (e instanceof Error && e.message === 'Forbidden') return false;
      throw e;
    }
  }
  return false;
}

