/**
 * #3689 (cor:agt:010:01 rev 45) — every run names an existing Agent (`app_runs.agent_id` NOT NULL, foreign key to
 * agents). A fixture that writes an `appRun` row directly takes its Agent from here: the App's first LIVE ROW-installed
 * Agent when it has one, else one org-owned Agent per App, created once and NOT installed, so a fixture's install count
 * (and with it the single-install fallback) is unchanged. It returns A fixture Agent, not the Agent a real launch would
 * name (a launch names an explicitly resolved or trigger-selected Agent): a test whose behaviour depends on WHICH Agent
 * the run names must pass its own id (#3920).
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { generateId } from '../lib/id.js';

type Db = Pick<PrismaClient, 'appAgent' | 'agent'>;

export async function testRunAgentId(db: Db, organizationId: string, appId: string): Promise<string> {
  const installed = await db.appAgent.findFirst({ where: { appId, agent: { deletedAt: null } }, orderBy: { createdAt: 'asc' }, select: { agentId: true } });
  if (installed) return installed.agentId;
  const urn = `run-agent-of-${appId}`.toLowerCase();
  const existing = await db.agent.findUnique({ where: { urn }, select: { id: true, deletedAt: true } });
  if (existing) {
    // A soft-deleted fixture Agent is not a live Agent to name (the urn is unique, so it cannot be re-created): revive it.
    if (existing.deletedAt !== null) await db.agent.update({ where: { id: existing.id }, data: { deletedAt: null } });
    return existing.id;
  }
  return (await db.agent.create({ data: { id: generateId(), organizationId, urn, name: 'Run agent' }, select: { id: true } })).id;
}
