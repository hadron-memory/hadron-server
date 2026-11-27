import { listAppInstallationsWithDerivedLicense } from '../appAgent.js';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';

/**
 * True if `userId` has a live relationship with the App: an AppMember, or an
 * ACTIVE AgentSubscription to one of the App's agents. Active is the data-model
 * predicate (activatedAt set, not revoked, not expired) — not merely
 * `revokedAt: null` — so a not-yet-activated or expired subscription does NOT
 * authorize a run (Codex/Copilot #566). #5077: or the person who owns the App. Shared by trigger edits, manual-run pre-checks, and automation evidence.
 */
export async function hasAppRelationship(
  db: PrismaClient | Prisma.TransactionClient,
  appId: string,
  userId: string,
): Promise<boolean> {
  const member = await db.appMember.findFirst({
    where: { appId, userId },
    select: { userId: true },
  });
  if (member) return true;
  const installations = await listAppInstallationsWithDerivedLicense(db, appId);
  if (!installations.length) return false;
  const now = new Date();
  const sub = await db.agentSubscription.findFirst({
    where: {
      userId,
      activatedAt: { not: null },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      agentId: { in: installations.map(row => row.agentId) },
    },
    select: { userId: true },
  });
  if (sub) return true;
  return isAppOwnerUser(db, appId, userId);
}

/**
 * #5077: the person who owns an App has a relationship with it whether or not it holds a member row (a person's App gives
 * its owner a member row only when the Agent offers an `owner` role). Never true for an organization's App.
 */
async function isAppOwnerUser(db: PrismaClient | Prisma.TransactionClient, appId: string, userId: string): Promise<boolean> {
  const app = await db.app.findFirst({ where: { id: appId, ownerUserId: userId, organizationId: null }, select: { id: true } });
  return !!app;
}

