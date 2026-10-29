/** #2608 experimental register role picking; a read only, never assignment or routing. */
import { GraphQLError } from 'graphql';
import { Prisma, type Agent } from '../../../generated/prisma/index.js';
import { type Context, clampListTake, getAccessibleMemoryIds, isMemoryReadableCached, requireReadableAgent, withoutRequestCaches } from './resolvers.helpers.js';
import { resolveParticipatedApp } from './resolvers.agentTask.js';
import { locateTeamAgent } from './resolvers.worker.js';
import { registerTaskLoc } from './resolvers.taskWarnings.js';
import { findEffectiveNodeIdByLoc, findEffectiveNodeIdsByLoc, type InheritedFrom } from '../../../lib/effectiveSystemMemory.js';
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
 * chains, chain-member memories, every root's effective hit in one lookup, the
 * hit rows in one read, one read-gate answer for every memory) and this closes
 * over them. Gate ORDER and semantics are the reviewed ones: Agent gate, then
 * the first contributing memory's read gate, then the licensed-inheritance
 * result; nothing re-orders a refusal.
 */
/** One roster Agent's first contributing memory, as a root the batched lookup asks. */
type RootEntry = { key: string; memoryId: string; firstId: string; inheritRoot: boolean };

function batchedRoleTasks(
  c: Context,
  taskLoc: string,
  rootOf: Map<string, RootEntry | null>,
  hits: Map<string, { id: string; memoryId: string; inheritedFrom: InheritedFrom | null } | null>,
  taskByHit: Map<string, { isRunnable: boolean | null; memory: { urn: string; deletedAt: Date | null } } | undefined>,
  canRead: (memoryId: string) => boolean,
) {
  const roleTaskByAgent = new Map<string, RoleTask | null>();

  const roleTask = async (
    agentId: string,
    agentRows: Map<string, Pick<Agent, 'id' | 'visibility' | 'deletedAt' | 'organizationId' | 'ownerUserId'> | undefined>,
    chainOf: (id: string) => string[],
  ): Promise<RoleTask | null> => {
    const cached = roleTaskByAgent.get(agentId);
    if (cached !== undefined) return cached;
    const miss = () => { roleTaskByAgent.set(agentId, null); return null; };
    const agent = agentRows.get(agentId) ?? null;
    try { await requireReadableAgent(c, agent, agentId); }
    catch (e) { if (e instanceof AgentNotFoundError) return miss(); throw e; }
    if (!agent) return miss();
    // Missing system memories contribute no nodes, but do not erase an Agent link's depth.
    const root = rootOf.get(agentId);
    if (!root || !canRead(root.memoryId)) return miss();
    // Effective inherited nodes are admitted through the child's readable system memory, as Query.node does.
    // Re-gating the base's memory would incorrectly drop licensed inherited definitions.
    const hit = hits.get(root.key);
    if (!hit) return miss();
    const task = taskByHit.get(hit.id);
    if (!task?.isRunnable || task.memory.deletedAt) return miss();
    // Count Agent links, not contributed memories: an intermediate Agent with no memory still has depth.
    const depth = chainOf(agentId).indexOf(hit.inheritedFrom?.agentId ?? root.firstId);
    if (depth < 0) return miss();
    const out = { depth, taskUrn: `hrn:node:${task.memory.urn}:${taskLoc}` };
    roleTaskByAgent.set(agentId, out);
    return out;
  };

  return { roleTask };
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
        const chainOf = (id: string): string[] => [id, ...(chains.get(id) ?? [])];
        // Every roster Agent's first contributing memory, as ONE root set (Atilla's
        // #2724 BLIND P2: distinct roots must not fan out into per-memory reads).
        // A root is keyed by its flag too — one memory is its owner's own root and a
        // memory-less child's inherited root at once, and the two answer differently.
        const rootOf = new Map<string, RootEntry | null>();
        const roots = new Map<string, { memoryId: string; inheritRoot: boolean }>();
        for (const agentId of agentIds) {
          const firstId = chainOf(agentId).find((id) => memoryOf.get(id));
          const memoryId = firstId !== undefined ? memoryOf.get(firstId) : undefined;
          if (firstId === undefined || memoryId === undefined) { rootOf.set(agentId, null); continue; }
          const inheritRoot = firstId !== agentId;
          const key = `${memoryId}:${inheritRoot}`;
          rootOf.set(agentId, { key, memoryId, firstId, inheritRoot });
          roots.set(key, { memoryId, inheritRoot });
        }
        // One statement per fact for the whole roster: every root's effective hit in
        // one walk, every hit row in one read, one read-gate answer for every memory
        // (the shared full-set gate, as the list surfaces use it).
        const hits = await findEffectiveNodeIdsByLoc(tx, [...roots.values()], taskLoc);
        const hitIds = [...new Set([...hits.values()].flatMap((h) => (h ? [h.id] : [])))];
        const taskByHit = new Map(hitIds.length
          ? (await tx.node.findMany({
              where: { id: { in: hitIds } },
              select: { id: true, isRunnable: true, memory: { select: { urn: true, deletedAt: true } } },
            })).map((n) => [n.id, n] as const)
          : []);
        const accessible = await getAccessibleMemoryIds(c);
        const canRead = (memoryId: string): boolean => accessible === null || accessible.includes(memoryId);
        const { roleTask } = batchedRoleTasks(c, taskLoc, rootOf, hits, taskByHit, canRead);
        for (const w of workers) {
          const match = await roleTask(w.agentId, agentRows, chainOf);
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
