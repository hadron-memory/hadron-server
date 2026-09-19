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
 * NOT here: the platform-ADMIN arm. `isAppParticipant` inherits one through
 * `requireOrgRole`, but every consumer of this set answers platform admins in
 * its own branch ABOVE the App fold, so an arm here would be unreachable code
 * carrying real risk. The differential test is scoped to non-admin principals
 * and says so.
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { orgRoleAtLeast } from './orgRole.js';

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
 */
export async function participantAppIds(
  db: Pick<PrismaClient, 'orgMember' | 'app' | 'appMember'>,
  principal: { userId?: string | null; impersonation?: { orgId: string } | null },
  opts: { includeMemberships?: boolean } = {},
): Promise<string[]> {
  const userId = principal.userId;
  if (!userId) return [];

  // findMany + `deletedAt: null`, never findUnique on the composite PK: a
  // REVOKED org membership must not authorize
  // (findings:revoked-membership-auth-gates, the `requireOrgRole` rule).
  const memberships = await db.orgMember.findMany({
    where: {
      userId,
      deletedAt: null,
      ...(principal.impersonation ? { organizationId: principal.impersonation.orgId } : {}),
    },
    select: { organizationId: true, role: true },
  });
  const contributorOrgIds = memberships
    .filter((m) => orgRoleAtLeast(m.role, 'CONTRIBUTOR'))
    .map((m) => m.organizationId);

  const arms: Prisma.AppWhereInput[] = [];
  if (contributorOrgIds.length > 0) arms.push({ organizationId: { in: contributorOrgIds } });
  // Identity-scoped, so never via impersonation.
  if (!principal.impersonation) arms.push({ ownerUserId: userId });
  if (opts.includeMemberships) arms.push({ members: { some: { userId } } });
  if (arms.length === 0) return [];

  const apps = await db.app.findMany({
    where: {
      deletedAt: null,
      uninstalledAt: null,
      // The impersonation bound is applied ONCE, outside the arms, so it
      // governs every arm including any added later. The first version bounded
      // only the org arm, and `includeMemberships` then returned Apps the
      // TARGET belongs to in any other org — contradicting this function's own
      // documented one-org boundary (@copilot on PR #1207). `isAppParticipant`
      // has the same structure for the same reason: it bounds once, above its
      // arms, rather than per arm.
      ...(principal.impersonation ? { organizationId: principal.impersonation.orgId } : {}),
      OR: arms,
    },
    select: { id: true },
  });
  return apps.map((a) => a.id);
}
