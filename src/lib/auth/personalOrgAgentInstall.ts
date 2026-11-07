/** #1148 / ruling 0235: extra licence and text audience for a personal App's non-PUBLIC org Agent. */
import { isLifecycleActive } from '@hadron-memory/access-control';
import type { PrismaClient, Prisma } from '../../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;
type AppScope = { organizationId: string | null; ownerUserId: string | null };

export async function currentAgentOrgMember(
  db: Db,
  userId: string | null | undefined,
  organizationId: string,
): Promise<boolean> {
  if (!userId) return false;
  return (await db.orgMember.findFirst({
    where: { userId, organizationId, deletedAt: null, organization: { deletedAt: null } },
    select: { id: true },
  })) !== null;
}

/** True outside this rule; existing PUBLIC, own-Agent and org-App licence gates remain the caller's responsibility. */
export async function personalOrgAgentLicenseHolds(db: Db, app: AppScope, agentId: string): Promise<boolean> {
  if (app.organizationId !== null || !app.ownerUserId) return true;
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { organizationId: true, visibility: true, deletedAt: true },
  });
  if (!agent || !agent.organizationId || agent.visibility === 'PUBLIC') return true;
  if (agent.deletedAt) return false;
  if (agent.visibility !== 'ORGANIZATION' || !(await currentAgentOrgMember(db, app.ownerUserId, agent.organizationId))) return false;
  const subscription = await db.agentSubscription.findUnique({
    where: { userId_agentId: { userId: app.ownerUserId, agentId } },
  });
  return subscription !== null && isLifecycleActive(subscription);
}

/**
 * #3653 / cor:agt:040:10 (ruling 0235): may this caller be SERVED this install's prompt? Serving checks the App owner's
 * licence, not the caller, so a caller with no person (an App key, in a session or not) is judged on that licence alone.
 * It gets no more than on any other install. A person keeps {@link personalOrgAgentTextAllowed}: the participant outside
 * the organization is a separate, unruled departure. For serving only: reads of the system and install memory stay
 * with that text gate (cor:acl:010:01), because a key alone is no participant.
 */
export async function personalOrgAgentServeAllowed(
  db: Db,
  app: AppScope,
  agentId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  return userId
    ? await personalOrgAgentTextAllowed(db, app, agentId, userId)
    : await personalOrgAgentLicenseHolds(db, app, agentId);
}

/** An independently admitted participant must ALSO be a current member before reading this install's org text. */
export async function personalOrgAgentTextAllowed(
  db: Db,
  app: AppScope,
  agentId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (app.organizationId !== null || !app.ownerUserId) return true;
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { organizationId: true, visibility: true },
  });
  if (!agent?.organizationId || agent.visibility === 'PUBLIC') return true;
  return await personalOrgAgentLicenseHolds(db, app, agentId)
    && await currentAgentOrgMember(db, userId, agent.organizationId);
}
