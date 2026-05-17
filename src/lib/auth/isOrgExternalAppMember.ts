/**
 * isOrgExternalAppMember — spec 023-app-shape US2 / FR-011.
 *
 * "Org-external" describes an AppMember who is NOT also an OrgMember
 * of the App's owning Organization. The B2C / therapy / consumer case:
 * a client of an operator-org enrolls in one of the operator's Apps
 * without joining the operator's org.
 *
 * **Derived, not stored.** Per FR-011, no `appOnly` column is added to
 * the AppMember table — the predicate is computed at query time from
 * the absence of an OrgMember row in the App's owning Organization.
 * This matches the existing schema (the FK constraints already permit
 * this affordance); spec 023 just codifies it.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

/**
 * Returns true iff the User has an AppMember row in the App AND has
 * NO OrgMember row in the App's owning Organization. Both halves must
 * be checked — without the AppMember verification, the function would
 * return `true` for any non-org-member regardless of whether they
 * actually use the App, which would mis-name the predicate.
 *
 * `appId` is always required. `organizationId` is an optional
 * optimization: when supplied, the App-row lookup is skipped (the
 * caller is asserting it already knows the App's owning org id). This
 * is meant for hot paths where the App row was just fetched anyway —
 * e.g., an `AppMember` resolver where `parent.app.organizationId` is
 * already loaded by the include.
 */
export async function isOrgExternalAppMember(
  db: PrismaClient,
  args: { userId: string; appId: string; organizationId?: string },
): Promise<boolean> {
  // First half: AppMember row must exist. Without this, the predicate
  // would silently return true for any non-org-member, which is wrong
  // relative to the function name.
  const appMember = await db.appMember.findUnique({
    where: { appId_userId: { appId: args.appId, userId: args.userId } },
    select: { userId: true },
  });
  if (appMember === null) return false;

  // Second half: NO OrgMember row in the App's owning org.
  let organizationId = args.organizationId;
  if (organizationId === undefined) {
    const app = await db.app.findUnique({
      where: { id: args.appId },
      select: { organizationId: true },
    });
    if (!app) return false; // App vanished mid-call — degenerate; report false.
    organizationId = app.organizationId;
  }
  const orgMember = await db.orgMember.findFirst({
    where: { userId: args.userId, organizationId, deletedAt: null },
    select: { userId: true },
  });
  return orgMember === null;
}
