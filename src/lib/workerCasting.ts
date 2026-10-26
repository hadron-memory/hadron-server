/**
 * #2458 / hrn:node:hadronmemory.com:specs:cor:dmo:050:11 — the ONE casting check, shared by `castWorker` (and its
 * preview) and `changeWorkerAgent` so the two gates cannot drift (CLAUDE.md, Authorization invariants).
 *
 * "The same checks as a cast": the App is installed, the agent is installed in it and not deleted, and the App's
 * holder is licensed for the agent AND for every Agent the boot prompt the worker would be served includes from
 * (hrn:node:hadronmemory.com:specs:cor:agt:040:08). For an org App the licence is the org's AgentOrgGrant, read through
 * `classifyOrgAgentLicense` (the one place the licence rules live); a missing SAME-org grant is provisionable, a
 * revoked one is never reactivated. For a user-owned App the owner's own Agent, or their active AgentSubscription,
 * stands in for the grant (Holger, 2026-10-12, team chat #9789).
 *
 * Read-only: it returns the grants a caller must provision and never writes, so the preview can run it too. A caller
 * that writes runs it again inside its deciding transaction.
 */
import { isLifecycleActive } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { classifyOrgAgentLicense } from './auth/orgAgentInstallLicense.js';
import { parseCompiledProvenance } from './bootCompile/provenance.js';

type Db = Pick<PrismaClient, 'agent' | 'agentOrgGrant' | 'agentSubscription' | 'appAgent' | 'compiledPromptRevision' | 'node'> | Prisma.TransactionClient;

export type CastingApp = { id: string; organizationId: string | null; ownerUserId: string | null; uninstalledAt: Date | null };
export type CastingAgent = { id: string; name: string; urn: string; personaRole: string | null; systemPrompt: string | null };

const refusal = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });

/** The one answer for an absent Agent and one not installed here (#1946 ruling A): no agentId, no existence oracle. */
export const workerAgentNotInstalled = (appId: string) => refusal(
  'WORKER_AGENT_NOT_INSTALLED',
  'agentRef must name an Agent installed in this App — casting requires the agent on the roster at cast time.',
  { appId },
);

/**
 * Is the App's holder licensed for `agentId`? Returns true when a missing same-org grant is to be provisioned.
 * `include` selects the refusal shape: the cast agent itself answers with the install codes, an Agent the boot
 * prompt includes from answers as the compile does (BOOT_PROMPT_GRANT_REQUIRED / _INCLUDE_UNAVAILABLE), never
 * naming the concealed Agent.
 */
async function planLicence(db: Db, app: CastingApp, agentId: string, include: boolean): Promise<boolean> {
  const unavailable = () => include
    ? refusal('BOOT_PROMPT_INCLUDE_UNAVAILABLE', 'The boot prompt this agent is served includes from an Agent that is unavailable.')
    : workerAgentNotInstalled(app.id);
  const required = (message: string) => include
    ? refusal('BOOT_PROMPT_GRANT_REQUIRED', 'The boot prompt this agent is served includes from an Agent this App holds no active grant for.')
    : refusal('AGENT_ORG_GRANT_REQUIRED', message);
  const inactive = () => include
    ? refusal('BOOT_PROMPT_GRANT_REQUIRED', 'The boot prompt this agent is served includes from an Agent whose grant is inactive.')
    : refusal('AGENT_ORG_GRANT_INACTIVE', 'This organization’s Agent grant is inactive.');

  if (app.organizationId) {
    switch (await classifyOrgAgentLicense(db as Pick<PrismaClient, 'agent' | 'agentOrgGrant'>, app.organizationId, agentId)) {
      case 'LICENSED': return false;
      case 'SAME_ORG_PROVISIONABLE': return true;
      case 'SAME_ORG_INACTIVE':
      case 'FOREIGN_INACTIVE': throw inactive();
      case 'SUBSCRIBABLE': throw required('Subscribe this organization to the PUBLIC Agent before casting it.');
      case 'CONCEALED':
      case 'GONE': throw unavailable();
    }
  }
  // A user-owned App: the owner's own Agent, or the owner's active subscription.
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { ownerUserId: true, deletedAt: true } });
  if (!agent || agent.deletedAt) throw unavailable();
  if (app.ownerUserId && agent.ownerUserId === app.ownerUserId) return false;
  const sub = app.ownerUserId
    ? await db.agentSubscription.findUnique({ where: { userId_agentId: { userId: app.ownerUserId, agentId } } })
    : null;
  if (sub && isLifecycleActive(sub)) return false;
  throw required('The App’s owner holds no active subscription to this Agent.');
}

/**
 * The Agents whose system memory holds a node the boot prompt served to (App, agent) was compiled from: the App's
 * APP_AGENT pointer, else the Agent's own pointer, at its newest compiled revision (its provenance row is the
 * authority for what that revision read). No pointer, no compiled prompt, no includes. The agent itself is excluded.
 */
async function includedAgentIds(db: Db, appId: string, agentId: string): Promise<string[]> {
  const appAgent = await db.appAgent.findUnique({ where: { appId_agentId: { appId, agentId } }, select: { bootPromptNodeId: true } });
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { bootPromptNodeId: true } });
  const pointer = appAgent?.bootPromptNodeId ?? agent?.bootPromptNodeId ?? null;
  if (!pointer) return [];
  const newest = await db.compiledPromptRevision.findFirst({
    where: { compiledNodeId: pointer }, orderBy: { compiledRevNo: 'desc' }, select: { provenance: true, compiledRevNo: true },
  });
  if (!newest) return [];
  const provenance = parseCompiledProvenance(newest.provenance, pointer, newest.compiledRevNo);
  const nodeIds = [...new Set(provenance.occurrences.map((o) => o.nodeId))];
  const memories = await db.node.findMany({ where: { id: { in: nodeIds } }, select: { memoryId: true } });
  const memoryIds = [...new Set(memories.map((m) => m.memoryId))];
  if (memoryIds.length === 0) return [];
  const owners = await db.agent.findMany({ where: { systemMemoryId: { in: memoryIds } }, select: { id: true }, orderBy: { id: 'asc' } });
  return owners.map((a) => a.id).filter((id) => id !== agentId);
}

/**
 * The casting check. Refuses, in order: APP_UNINSTALLED, WORKER_AGENT_NOT_INSTALLED (absent, not installed, or
 * deleted: one answer), the agent's licence (AGENT_ORG_GRANT_INACTIVE / _REQUIRED), then each included Agent's
 * (BOOT_PROMPT_GRANT_REQUIRED / _INCLUDE_UNAVAILABLE). Returns the agent and the same-org grants to provision.
 */
export async function assertCastable(
  db: Db,
  app: CastingApp,
  agentId: string,
): Promise<{ agent: CastingAgent; provisionGrantsFor: string[] }> {
  if (app.uninstalledAt) {
    throw refusal('APP_UNINSTALLED', 'Cannot cast a worker in an uninstalled App.', { appId: app.id });
  }
  const row = await db.appAgent.findUnique({
    where: { appId_agentId: { appId: app.id, agentId } },
    select: { agent: { select: { id: true, name: true, urn: true, personaRole: true, systemPrompt: true, deletedAt: true } } },
  });
  if (!row || row.agent.deletedAt) throw workerAgentNotInstalled(app.id);
  const provisionGrantsFor: string[] = [];
  if (await planLicence(db, app, agentId, false)) provisionGrantsFor.push(agentId);
  for (const included of await includedAgentIds(db, app.id, agentId)) {
    if (await planLicence(db, app, included, true)) provisionGrantsFor.push(included);
  }
  const { deletedAt: _deleted, ...agent } = row.agent;
  return { agent, provisionGrantsFor };
}
