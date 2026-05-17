/**
 * isOrgExternalAppMember — spec 023-app-shape US2 / FR-011.
 *
 * "Org-external" describes an AppMember who is NOT also an OrgMember
 * of the App's owning Organization. The B2C / therapy / consumer case:
 * Daisy enrolls in her therapist's "Know Yourself" App without joining
 * Org-Therapist; Alice uses MicroMentor's Juno App without being a
 * MicroMentor employee.
 *
 * **Derived, not stored.** Per FR-011, no `appOnly` column is added to
 * the AppMember table — the predicate is computed at query time from
 * the absence of an OrgMember row in the App's owning Organization.
 * This matches the existing schema (the FK constraints already permit
 * this affordance); spec 023 just codifies it.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

/**
 * Returns true iff the User has an AppMember row in the App but no
 * OrgMember row in the App's owning Organization. Callers that already
 * know the App's organizationId can pass it directly to skip one DB
 * lookup.
 */
export async function isOrgExternalAppMember(
  db: PrismaClient,
  args: { userId: string; appId?: string; organizationId?: string },
): Promise<boolean> {
  let organizationId = args.organizationId;
  if (organizationId === undefined) {
    if (args.appId === undefined) {
      throw new Error(
        'isOrgExternalAppMember requires either appId or organizationId',
      );
    }
    const app = await db.app.findUnique({
      where: { id: args.appId },
      select: { organizationId: true },
    });
    if (!app) return false; // No App → no AppMember relation to speak of.
    organizationId = app.organizationId;
  }
  const orgMember = await db.orgMember.findFirst({
    where: { userId: args.userId, organizationId, deletedAt: null },
    select: { userId: true },
  });
  return orgMember === null;
}
