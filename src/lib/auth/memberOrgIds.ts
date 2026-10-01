/**
 * Org IDs a User principal is a member of — the canonical "which orgs does
 * this user belong to" query.
 *
 * Extracted as a leaf helper (sibling to `getOrgReadableMemoryIds`) so the
 * two global-search surfaces compute an **identical** org scope and cannot
 * re-diverge:
 *   - the GraphQL `globalSearch` resolver (`src/api/graphql/schema/resolvers.ts`), and
 *   - the MCP `hadron_search` tool (`src/mcp/server.ts`).
 *
 * Org membership is the scope for the org-rooted entity slices of global search
 * (Organization / Agent / App / AiServiceConfig). Memory + Node scoping uses the
 * separate memory-access set (`getAccessibleMemoryIds`); this helper is only the
 * org-id list.
 *
 * **Read-only by nature** and **App-Key-blind**: App-Key callers (no `userId`)
 * get no org-read (existing posture), so callers pass `orgIds: []` for them
 * rather than calling this helper.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { LIVE_ORG_MEMBERSHIP } from './liveOrgMembership.js';

export async function getMemberOrgIds(
  db: PrismaClient,
  userId: string,
  // Admin impersonation: the impersonated session may only see into its ONE
  // shared org, so callers with a request Context pass
  // `ctx.impersonation?.orgId` and the membership set collapses to that org
  // (or [] if the target isn't a member). Undefined = no narrowing. Any new
  // org-scope helper should copy this pattern.
  restrictToOrgId?: string,
): Promise<string[]> {
  // Defensive: Prisma silently DROPS an `undefined` where-filter, so a
  // `userId === undefined` slipping through would turn `where: { userId }`
  // into "all memberships" — a catastrophic cross-org read. Fail closed.
  if (!userId) return [];

  const memberships = await db.orgMember.findMany({
    where: {
      userId,
      ...LIVE_ORG_MEMBERSHIP,
      ...(restrictToOrgId ? { organizationId: restrictToOrgId } : {}),
    },
    select: { organizationId: true },
  });
  return memberships.map((m: { organizationId: string }) => m.organizationId);
}
