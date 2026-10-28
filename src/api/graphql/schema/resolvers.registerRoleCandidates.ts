/** #2608 experimental register role picking; a read only, never assignment or routing. */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context, clampListTake, isMemoryReadableCached, requireReadableAgent, withoutRequestCaches } from './resolvers.helpers.js';
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { registerTaskLoc } from './resolvers.taskWarnings.js';
import { findEffectiveNodeIdByLoc } from '../../../lib/effectiveSystemMemory.js';
import { agentBaseChain } from '../../../lib/agentBase.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';

export type Candidate = {
  worker: { kind: 'WORKER'; id: string; name: string; urn: string };
  role: string | null; depth: number; taskUrn: string;
};

type RoleTask = { depth: number; taskUrn: string };

async function readableRoleTask(tx: Prisma.TransactionClient, c: Context, agentId: string, taskLoc: string): Promise<RoleTask | null> {
  const agent = await tx.agent.findUnique({ where: { id: agentId } });
  try { await requireReadableAgent(c, agent, agentId); }
  catch (e) { if (e instanceof AgentNotFoundError) return null; throw e; }
  if (!agent) return null;
  const chain = [agent.id, ...await agentBaseChain(tx, agent.id)];
  // Missing system memories contribute no nodes, but do not erase an Agent link's depth.
  const links = await tx.agent.findMany({ where: { id: { in: chain }, deletedAt: null }, select: { id: true, systemMemoryId: true } });
  const first = chain.map(id => links.find(a => a.id === id)).find(a => a?.systemMemoryId);
  if (!first?.systemMemoryId || !(await isMemoryReadableCached(c, first.systemMemoryId))) return null;
  // Effective inherited nodes are admitted through the child's readable system memory, as Query.node does.
  // Re-gating the base's memory would incorrectly drop licensed inherited definitions.
  const hit = await findEffectiveNodeIdByLoc(tx, first.systemMemoryId, taskLoc, { inheritRoot: first.id !== agent.id });
  if (!hit) return null;
  const task = await tx.node.findUnique({ where: { id: hit.id }, select: { isRunnable: true, memory: { select: { urn: true, deletedAt: true } } } });
  if (!task?.isRunnable || task.memory.deletedAt) return null;
  // Count Agent links, not contributed memories: an intermediate Agent with no memory still has depth.
  const depth = chain.indexOf(hit.inheritedFrom?.agentId ?? first.id);
  if (depth < 0) return null;
  return { depth, taskUrn: `hrn:node:${task.memory.urn}:${taskLoc}` };
}

type RoleCandidateSet = { appId: string; app: { id: string; urn: string }; taskLoc: string | null; candidates: Candidate[] };

/** The #2608 candidates at EVERY depth for one register code, under the caller's gate (the pick falls through depths). */
export async function loadRoleCandidates(tx: Prisma.TransactionClient, c: Context, appRef: string, code: string): Promise<RoleCandidateSet> {
  // Same admission as the roster; no App or worker is disclosed before this gate.
  const { app } = await resolveParticipatedApp(c, appRef);
  const none = { appId: app.id, app, taskLoc: null, candidates: [] };
  let team: Awaited<ReturnType<typeof locateTeamAgent>>;
  try { team = await locateTeamAgent(c, app.id, undefined); }
  catch (e) {
    if (e instanceof GraphQLError && ['TEAM_AGENT_NOT_FOUND', 'TEAM_AGENT_AMBIGUOUS'].includes(String(e.extensions.code))) return none;
    throw e;
  }
  if (!team.systemMemoryId || !(await isMemoryReadableCached(c, team.systemMemoryId))) return none;
  const entry = await findEffectiveNodeIdByLoc(tx, team.systemMemoryId, `register:${code}`);
  if (!entry) return none;
  const data = await tx.node.findUnique({ where: { id: entry.id }, select: { data: true } });
  const taskLoc = registerTaskLoc(data?.data, code);
  if (!taskLoc) return none;
  const workers = await tx.worker.findMany({
    where: { appId: app.id, retiredAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, slug: true, role: true, agentId: true },
  });
  const candidates: Candidate[] = [];
  const matches = new Map<string, RoleTask | null>();
  for (const w of workers) {
    let match = matches.get(w.agentId);
    if (match === undefined) {
      match = await readableRoleTask(tx, c, w.agentId, taskLoc);
      matches.set(w.agentId, match);
    }
    if (!match) continue;
    candidates.push({
      worker: { kind: 'WORKER', id: w.id, name: w.name, urn: composeWorkerUrn(app.urn, w.slug) },
      role: w.role, ...match
    });
  }
  return { appId: app.id, app, taskLoc, candidates };
}

export const registerRoleCandidateQueries = {
  registerRoleCandidates: async (_: unknown, args: { appRef: string; code: string; limit?: number | null; offset?: number | null }, ctx: Context) =>
    ctx.db.$transaction(async (tx) => {
      const c = withoutRequestCaches(ctx, tx);
      const { appId, taskLoc, candidates } = await loadRoleCandidates(tx, c, args.appRef, args.code);
      const depth = candidates.length ? Math.min(...candidates.map(x => x.depth)) : null;
      const tied = candidates.filter(x => x.depth === depth);
      const offset = Math.max(0, args.offset ?? 0);
      return {
        appId, code: args.code, taskLoc, depth, total: tied.length,
        candidates: tied.slice(offset, offset + clampListTake(args.limit))
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 }),
};
