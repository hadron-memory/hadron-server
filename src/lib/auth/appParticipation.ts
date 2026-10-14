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
  // An AppMember of an org-owned App participates only while its org lives (a deleted org's Apps are not reachable).
  // A USER-owned App's members participate too (#1764, Holger "A", cor:acl:010:01): the App has no org to be deleted, and
  // an impersonated principal never reaches it (the organizationId bound applied once below excludes every org-less
  // App). This arm and `isAppParticipant` must agree on exactly this shape: `chatLocFilter` requests this arm and
  // `sendChatMessage` uses that filter as its write entitlement, so a disagreement is a reachable write (the earlier
  // revision of this comment records the same arm failing the other way, @copilot round 4).
  if (opts.includeMemberships) {
    arms.push({ members: { some: { userId } }, ownerUserId: null, organization: { is: { deletedAt: null } } });
    if (!principal.impersonation) arms.push({ members: { some: { userId } }, ownerUserId: { not: null } });
  }
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

/** The columns the user-owned team-space rule reads off a memory row. */
export type TeamSpaceCandidate = {
  id: string;
  class: string;
  appId: string | null;
  ownerUserId: string | null;
  userMemoryOfAgentId: string | null;
};

/**
 * Which of these memory rows are the TEAM SPACE of a live USER-owned App whose participant `userId` is, as a MEMBER
 * rather than its owner? (#1764, Holger "A", cor:acl:010:01.) The one exception to a user-owned memory being owner-only
 * (spec 047): the App owner's own app-class row (not a Worker's working memory, not a session's) is the App's team
 * space, and a team space's audience is the App's participants. Every other user-owned memory, and every user-owned
 * agent (its system memory included, which is class `system`), stays the owner's alone.
 *
 * THE one definition: every enforcement site that admits a member to a user-owned team space (the MCP access map, the
 * strict-owner fold, the participant write upgrade, the point gates, the access audit) asks this, so the App-liveness,
 * owner-match, shape and membership clauses cannot drift between copies (the failure mode `teamSpace.ts` records for
 * #1207). Identity-scoped, so empty under impersonation (`userId` is the TARGET there). The owner's own path is not
 * here: the owner is not "a member of" their App for this purpose.
 */
export async function userOwnedTeamSpaceIdsForMember(
  db: Pick<PrismaClient, 'app' | 'appMember' | 'worker' | '$queryRaw'>,
  principal: { userId?: string | null; impersonation?: unknown },
  rows: readonly TeamSpaceCandidate[],
  /**
   * For a WRITE decided inside the writer's transaction: re-read the member and the App with `FOR SHARE` and keep
   * them locked to commit, deciding on that locked read. A membership removal (or an uninstall) then either committed
   * before the write is authorized, so the write is refused, or waits for the write's commit (Riana P2, #1786) — the
   * same hold `inTaskWriteTx` keeps for task writes. Outside a transaction the lock ends with the statement, which is
   * harmless: the decision is still made on that read.
   */
  opts: { hold?: boolean } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const userId = principal.userId;
  if (!userId || principal.impersonation) return out;
  const candidates = rows.filter((r) => r.class === 'app' && r.appId !== null && r.ownerUserId !== null &&
    r.ownerUserId !== userId && r.userMemoryOfAgentId === null);
  if (candidates.length === 0) return out;
  const apps = await db.app.findMany({
    where: { id: { in: [...new Set(candidates.map((r) => r.appId!))] }, deletedAt: null, uninstalledAt: null, ownerUserId: { not: null } },
    select: { id: true, ownerUserId: true },
  });
  if (apps.length === 0) return out;
  const ownerOf = new Map(apps.map((a) => [a.id, a.ownerUserId]));
  const memberOf = new Set((await db.appMember.findMany({
    where: { userId, appId: { in: apps.map((a) => a.id) } }, select: { appId: true },
  })).map((m) => m.appId));
  const shaped = candidates.filter((r) => memberOf.has(r.appId!) && ownerOf.get(r.appId!) === r.ownerUserId);
  if (shaped.length === 0) return out;
  if (opts.hold) {
    const appIds = [...new Set(shaped.map((r) => r.appId!))].sort();
    const held = await db.$queryRaw<Array<{ app_id: string }>>`
      SELECT m.app_id FROM app_members m JOIN apps a ON a.id = m.app_id
      WHERE m.user_id = ${userId} AND m.app_id = ANY(${appIds}::text[])
        AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
      ORDER BY m.app_id
      FOR SHARE OF a, m`;
    const stillMember = new Set(held.map((h) => h.app_id));
    for (let i = shaped.length - 1; i >= 0; i--) if (!stillMember.has(shaped[i]!.appId!)) shaped.splice(i, 1);
    if (shaped.length === 0) return out;
  }
  const working = new Set((await db.worker.findMany({
    where: { memoryId: { in: shaped.map((r) => r.id) } }, select: { memoryId: true },
  })).map((w) => w.memoryId));
  for (const r of shaped) if (!working.has(r.id)) out.add(r.id);
  return out;
}

/** {@link userOwnedTeamSpaceIdsForMember} for one row — the point gates' form. */
export async function isUserOwnedTeamSpaceMember(
  db: Pick<PrismaClient, 'app' | 'appMember' | 'worker' | '$queryRaw'>,
  principal: { userId?: string | null; impersonation?: unknown },
  memory: TeamSpaceCandidate,
  opts: { hold?: boolean } = {},
): Promise<boolean> {
  return (await userOwnedTeamSpaceIdsForMember(db, principal, [memory], opts)).has(memory.id);
}
