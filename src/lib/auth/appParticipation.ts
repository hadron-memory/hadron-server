import { canBypassUserOwnership } from './platformAdminBypass.js';
/**
 * App PARTICIPATION as a SET — "which Apps does this user participate in?" — for
 * the gates that need a `where` clause rather than a yes/no about one App.
 *
 * [`cor:acl:010:01`](hrn:node:hadronmemory.com:specs:cor:acl:010:01) defines a
 * participant as *"an App member at any role, an org `CONTRIBUTOR`+ on the App's
 * org, or the owner of a user-owned App"*, and names *"re-keying the team
 * space's audience off participation (e.g. onto the member table alone)"* as
 * invalidating. `isAppParticipant` is the per-App predicate; this is the same
 * rule as a set, and #1196 has two callers that need it that way:
 *
 *   - `participantTeamSpaceFolds` (mcp/access-control.ts) — the App-derived
 *     read fold;
 *   - `chatLocFilter` (lib/chatLoc.ts) — the agent-chat loc prefilter, whose
 *     own contract is that it is a SUPERSET of every chat surface's gate. That
 *     property broke the moment `chatHistory` started gating on the shared
 *     participation audience while this prefilter still keyed on AppMember
 *     rows: an org CONTRIBUTOR passed the real gate and was filtered out before
 *     reaching it (@copilot on PR #1207).
 *
 * Extracting it is the point rather than a tidy-up — a set copy and a predicate
 * copy of one audience is exactly the drift #1196 exists to remove, so adding a
 * third spelling to fix the second would have been the wrong repair. The two
 * implementations are pinned against each other by a differential test in
 * `mcp/access-control.participation.test.ts`.
 *
 * #1734: the shared platform bypass is included so point and set gates agree
 * on user-owned Apps too. Impersonation and App-key boundaries are unchanged.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { orgRoleAtLeast } from './orgRole.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

/**
 * The ids of every live App this user PARTICIPATES in.
 *
 * Impersonation narrows it exactly as `isAppParticipant` narrows (#876 class —
 * `userId` is the TARGET, so an unbounded arm answers a question about the
 * target's memberships anywhere): the org arm is bounded to the support
 * session's ONE shared org, and the user-owned-App owner arm is denied
 * outright, being identity-scoped and org-less by construction.
 *
 * @param opts.includeMemberships  Include Apps reached by an `AppMember` row.
 *   `false` returns ONLY the two arms the member table cannot express — what
 *   the access-control fold wants, since its other branches already cover
 *   member Apps and re-folding them would be redundant work.
 * @param opts.includeUninstalled  Preserve uninstalled Apps for historical
 *   read surfaces whose rows remain legible after uninstall. Defaults false,
 *   so existing chat and memory consumers remain live-App-only.
 */
export async function participantAppIds(
  db: Pick<PrismaClient, 'orgMember' | 'app' | 'appMember'>,
  principal: { userId?: string | null; roles?: readonly string[] | null; clientId?: string | null; impersonation?: { orgId: string } | null },
  opts: { includeMemberships?: boolean; includeUninstalled?: boolean } = {},
): Promise<string[]> {
  const where = await participantAppWhere(db, principal, opts);
  if (!where) return [];
  const apps = await db.app.findMany({ where, select: { id: true } });
  return apps.map((a) => a.id);
}

/**
 * {@link participantAppIds} as a `where` over Apps rather than an id list —
 * the SAME arms (that function now runs this one), for a caller that filters
 * through the App relation instead of binding every participating App into
 * `IN (…)`: an org CONTRIBUTOR participates in every App of the org, so the id
 * list grows with the org (#1347 review). Only the caller's own org
 * memberships are read eagerly. `null` means "no App at all".
 */
export async function participantAppWhere(
  db: Pick<PrismaClient, 'orgMember'>,
  principal: { userId?: string | null; roles?: readonly string[] | null; clientId?: string | null; impersonation?: { orgId: string } | null },
  opts: { includeMemberships?: boolean; includeUninstalled?: boolean } = {},
): Promise<Prisma.AppWhereInput | null> {
  const userId = principal.userId;
  if (!userId) return null;
  if (canBypassUserOwnership({ ...principal, userId }, 'app')) {
    return { deletedAt: null, ...(opts.includeUninstalled ? {} : { uninstalledAt: null }) };
  }

  // findMany + `deletedAt: null`, never findUnique on the composite PK: a
  // REVOKED org membership must not authorize
  // (findings:revoked-membership-auth-gates, the `requireOrgRole` rule).
  const memberships = await db.orgMember.findMany({
    where: {
      userId,
      ...LIVE_ORG_MEMBERSHIP,
      ...(principal.impersonation ? { organizationId: principal.impersonation.orgId } : {}),
    },
    select: { organizationId: true, role: true },
  });
  const contributorOrgIds = memberships
    .filter((m) => orgRoleAtLeast(m.role, 'CONTRIBUTOR'))
    .map((m) => m.organizationId);

  const arms: Prisma.AppWhereInput[] = [];
  if (contributorOrgIds.length > 0) arms.push({
    organizationId: { in: contributorOrgIds }, organization: { is: { deletedAt: null } },
  });
  // Identity-scoped, so never via impersonation.
  if (!principal.impersonation) arms.push({ ownerUserId: userId });
  // `ownerUserId: null` is load-bearing, not tidiness (@copilot round 4).
  // `isAppParticipant` returns IMMEDIATELY for a user-owned App and admits only
  // its owner — spec 047, `cor:acl:010:01`: "a user-owned App admits its owner
  // and nobody else". Without this clause the membership arm admitted any
  // AppMember of one, so the set and the predicate disagreed on exactly the
  // shape they most need to agree on. `chatLocFilter` requests this arm and
  // `sendChatMessage` uses that filter as its write entitlement, so the
  // disagreement was reachable: a non-owner who joins a user-owned App could
  // append to its chat. A user-owned App is reachable here ONLY through the
  // owner arm above.
  if (opts.includeMemberships) arms.push({
    members: { some: { userId } }, ownerUserId: null,
    organization: { is: { deletedAt: null } },
  });
  if (arms.length === 0) return null;

  return {
    deletedAt: null,
    ...(opts.includeUninstalled ? {} : { uninstalledAt: null }),
    // The impersonation bound is applied ONCE, outside the arms, so it
    // governs every arm including any added later. The first version bounded
    // only the org arm, and `includeMemberships` then returned Apps the
    // TARGET belongs to in any other org — contradicting this function's own
    // documented one-org boundary (@copilot on PR #1207). `isAppParticipant`
    // has the same structure for the same reason: it bounds once, above its
    // arms, rather than per arm.
    ...(principal.impersonation ? { organizationId: principal.impersonation.orgId } : {}),
    OR: arms,
  };
}
