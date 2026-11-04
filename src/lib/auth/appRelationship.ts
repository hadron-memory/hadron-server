import { listLicensedAppInstallations } from '../appAgent.js';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';

/**
 * True if `userId` has a live relationship with the App: an AppMember, or an
 * ACTIVE AgentSubscription to one of the App's agents. Active is the data-model
 * predicate (activatedAt set, not revoked, not expired) — not merely
 * `revokedAt: null` — so a not-yet-activated or expired subscription does NOT
 * authorize a run (Codex/Copilot #566). Shared by trigger edits, manual-run pre-checks, and automation evidence.
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
  const installations = await listLicensedAppInstallations(db, appId);
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
  return !!sub;
}

