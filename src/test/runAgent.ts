/**
 * #3689 (cor:agt:010:01 rev 45) — every run names an existing Agent (`app_runs.agent_id` NOT NULL, foreign key to
 * agents). A fixture that writes an `appRun` row directly takes its Agent from here: the App's first ROW-installed
 * Agent when it has one (the Agent its runs would be launched as), else one org-owned Agent per App, created once and
 * NOT installed, so a fixture's install count (and with it the single-install fallback) is unchanged.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

type Db = Pick<PrismaClient, 'appAgent' | 'agent'>;

export async function testRunAgentId(db: Db, organizationId: string, appId: string): Promise<string> {
  const installed = await db.appAgent.findFirst({ where: { appId }, orderBy: { createdAt: 'asc' }, select: { agentId: true } });
  if (installed) return installed.agentId;
  const urn = `run-agent-of-${appId}`.toLowerCase();
  const existing = await db.agent.findUnique({ where: { urn }, select: { id: true } });
  if (existing) return existing.id;
  return (await db.agent.create({ data: { id: generateId(), organizationId, urn, name: 'Run agent' }, select: { id: true } })).id;
}
