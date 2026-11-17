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

/** One (App, Agent) question for the batched checks below. */
export type PersonalOrgAgentCheck = { app: AppScope; agentId: string };

type AgentFacts = { organizationId: string | null; visibility: string; deletedAt: Date | null };

/** The live (user, org) memberships among `pairs`, as `${userId}:${orgId}` keys, in one read. */
async function currentMemberships(db: Db, pairs: Array<{ userId: string; organizationId: string }>): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const rows = await db.orgMember.findMany({
    where: {
      userId: { in: [...new Set(pairs.map(p => p.userId))] },
      organizationId: { in: [...new Set(pairs.map(p => p.organizationId))] },
      deletedAt: null, organization: { deletedAt: null },
    },
    select: { userId: true, organizationId: true },
  });
  return new Set(rows.map(row => `${row.userId}:${row.organizationId}`));
}

async function agentFacts(db: Db, checks: PersonalOrgAgentCheck[]): Promise<Map<string, AgentFacts>> {
  const ids = [...new Set(checks.filter(c => c.app.organizationId === null && c.app.ownerUserId).map(c => c.agentId))];
  if (ids.length === 0) return new Map();
  const rows = await db.agent.findMany({
    where: { id: { in: ids } },
    select: { id: true, organizationId: true, visibility: true, deletedAt: true },
  });
  return new Map(rows.map(row => [row.id, row]));
}

async function licenceBatchWith(db: Db, checks: PersonalOrgAgentCheck[], agents: Map<string, AgentFacts>): Promise<boolean[]> {
  // The same decision as personalOrgAgentLicenseHolds, row by row; only the reads are shared.
  const out = checks.map(() => true);
  const pending: Array<{ i: number; owner: string; org: string; agentId: string }> = [];
  checks.forEach(({ app, agentId }, i) => {
    if (app.organizationId !== null || !app.ownerUserId) return;
    const agent = agents.get(agentId);
    if (!agent || !agent.organizationId || agent.visibility === 'PUBLIC') return;
    if (agent.deletedAt || agent.visibility !== 'ORGANIZATION') { out[i] = false; return; }
    pending.push({ i, owner: app.ownerUserId, org: agent.organizationId, agentId });
  });
  const members = await currentMemberships(db, pending.map(p => ({ userId: p.owner, organizationId: p.org })));
  const licensable = pending.filter(p => {
    if (members.has(`${p.owner}:${p.org}`)) return true;
    out[p.i] = false;
    return false;
  });
  if (licensable.length === 0) return out;
  const subscriptions = await db.agentSubscription.findMany({
    where: { userId: { in: [...new Set(licensable.map(p => p.owner))] }, agentId: { in: [...new Set(licensable.map(p => p.agentId))] } },
  });
  const byPair = new Map(subscriptions.map(row => [`${row.userId}:${row.agentId}`, row]));
  for (const p of licensable) {
    const subscription = byPair.get(`${p.owner}:${p.agentId}`);
    out[p.i] = subscription !== undefined && isLifecycleActive(subscription);
  }
  return out;
}

/**
 * #3655: {@link personalOrgAgentLicenseHolds} for many checks at once, one answer per check in order. It reads the
 * Agents, the App owners' memberships and their subscriptions once for the whole batch, however many checks it covers.
 * The decision per check is unchanged (cor:agt:040:10, ruling 0235; #1148), and the differential in
 * resolvers.licenceBatch3655.test.ts holds it to the single helper.
 */
export async function personalOrgAgentLicenseBatch(db: Db, checks: PersonalOrgAgentCheck[]): Promise<boolean[]> {
  return licenceBatchWith(db, checks, await agentFacts(db, checks));
}

/**
 * #3655: {@link personalOrgAgentTextAllowed} for many checks at once, one answer per check in order. Adds one read of
 * the callers' memberships to {@link personalOrgAgentLicenseBatch}'s three. The decision per check is unchanged.
 */
export async function personalOrgAgentTextBatch(
  db: Db,
  checks: Array<PersonalOrgAgentCheck & { userId: string | null | undefined }>,
): Promise<boolean[]> {
  const agents = await agentFacts(db, checks);
  const licence = await licenceBatchWith(db, checks, agents);
  const out = checks.map(() => true);
  const pending: Array<{ i: number; userId: string; org: string }> = [];
  checks.forEach(({ app, agentId, userId }, i) => {
    if (app.organizationId !== null || !app.ownerUserId) return;
    const agent = agents.get(agentId);
    if (!agent?.organizationId || agent.visibility === 'PUBLIC') return;
    if (!licence[i] || !userId) { out[i] = false; return; }
    pending.push({ i, userId, org: agent.organizationId });
  });
  const members = await currentMemberships(db, pending.map(p => ({ userId: p.userId, organizationId: p.org })));
  for (const p of pending) out[p.i] = members.has(`${p.userId}:${p.org}`);
  return out;
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
