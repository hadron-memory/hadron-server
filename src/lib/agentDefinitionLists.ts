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
 * sources of the edges into the processes index of each Agent in the chain,
 * each read through its own pointer and resolved like tasks, with their
 * triggers), then the processes it's involved in (`INVOLVED`: the sources of
 * `stage …` edges into one of its tasks, with no trigger).
 *
 * The effective memory, the chain and the inherited marking are #1885's
 * (src/lib/effectiveSystemMemory.ts); this module adds no chain walk of its
 * own. Who may list is the existing read gate on the Agent's system memory
 * (#1892: no new audience until 050:15's "who may list" is ruled); a listed
 * node from outside the chain is returned only when that gate admits its own
 * memory, so nothing here widens a read.
 *
 * Holger's rulings on Bob's #10970 questions (team chat #10955 item 3, #11002,
 * #11005), each one branch below:
 *  - Q1 one task, triggers in two chain indexes → the nearest index's trigger.
 *  - Q2 an index source outside every chain memory → listed only if the reader
 *    may already read it through the shared gate.
 *  - Q3 an involved process → a `stage …` edge whose source has role family
 *    `process` ({@link PROCESS_ROLE}).
 *  - Q4 involved processes come from any memory the reader may already read.
 *  - Q5 an Agent with no pointer → its tasks are still its effective tasks,
 *    its bases' indexes included; its owned processes are its bases'.
 *  - Q6 a process both owned and staged → listed once, as `STARTS`.
 *  - Q7 owned processes union the chain, nearest wins, as tasks do.
 *
 * A stage edge whose source is a BASE's process is an inherited node's edge,
 * read through the child as #1899 serves it (#1941): the process in effect at
 * that loc is the one involved, inherited or the child's own override.
 */

import { GraphQLError } from 'graphql';
import { getRetrievalProvider } from './retrieval/postgres.js';
import { composeHybridRanking, hybridKeywordCandidates, type MatchedBy } from './retrieval/hybrid.js';
import { getEmbeddingClient, isEmbeddingConfigured } from './embedding/index.js';
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import { canReadMemory, filterReadableMemoryIds } from '../mcp/access-control.js';
import { COMMENT_NODE_TYPE } from './comments/index.js';
import { AgentNotFoundError } from './entityRef/errors.js';
import {
  effectiveScope,
  findEffectiveNodeIdByLoc,
  retainEffective,
  servedEndpointInEffect,
  stillInherited,
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

export type AgentTaskEntry = { node: ListedNode & { abstract?: string }; trigger: string | null; matchedBy?: MatchedBy };
export type AgentTaskSearch = { symptom?: string | null; limit?: number | null };

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

  /**
   * The node in effect at `node`'s loc for this Agent, with its role as read,
   * or null when none is. This is the in-chain half of 050:14's served-edge
   * rule (#1899): the child's override wins, and a node not in effect drops.
   */
  const effectiveRowAt = async (
    node: { id: string; memoryId: string; loc: string },
  ): Promise<{ node: ListedNode; role: string | null } | null> => {
    const hit = await findEffectiveNodeIdByLoc(db, agent.systemMemoryId, node.loc);
    if (!hit) return null;
    const row = await db.node.findFirst({ where: { id: hit.id, deletedAt: null }, select: LIST_NODE_SELECT });
    if (!row) return null;
    // #1899's served-endpoint check on the version read, for EVERY row, the
    // child's own included (Andi's P2 on #1949): it must still sit at the
    // selected memory and loc, and a fresh lookup must still select it; an
    // inherited row must also still be passed down (#1891's stillInherited:
    // not overridden since, not a boot prompt). A row moved, replaced or
    // turned since the lookup is dropped, never served under a stale stamp.
    if (!(await servedEndpointInEffect(db, agent.systemMemoryId, node.loc, hit, row))) return null;
    return { node: { ...pick(row), inheritedFrom: hit.inheritedFrom }, role: row.role };
  };

  /** The node in effect at `node`'s loc for this Agent, or null when none is. */
  const effectiveAt = async (node: { id: string; memoryId: string; loc: string }): Promise<ListedNode | null> =>
    (await effectiveRowAt(node))?.node ?? null;

  /** The base an inherited row comes from, carrying the child it was read through. */
  const inheritedOf = (memoryId: string): InheritedFrom | null => {
    const from = scope.inheritedFrom.get(memoryId);
    return from ? { ...from, via: agent.systemMemoryId } : null;
  };

  return { links, chainMemoryIds, scope, effectiveAt, effectiveRowAt, inheritedOf };
}

/**
 * The index nodes the chain's Agents name in `field`, nearest Agent first,
 * each Agent's through its own pointer (050:15). An index two Agents share
 * keeps its NEAREST place (Anne's P3 on #1896), so Q1's nearest trigger is
 * the nearest Agent's.
 */
async function chainIndexIds(
  db: Db,
  agent: GatedAgent,
  ctx: Awaited<ReturnType<typeof agentContext>>,
  field: 'tasksIndexRef' | 'processesIndexRef',
): Promise<string[]> {
  const pointers = await db.agent.findMany({
    where: { id: { in: ctx.links.map((l) => l.agentId) } },
    select: { id: true, tasksIndexRef: true, processesIndexRef: true },
  });
  const pointerOf = new Map(pointers.map((p) => [p.id, p[field]]));
  pointerOf.set(agent.id, agent[field]);
  const out: string[] = [];
  for (const l of ctx.links) {
    const id = pointerOf.get(l.agentId);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function pick(row: { id: string; memoryId: string; loc: string; name: string }) {
  return { id: row.id, memoryId: row.memoryId, loc: row.loc, name: row.name };
}

/**
 * The live sources of the edges into `indexNodeIds`, nearest index first,
 * each with the edge's name as its trigger. Only edges whose source and
 * target are both live count. A comment on an index node is discussion, never
 * a listed task or process (#1935, cor:dmo:110), so a comment source never
 * counts. Order within one index is by the source's loc, so the list is
 * stable.
 */
async function indexEdgeSources(db: Db, indexNodeIds: string[]) {
  if (indexNodeIds.length === 0) return [];
  const edges = await db.edge.findMany({
    where: {
      targetId: { in: indexNodeIds },
      deletedAt: null,
      source: { deletedAt: null, nodeType: { not: COMMENT_NODE_TYPE } },
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
 * #2421 experiment: symptom ranks its runnable effective-chain subset by
 * abstract only (cor:dmo:050:15); omission preserves the original list.
 */
export async function listAgentTasks(db: Db, auth: AuthContext, agentId: string, ref: string, search: AgentTaskSearch = {}): Promise<AgentTaskEntry[]> {
  const agent = await gatedAgent(db, auth, agentId, ref);
  const ctx = await agentContext(db, agent);
  const entries = await tasksOf(db, auth, agent, ctx);
  if (search.symptom == null) return entries; // byte-identical legacy list
  const symptom = search.symptom.trim();
  if (!symptom || (search.limit != null && (!Number.isInteger(search.limit) || search.limit < 1))) {
    throw new GraphQLError('symptom must be non-empty and limit must be a positive integer.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  const limit = Math.min(search.limit ?? 3, 3);
  // #2421 experimental search is only the effective SYSTEM set, not the wider
  // readable outside-chain index entries accepted by the unfiltered list.
  const rows = await db.node.findMany({
    where: { id: { in: entries.map(e => e.node.id) }, memoryId: { in: ctx.scope.memoryIds }, deletedAt: null, isRunnable: true, abstract: { not: null } },
    select: { id: true, memoryId: true, loc: true, role: true, deletedAt: true, abstract: true },
  });
  const candidates = rows.filter(r => !!r.abstract?.trim());
  if (!candidates.length) return [];
  const ids = candidates.map(r => r.id);
  const provider = getRetrievalProvider();
  const lexOpts = { db, memoryIds: ctx.scope.memoryIds, candidateNodeIds: ids, abstractOnly: true, limit: ids.length, filter: { isRunnable: true } };
  let vector: Array<{ nodeId: string; score: number }> = [];
  let vectorAvailable = false;
  if (isEmbeddingConfigured()) {
    // Embedding unavailability degrades to keyword; database/provider errors
    // still escape. Summary-only filtering occurs before the vector window.
    let embedding: number[] | undefined;
    try { [embedding] = await getEmbeddingClient().embed([symptom], 'query'); } catch { /* keyword fallback */ }
    vectorAvailable = !!embedding;
    if (embedding) vector = await provider.vectorSearch({ db, memoryIds: ctx.scope.memoryIds, candidateNodeIds: ids, abstractOnly: true, queryEmbedding: embedding, limit: ids.length, contentScope: 'CONTENT' });
  }
  const { hits: keyword } = await hybridKeywordCandidates(symptom,
    query => provider.lexicalSearch({ ...lexOpts, fields: ['abstract'], query }), !vectorAvailable);
  const ranked = composeHybridRanking(keyword, vector, ids.length);
  // Re-read and re-authorize current rows before rendering; an override, move,
  // revocation or boot-prompt turn during retrieval cannot retain an old stamp.
  const current = await db.node.findMany({
    where: { id: { in: ranked.map(h => h.nodeId) }, memoryId: { in: ctx.scope.memoryIds }, isRunnable: true, deletedAt: null, abstract: { not: null } },
    select: { id: true, memoryId: true, loc: true, role: true, deletedAt: true, abstract: true },
  });
  const effective = await retainEffective(db, current, await effectiveScope(db, [agent.systemMemoryId]));
  const ok = await reverifyServed(db, auth, agent.systemMemoryId, entries.map(e => e.node), effective);
  const byId = new Map(entries.map(e => [e.node.id, e]));
  const abstract = new Map(effective.filter(r => !!r.abstract?.trim()).map(r => [r.id, r.abstract!]));
  return ranked.flatMap(h => {
    const entry = byId.get(h.nodeId);
    if (!entry || !ok.has(h.nodeId) || !abstract.has(h.nodeId)) return [];
    return [{ ...entry, node: { ...entry.node, abstract: abstract.get(h.nodeId)! }, matchedBy: h.matchedBy }];
  }).slice(0, limit);
}

async function tasksOf(
  db: Db,
  auth: AuthContext,
  agent: GatedAgent,
  ctx: Awaited<ReturnType<typeof agentContext>>,
): Promise<AgentTaskEntry[]> {
  const indexIds = await chainIndexIds(db, agent, ctx, 'tasksIndexRef');
  const listed = await resolveIndexSources(db, auth, ctx, await indexEdgeSources(db, indexIds));

  // S5 — every runnable node in the effective memory is a task, edge or not.
  // The scope's exclusions are a snapshot, so the rows read are re-checked
  // against the chain as it is now (#1891's retainEffective).
  const runnable = await retainEffective(db, await db.node.findMany({
    where: {
      memoryId: { in: ctx.scope.memoryIds },
      isRunnable: true,
      deletedAt: null,
      // A comment is never content (cor:dmo:110); the comment path never sets
      // isRunnable, and this keeps the list from relying on that (#1935).
      nodeType: { not: COMMENT_NODE_TYPE },
      ...(ctx.scope.excludeNodeIds.length > 0 ? { id: { notIn: ctx.scope.excludeNodeIds } } : {}),
    },
    select: LIST_NODE_SELECT,
  }), ctx.scope);
  const out = new Map<string, AgentTaskEntry>(listed);
  for (const row of runnable) {
    if (out.has(row.id)) continue;
    out.set(row.id, { node: { ...pick(row), inheritedFrom: ctx.inheritedOf(row.memoryId) }, trigger: null });
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
 * An Agent's processes (cor:dmo:050:16): those it starts or owns, through the
 * chain's processes indexes (Q7), then those it's involved in, from `stage …`
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
    await indexEdgeSources(db, await chainIndexIds(db, agent, ctx, 'processesIndexRef')),
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
  // #1941 — a stage source in a BASE's memory is an inherited node's edge, so
  // it is read through the child as #1899 serves it (050:14; Holger #10968
  // item 2, #11663): resolved by loc through the effective memory, the
  // child's override winning, a node not in effect dropped, and the version
  // read re-checked. What is in effect there must itself be a process. The
  // audience is the list's own (readers of the child's system memory); a
  // base memory's own gate is never consulted, and never widened. Sources in
  // the Agent's own memory and outside the chain are read directly, under the
  // caller's own gate (Q4), as before.
  const baseMemoryIds = new Set(ctx.links.slice(1).map((l) => l.memoryId));
  const candidates = stages.map((s) => s.source).filter((s) => isProcessRole(s.role));
  const direct = candidates.filter((s) => !baseMemoryIds.has(s.memoryId));
  const readable = await filterReadableMemoryIds(db, auth, direct.map((s) => s.memoryId));
  const involved = new Map<string, ListedNode>();
  for (const s of candidates) {
    let node: ListedNode | null;
    if (baseMemoryIds.has(s.memoryId)) {
      const inEffect = await ctx.effectiveRowAt(s);
      node = inEffect && isProcessRole(inEffect.role) ? inEffect.node : null;
    } else {
      node = readable.has(s.memoryId) ? { ...pick(s), inheritedFrom: null } : null;
    }
    if (!node || out.has(node.id) || involved.has(node.id)) continue;
    involved.set(node.id, node);
  }
  for (const node of [...involved.values()].sort((a, b) => byLoc({ node: a }, { node: b }))) {
    out.set(node.id, { node, kind: 'INVOLVED', trigger: null });
  }
  return [...out.values()];
}

/**
 * Anne's P2-1 on #1896: a surface that re-reads the rows it serves (GraphQL
 * hydrates full Node rows after the list is built) must re-authorize what it
 * actually read, not what the list saw. A row is served only if it is still
 * live, the reader may still read the Agent's system memory, and then:
 *  - an inherited row is still the node the child passes down at its loc
 *    (#1891's {@link stillInherited}: not overridden since, not a boot prompt);
 *  - any other row's CURRENT memory is still readable through the shared gate.
 * Returns the ids that pass.
 */
export async function reverifyServed(
  db: Db,
  auth: AuthContext,
  agentSystemMemoryId: string,
  listed: ListedNode[],
  rows: Array<{ id: string; memoryId: string; loc: string; role: string | null; deletedAt: Date | null }>,
): Promise<Set<string>> {
  const ok = new Set<string>();
  if (!(await canReadMemory(db, auth, agentSystemMemoryId))) return ok;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const direct = listed.filter((n) => !n.inheritedFrom).map((n) => byId.get(n.id)?.memoryId).filter((m): m is string => !!m);
  const readable = await filterReadableMemoryIds(db, auth, direct);
  for (const n of listed) {
    const row = byId.get(n.id);
    if (!row || row.deletedAt) continue;
    const pass = n.inheritedFrom
      ? await stillInherited(db, { ...n.inheritedFrom, via: n.inheritedFrom.via ?? agentSystemMemoryId }, row)
      : readable.has(row.memoryId);
    if (pass) ok.add(n.id);
  }
  return ok;
}
