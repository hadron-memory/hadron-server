/** #2608 experimental register role picking; a read only, never assignment or routing. */
import { GraphQLError } from 'graphql';
import { Prisma, type Agent } from '../../../generated/prisma/index.js';
import { type Context, clampListTake, isMemoryReadableCached, requireReadableAgent, withoutRequestCaches } from './resolvers.helpers.js';
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { registerTaskLoc } from './resolvers.taskWarnings.js';
import { findEffectiveNodeIdByLoc } from '../../../lib/effectiveSystemMemory.js';
import { agentBaseChains } from '../../../lib/agentBase.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';

type Candidate = {
  worker: { kind: 'WORKER'; id: string; name: string; urn: string };
  role: string | null; depth: number; taskUrn: string;
};

type RoleTask = { depth: number; taskUrn: string };

/**
 * The per-Agent evaluation, batched set-wise (Atilla's BLIND P2): the tie
 * minimum needs every roster Agent evaluated, so the WORK is bounded instead of
 * the roster walk — the caller passes in the one-shot reads (Agent rows, all
 * chains, chain-member memories) and the memo tables shared by Agents that
 * resolve through the same base memory. Gate ORDER and semantics are the
 * reviewed ones: Agent gate, then the first contributing memory's read gate,
 * then the licensed-inheritance lookup; nothing re-orders a refusal.
 */
function batchedRoleTasks(
  tx: Prisma.TransactionClient,
  c: Context,
  taskLoc: string,
) {
  const roleTaskByAgent = new Map<string, RoleTask | null>();
  const hitByMemory = new Map<string, Awaited<ReturnType<typeof findEffectiveNodeIdByLoc>>>();
  const taskByHit = new Map<string, { isRunnable: boolean | null; memory: { urn: string; deletedAt: Date | null } } | null>();

  const roleTask = async (
    agentId: string,
    agentRows: Map<string, Pick<Agent, 'id' | 'visibility' | 'deletedAt' | 'organizationId' | 'ownerUserId'> | undefined>,
    chainOf: (id: string) => string[],
    memoryOf: (id: string) => string | undefined,
  ): Promise<RoleTask | null> => {
    const cached = roleTaskByAgent.get(agentId);
    if (cached !== undefined) return cached;
    const miss = () => { roleTaskByAgent.set(agentId, null); return null; };
    const agent = agentRows.get(agentId) ?? null;
    try { await requireReadableAgent(c, agent, agentId); }
    catch (e) { if (e instanceof AgentNotFoundError) return miss(); throw e; }
    if (!agent) return miss();
    const chain = chainOf(agentId);
    // Missing system memories contribute no nodes, but do not erase an Agent link's depth.
    const firstId = chain.find((id) => memoryOf(id));
    const firstMemory = firstId ? memoryOf(firstId) : undefined;
    if (!firstId || !firstMemory || !(await isMemoryReadableCached(c, firstMemory))) return miss();
    // Effective inherited nodes are admitted through the child's readable system memory, as Query.node does.
    // Re-gating the base's memory would incorrectly drop licensed inherited definitions.
    const memoKey = `${firstMemory}:${firstId !== agentId}`;
    if (!hitByMemory.has(memoKey)) {
      hitByMemory.set(memoKey, await findEffectiveNodeIdByLoc(tx, firstMemory, taskLoc, { inheritRoot: firstId !== agentId }));
    }
    const hit = hitByMemory.get(memoKey);
    if (!hit) return miss();
    if (!taskByHit.has(hit.id)) {
      taskByHit.set(hit.id, await tx.node.findUnique({
        where: { id: hit.id },
        select: { isRunnable: true, memory: { select: { urn: true, deletedAt: true } } },
      }));
    }
    const task = taskByHit.get(hit.id) ?? null;
    if (!task?.isRunnable || task.memory.deletedAt) return miss();
    // Count Agent links, not contributed memories: an intermediate Agent with no memory still has depth.
    const depth = chain.indexOf(hit.inheritedFrom?.agentId ?? firstId);
    if (depth < 0) return miss();
    const out = { depth, taskUrn: `hrn:node:${task.memory.urn}:${taskLoc}` };
    roleTaskByAgent.set(agentId, out);
    return out;
  };

  return { roleTask, roleTaskByAgent };
}

export const registerRoleCandidateQueries = {
  registerRoleCandidates: async (_: unknown, args: { appRef: string; code: string; limit?: number | null; offset?: number | null }, ctx: Context) =>
    ctx.db.$transaction(async (tx) => {
      const c = withoutRequestCaches(ctx, tx);
      // Same admission as the roster; no App or worker is disclosed before this gate.
      const { app } = await resolveParticipatedApp(c, args.appRef);
      const empty = { appId: app.id, code: args.code, taskLoc: null, depth: null, total: 0, candidates: [] };
      let team: Awaited<ReturnType<typeof locateTeamAgent>>;
      try { team = await locateTeamAgent(c, app.id, undefined); }
      catch (e) {
        if (e instanceof GraphQLError && ['TEAM_AGENT_NOT_FOUND', 'TEAM_AGENT_AMBIGUOUS'].includes(String(e.extensions.code))) return empty;
        throw e;
      }
      if (!team.systemMemoryId || !(await isMemoryReadableCached(c, team.systemMemoryId))) return empty;
      const entry = await findEffectiveNodeIdByLoc(tx, team.systemMemoryId, `register:${args.code}`);
      if (!entry) return empty;
      const data = await tx.node.findUnique({ where: { id: entry.id }, select: { data: true } });
      const taskLoc = registerTaskLoc(data?.data, args.code);
      if (!taskLoc) return empty;
      const workers = await tx.worker.findMany({
        where: { appId: app.id, retiredAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, slug: true, role: true, agentId: true },
      });
      const candidates: Candidate[] = [];
      if (workers.length) {
        // One read per fact, not per Agent: gate rows for every roster Agent, every
        // chain in one walk, every chain member's contributing memory in one query.
        const agentIds = [...new Set(workers.map((w) => w.agentId))];
        const agentRows = new Map(
          (await tx.agent.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, visibility: true, deletedAt: true, organizationId: true, ownerUserId: true },
          })).map((a) => [a.id, a]),
        );
        const chains = await agentBaseChains(tx, agentIds);
        const memberIds = new Set<string>(agentIds);
        for (const ids of chains.values()) for (const id of ids) memberIds.add(id);
        const memoryOf = new Map(
          (await tx.agent.findMany({
            where: { id: { in: [...memberIds] }, deletedAt: null },
            select: { id: true, systemMemoryId: true },
          })).flatMap((a) => (a.systemMemoryId ? [[a.id, a.systemMemoryId] as const] : [])),
        );
        const { roleTask } = batchedRoleTasks(tx, c, taskLoc);
        for (const w of workers) {
          const match = await roleTask(
            w.agentId, agentRows,
            (id) => [id, ...(chains.get(id) ?? [])],
            (id) => memoryOf.get(id),
          );
          if (!match) continue;
          candidates.push({
            worker: { kind: 'WORKER', id: w.id, name: w.name, urn: composeWorkerUrn(app.urn, w.slug) },
            role: w.role, ...match
          });
        }
      }
      const depth = candidates.length ? Math.min(...candidates.map(x => x.depth)) : null;
      const tied = candidates.filter(x => x.depth === depth);
      const offset = Math.max(0, args.offset ?? 0);
      return {
        appId: app.id, code: args.code, taskLoc, depth, total: tied.length,
        candidates: tied.slice(offset, offset + clampListTake(args.limit))
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20_000 }),
};
