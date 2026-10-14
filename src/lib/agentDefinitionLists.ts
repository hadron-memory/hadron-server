/**
 * #1892 — an Agent's task list and process list (cor:dmo:050:15, :16).
 *
 * An Agent names two index nodes, `Agent.tasksIndexRef` and
 * `Agent.processesIndexRef`. An index has no body: its incoming edges are the
 * list, and each edge's name is the trigger for what it lists.
 *
 * TASKS (050:15). The union of:
 *  - every runnable node in the Agent's effective system memory, whether or
 *    not an index lists it (Holger, #10955 item 1: "too easy to forget an
 *    edge"); and
 *  - the sources of every index edge into the tasks index of each Agent in
 *    the base chain, each Agent's index read through its own pointer.
 * A listed source that sits in a chain memory is resolved at its loc through
 * the Agent's effective system memory, so the nearest Agent's node is the one
 * listed (050:15 S2, S4), and each node is listed once.
 *
 * PROCESSES (050:16). The processes the Agent starts or owns (`STARTS`: the
 * sources of the edges into its own processes index, with their triggers),
 * then the processes it's involved in (`INVOLVED`: the sources of `stage …`
 * edges into one of its tasks, with no trigger).
 *
 * The effective memory, the chain and the inherited marking are #1885's
 * (src/lib/effectiveSystemMemory.ts); this module adds no chain walk of its
 * own. Who may list is the existing read gate on the Agent's system memory
 * (#1892: no new audience until 050:15's "who may list" is ruled); a listed
 * node from outside the chain is returned only when that gate admits its own
 * memory, so nothing here widens a read.
 *
 * PROPOSED placeholders (#10970, queued for Holger as Q1–Q7; Eden #10971). Each
 * is one named constant or branch below, so a ruling is a contained change:
 *  - Q1 one task, triggers in two chain indexes → the nearest index's trigger.
 *  - Q2 an index source outside every chain memory → listed iff readable.
 *  - Q3 an involved process → a `stage …` edge whose source has role family
 *    `process` ({@link PROCESS_ROLE}).
 *  - Q4 where involved processes come from → any memory the reader may read.
 *  - Q5 an Agent with no pointer → its tasks are still its effective runnable
 *    nodes; it starts or owns no process.
 *  - Q6 a process both owned and staged → listed once, as `STARTS`.
 *  - Q7 owned processes → the Agent's own pointer only, not its bases'.
 *
 * Not built here: stage edges whose source is a BASE's process, read through
 * the child. Those are an inherited node's edges, which #1893 resolves; until
 * it lands they are skipped (Eden, #10969).
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, filterReadableMemoryIds } from '../mcp/access-control.js';
import { AgentNotFoundError } from './entityRef/errors.js';
import {
  effectiveScope,
  findEffectiveNodeIdByLoc,
  systemMemoryChain,
  type InheritedFrom,
} from './effectiveSystemMemory.js';

/** Q3 — the role family a stage edge's source must have to count as a process. */
export const PROCESS_ROLE = 'process';

/** Prefix of a stage edge's name: `stage …` (Holger, #10955 item 3). */
export const STAGE_EDGE_PREFIX = 'stage ';

/** The node fields a list entry carries; the surfaces render from these. */
const LIST_NODE_SELECT = {
  id: true,
  memoryId: true,
  loc: true,
  name: true,
  role: true,
} as const;

/**
 * A listed node: the node row, plus `inheritedFrom` when it is a base's,
 * read through the Agent (#1885 marking). Surfaces load whatever else they
 * render by id.
 */
export type ListedNode = {
  id: string;
  memoryId: string;
  loc: string;
  name: string;
  inheritedFrom: InheritedFrom | null;
};

export type AgentTaskEntry = { node: ListedNode; trigger: string | null };

export type AgentProcessKind = 'STARTS' | 'INVOLVED';
export type AgentProcessEntry = { node: ListedNode; kind: AgentProcessKind; trigger: string | null };

type Db = PrismaClient;

/** The Agent as the lists need it, after the read gate. */
type GatedAgent = {
  id: string;
  systemMemoryId: string;
  tasksIndexRef: string | null;
  processesIndexRef: string | null;
};

/**
 * Load a live Agent and apply the list gate: the caller must be able to read
 * its system memory. A missing Agent, one without a system memory, and one
 * whose system memory the caller can't read are all refused the same way, as
 * not found, so the list is no oracle for an Agent's existence.
 */
async function gatedAgent(db: Db, auth: AuthContext, agentId: string, ref: string): Promise<GatedAgent> {
  const agent = await db.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    select: { id: true, systemMemoryId: true, tasksIndexRef: true, processesIndexRef: true },
  });
  if (!agent?.systemMemoryId || !(await canReadMemory(db, auth, agent.systemMemoryId))) {
    throw new AgentNotFoundError(ref);
  }
  return { ...agent, systemMemoryId: agent.systemMemoryId };
}

/**
 * Everything both lists share for one Agent: its chain (nearest first), the
 * effective scope of its system memory, and a resolver from a chain node to
 * the node at its loc that is in effect for the Agent.
 */
async function agentContext(db: Db, agent: GatedAgent) {
  const chain = await systemMemoryChain(db, agent.systemMemoryId);
  const links = chain.length > 0 ? chain : [{ agentId: agent.id, agentUrn: '', memoryId: agent.systemMemoryId }];
  const chainMemoryIds = new Set(links.map((l) => l.memoryId));
  const scope = await effectiveScope(db, [agent.systemMemoryId]);

  /** The node in effect at `node`'s loc for this Agent, or null when none is. */
  const effectiveAt = async (node: { id: string; memoryId: string; loc: string }): Promise<ListedNode | null> => {
    const hit = await findEffectiveNodeIdByLoc(db, agent.systemMemoryId, node.loc);
    if (!hit) return null;
    const row = await db.node.findFirst({ where: { id: hit.id, deletedAt: null }, select: LIST_NODE_SELECT });
    return row ? { ...pick(row), inheritedFrom: hit.inheritedFrom } : null;
  };

  return { links, chainMemoryIds, scope, effectiveAt };
}

function pick(row: { id: string; memoryId: string; loc: string; name: string }) {
  return { id: row.id, memoryId: row.memoryId, loc: row.loc, name: row.name };
}

/**
 * The live sources of the edges into `indexNodeIds`, nearest index first,
 * each with the edge's name as its trigger. Only edges whose source and
 * target are both live count. Order within one index is by the source's loc,
 * so the list is stable.
 */
async function indexEdgeSources(db: Db, indexNodeIds: string[]) {
  if (indexNodeIds.length === 0) return [];
  const edges = await db.edge.findMany({
    where: {
      targetId: { in: indexNodeIds },
      deletedAt: null,
      source: { deletedAt: null },
      target: { deletedAt: null },
    },
    select: { targetId: true, name: true, source: { select: LIST_NODE_SELECT } },
  });
  const rank = new Map(indexNodeIds.map((id, i) => [id, i]));
  return edges
    .sort((a, b) => rank.get(a.targetId)! - rank.get(b.targetId)! || a.source.loc.localeCompare(b.source.loc))
    .map((e) => ({ source: e.source, trigger: e.name ?? null }));
}

/**
 * Resolve index-edge sources into list entries, deduped by node id with the
 * first (nearest) trigger kept (Q1). A source in a chain memory resolves
 * through the Agent's effective memory; one outside the chain is kept iff
 * the caller may read its memory (Q2).
 */
async function resolveIndexSources(
  db: Db,
  auth: AuthContext,
  ctx: Awaited<ReturnType<typeof agentContext>>,
  sources: Array<{ source: { id: string; memoryId: string; loc: string; name: string }; trigger: string | null }>,
): Promise<Map<string, { node: ListedNode; trigger: string | null }>> {
  const outside = sources.filter((s) => !ctx.chainMemoryIds.has(s.source.memoryId)).map((s) => s.source.memoryId);
  const readable = await filterReadableMemoryIds(db, auth, outside);
  const out = new Map<string, { node: ListedNode; trigger: string | null }>();
  for (const { source, trigger } of sources) {
    let node: ListedNode | null;
    if (ctx.chainMemoryIds.has(source.memoryId)) {
      node = await ctx.effectiveAt(source);
    } else {
      node = readable.has(source.memoryId) ? { ...pick(source), inheritedFrom: null } : null;
    }
    if (node && !out.has(node.id)) out.set(node.id, { node, trigger });
  }
  return out;
}

/**
 * An Agent's tasks (cor:dmo:050:15): its effective runnable nodes and every
 * chain index's listed tasks, each once, with a trigger where an index edge
 * gives one. Ordered by loc, then memory id, for a stable list.
 */
export async function listAgentTasks(db: Db, auth: AuthContext, agentId: string, ref: string): Promise<AgentTaskEntry[]> {
  const agent = await gatedAgent(db, auth, agentId, ref);
  return tasksOf(db, auth, agent, await agentContext(db, agent));
}

async function tasksOf(
  db: Db,
  auth: AuthContext,
  agent: GatedAgent,
  ctx: Awaited<ReturnType<typeof agentContext>>,
): Promise<AgentTaskEntry[]> {
  // Each chain Agent's own pointer, nearest first (050:15: "each base's index
  // is read through its own pointer").
  const pointers = await db.agent.findMany({
    where: { id: { in: ctx.links.map((l) => l.agentId) } },
    select: { id: true, tasksIndexRef: true },
  });
  const pointerOf = new Map(pointers.map((p) => [p.id, p.tasksIndexRef]));
  pointerOf.set(agent.id, agent.tasksIndexRef);
  const indexIds = ctx.links.map((l) => pointerOf.get(l.agentId)).filter((id): id is string => !!id);

  const listed = await resolveIndexSources(db, auth, ctx, await indexEdgeSources(db, indexIds));

  // S5 — every runnable node in the effective memory is a task, edge or not.
  const runnable = await db.node.findMany({
    where: {
      memoryId: { in: ctx.scope.memoryIds },
      isRunnable: true,
      deletedAt: null,
      ...(ctx.scope.excludeNodeIds.length > 0 ? { id: { notIn: ctx.scope.excludeNodeIds } } : {}),
    },
    select: LIST_NODE_SELECT,
  });
  const out = new Map<string, AgentTaskEntry>(listed);
  for (const row of runnable) {
    if (out.has(row.id)) continue;
    out.set(row.id, { node: { ...pick(row), inheritedFrom: ctx.scope.inheritedFrom.get(row.memoryId) ?? null }, trigger: null });
  }
  return [...out.values()].sort(byLoc);
}

function byLoc(a: { node: ListedNode }, b: { node: ListedNode }): number {
  return a.node.loc.localeCompare(b.node.loc) || a.node.memoryId.localeCompare(b.node.memoryId);
}

function isProcessRole(role: string | null): boolean {
  return role === PROCESS_ROLE || (role?.startsWith(`${PROCESS_ROLE}.`) ?? false);
}

/**
 * An Agent's processes (cor:dmo:050:16): those it starts or owns, through its
 * own processes index (Q7), then those it's involved in, derived from `stage …`
 * edges into its tasks (050:15's list). A process in both is listed once, as
 * `STARTS` (Q6).
 */
export async function listAgentProcesses(
  db: Db,
  auth: AuthContext,
  agentId: string,
  ref: string,
): Promise<AgentProcessEntry[]> {
  const agent = await gatedAgent(db, auth, agentId, ref);
  const ctx = await agentContext(db, agent);

  const owned = await resolveIndexSources(
    db, auth, ctx,
    await indexEdgeSources(db, agent.processesIndexRef ? [agent.processesIndexRef] : []),
  );
  const out = new Map<string, AgentProcessEntry>();
  for (const { node, trigger } of [...owned.values()].sort(byLoc)) out.set(node.id, { node, kind: 'STARTS', trigger });

  // Involved: a stage edge may target the task's own node, or a node the
  // task overrides at the same loc in a farther chain memory; both mean this
  // task, since the edge's target is in effect for the Agent as the task.
  const tasks = await tasksOf(db, auth, agent, ctx);
  const targetIds = new Set(tasks.map((t) => t.node.id));
  const chainTaskLocs = tasks.filter((t) => ctx.chainMemoryIds.has(t.node.memoryId)).map((t) => t.node.loc);
  if (chainTaskLocs.length > 0) {
    const shadowed = await db.node.findMany({
      where: { memoryId: { in: [...ctx.chainMemoryIds] }, loc: { in: chainTaskLocs }, deletedAt: null },
      select: { id: true, memoryId: true, loc: true },
    });
    const effectiveIdByLoc = new Map(
      tasks.filter((t) => ctx.chainMemoryIds.has(t.node.memoryId)).map((t) => [t.node.loc, t.node.id]),
    );
    for (const n of shadowed) if (effectiveIdByLoc.has(n.loc)) targetIds.add(n.id);
  }
  if (targetIds.size === 0) return [...out.values()];

  const stageWhere: Prisma.EdgeWhereInput = {
    targetId: { in: [...targetIds] },
    deletedAt: null,
    name: { startsWith: STAGE_EDGE_PREFIX, mode: 'insensitive' },
    source: { deletedAt: null },
  };
  const stages = await db.edge.findMany({ where: stageWhere, select: { source: { select: LIST_NODE_SELECT } } });
  // #1893 — a base's process, read through the child, brings its edges only
  // once inherited edges resolve; until then a source in a base memory of the
  // chain is skipped. The Agent's own memory and memories outside the chain
  // are read directly, under the caller's own gate (Q4).
  const baseMemoryIds = new Set(ctx.links.slice(1).map((l) => l.memoryId));
  const candidates = stages
    .map((s) => s.source)
    .filter((s) => isProcessRole(s.role) && !baseMemoryIds.has(s.memoryId));
  const readable = await filterReadableMemoryIds(db, auth, candidates.map((s) => s.memoryId));
  const involved = new Map<string, ListedNode>();
  for (const s of candidates) {
    if (out.has(s.id) || involved.has(s.id) || !readable.has(s.memoryId)) continue;
    involved.set(s.id, { ...pick(s), inheritedFrom: null });
  }
  for (const node of [...involved.values()].sort((a, b) => byLoc({ node: a }, { node: b }))) {
    out.set(node.id, { node, kind: 'INVOLVED', trigger: null });
  }
  return [...out.values()];
}
