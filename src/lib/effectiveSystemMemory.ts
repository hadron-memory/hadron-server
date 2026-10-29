/**
 * #1885 slice 2 — an Agent's effective system memory (cor:dmo:050:14).
 *
 * A child's effective system memory is the nodes of every Agent in its base
 * chain plus its own, read live (nothing is copied). Where two Agents in the
 * chain hold a node at the same loc, the nearest one to the child wins, the
 * child's own first, replacing the other whole by address. Boot prompts are
 * never inherited: a base's node whose role family is `boot-prompt`
 * (cor:agt:040:05) is not part of any child's effective memory, and doesn't
 * hide a farther base's node either, since it isn't a candidate at all.
 * Comments are never inherited either (#1935): a comment lives in its
 * target's memory and is read by exactly that memory's readers
 * (cor:dmo:110:02), so a base's comment is never part of a child's effective
 * memory. Comment locs are unique (`comments:<id>`), so excluding one hides
 * nothing else.
 *
 * Addressing (Holger, team chat #10929): an inherited node keeps its own
 * address, the base's URN, and is marked as inherited, naming the base it
 * comes from. It is never re-addressed into the child's memory.
 *
 * This module only computes the set. Who may read it is the callers' gate.
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { AGENT_BASE_CHAIN_CAP } from './agentBase.js';
import { COMMENT_NODE_TYPE } from './comments/index.js';

type Db = Pick<PrismaClient, '$queryRaw'> | Prisma.TransactionClient;

/** The role family a base never passes down (cor:dmo:050:14 ruling 2). */
export const NOT_INHERITED_ROLE = 'boot-prompt';

/** One Agent in a chain, with the system memory it contributes. */
export type ChainLink = { agentId: string; agentUrn: string; memoryId: string };

/**
 * The chain of system memories for `memoryId`, nearest first: the memory's own
 * Agent, then its base, and so on. A memory that is no live Agent's system
 * memory, or whose Agent extends nothing, yields just itself (with the Agent,
 * if any), so callers can treat every memory the same way. An Agent in the
 * chain with no system memory contributes nothing and is skipped.
 */
export async function systemMemoryChain(db: Db, memoryId: string): Promise<ChainLink[]> {
  const rows = await db.$queryRaw<Array<{ agent_id: string; agent_urn: string; memory_id: string | null; depth: number }>>`
    WITH RECURSIVE chain(agent_id, depth) AS (
      SELECT id, 1 FROM agents WHERE system_memory_id = ${memoryId} AND deleted_at IS NULL
      UNION ALL
      SELECT a.extends_agent_id, chain.depth + 1
      FROM agents a JOIN chain ON a.id = chain.agent_id
      WHERE a.extends_agent_id IS NOT NULL AND chain.depth < ${AGENT_BASE_CHAIN_CAP}
    )
    SELECT a.id AS agent_id, a.urn AS agent_urn, a.system_memory_id AS memory_id, chain.depth
    FROM chain JOIN agents a ON a.id = chain.agent_id
    WHERE a.deleted_at IS NULL
    ORDER BY chain.depth`;
  const links = rows
    .filter((r): r is typeof r & { memory_id: string } => r.memory_id !== null)
    .map((r) => ({ agentId: r.agent_id, agentUrn: r.agent_urn, memoryId: r.memory_id }));
  return links;
}

/**
 * The ids of the nodes a chain passes down to its first memory: every live
 * node of a base memory (positions 2..n) that isn't a boot prompt and isn't
 * hidden by a live, non-boot-prompt node at the same loc nearer the child.
 * The child's own nodes are not included; they are the child's memory as it
 * already reads. Empty for a chain of one.
 */
export async function inheritedNodeIds(db: Db, chain: ChainLink[]): Promise<Map<string, ChainLink>> {
  const out = new Map<string, ChainLink>();
  if (chain.length < 2) return out;
  const memIds = chain.map((l) => l.memoryId);
  const rows = await db.$queryRaw<Array<{ id: string; pos: number }>>`
    WITH chain AS (
      SELECT id AS memory_id, pos::int AS pos FROM unnest(${memIds}::text[]) WITH ORDINALITY AS m(id, pos)
    ),
    candidate AS (
      SELECT n.id, n.loc, c.pos FROM nodes n JOIN chain c ON n.memory_id = c.memory_id
      WHERE n.deleted_at IS NULL
        AND (c.pos = 1 OR n.role IS NULL OR NOT (n.role = ${NOT_INHERITED_ROLE} OR n.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
        AND (c.pos = 1 OR n.node_type <> ${COMMENT_NODE_TYPE})
    )
    SELECT c.id, c.pos FROM candidate c
    WHERE c.pos > 1
      AND NOT EXISTS (SELECT 1 FROM candidate nearer WHERE nearer.loc = c.loc AND nearer.pos < c.pos)`;
  for (const r of rows) out.set(r.id, chain[r.pos - 1]!);
  return out;
}

/**
 * Where a node is effective, for the read gate: every live system memory whose
 * effective memory includes `node`, other than the node's own. Each entry
 * names the descendant memory and the Agent the node is inherited from. Empty
 * for a node outside any Agent's system memory, a boot prompt, a comment
 * (#1935), or a node every descendant overrides.
 */
export async function descendantMemoriesInheriting(
  db: Db,
  node: { id: string; memoryId: string; loc: string; role: string | null },
): Promise<string[]> {
  if (node.role === NOT_INHERITED_ROLE || node.role?.startsWith(`${NOT_INHERITED_ROLE}.`)) return [];
  const self = await db.$queryRaw<Array<{ node_type: string }>>`SELECT node_type FROM nodes WHERE id = ${node.id}`;
  if (self[0]?.node_type === COMMENT_NODE_TYPE) return [];
  // Every live Agent below the node's own Agent, with the memories between
  // it and the node's: a descendant inherits the node unless one of those
  // nearer memories, or its own, holds a live non-boot-prompt node at the loc.
  const rows = await db.$queryRaw<Array<{ memory_id: string }>>`
    WITH RECURSIVE owner AS (
      SELECT id FROM agents WHERE system_memory_id = ${node.memoryId} AND deleted_at IS NULL
    ),
    down(agent_id, memory_id, path, depth) AS (
      SELECT a.id, a.system_memory_id, ARRAY[a.system_memory_id]::text[], 1
      FROM agents a JOIN owner ON a.extends_agent_id = owner.id
      WHERE a.deleted_at IS NULL
      UNION ALL
      SELECT a.id, a.system_memory_id, down.path || a.system_memory_id, down.depth + 1
      FROM agents a JOIN down ON a.extends_agent_id = down.agent_id
      WHERE a.deleted_at IS NULL AND down.depth < ${AGENT_BASE_CHAIN_CAP}
    )
    SELECT d.memory_id FROM down d
    WHERE d.memory_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM nodes o
        WHERE o.memory_id = ANY(d.path) AND o.loc = ${node.loc} AND o.deleted_at IS NULL
          AND (o.memory_id = d.memory_id OR o.role IS NULL OR NOT (o.role = ${NOT_INHERITED_ROLE} OR o.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
      )`;
  return rows.map((r) => r.memory_id);
}

/** The base Agent an inherited node comes from (cor:dmo:050:14, #10929's marking). */
export type InheritedFrom = {
  agentId: string;
  agentUrn: string;
  /**
   * The child system memory a single read came through, so the row it
   * finally serves can be re-checked against that child (never served).
   * Unset on listing stamps, which re-check against their whole scope.
   */
  via?: string;
};

/**
 * A memory scope widened by inheritance, for a listing scoped to memories.
 *
 * - `memoryIds`: the requested memories plus every base system memory one of
 *   them inherits from. A base the scope already names stays as it was.
 * - `excludeNodeIds`: the nodes of those ADDED base memories that no memory in
 *   the scope inherits (boot prompts, comments, and nodes every inheriting
 *   memory in the scope overrides). A listing applies `id NOT IN excludeNodeIds` with the
 *   widened `memoryIds`, so a reader sees a base's node only when it is part
 *   of the effective memory they asked for, and never a base's other content.
 * - `inheritedFrom`: for each added base memory, its Agent: a node read from
 *   one of them is inherited, and names it.
 *
 * The caller must already have gated the requested memories: this widens
 * them by exactly what reading them through their bases shows, nothing more.
 */
export type EffectiveScope = {
  memoryIds: string[];
  excludeNodeIds: string[];
  inheritedFrom: Map<string, InheritedFrom>;
  /** The requested memories that widened the scope, for {@link retainEffective}. */
  roots: string[];
};

export async function effectiveScope(db: Db, memoryIds: string[]): Promise<EffectiveScope> {
  const requested = new Set(memoryIds);
  const inheritedFrom = new Map<string, InheritedFrom>();
  if (memoryIds.length === 0) return { memoryIds, excludeNodeIds: [], inheritedFrom, roots: [] };
  // Only the requested memories that are a live Agent's system memory AND whose
  // Agent extends something can widen the scope; one query finds them.
  const roots = await db.$queryRaw<Array<{ memory_id: string }>>`
    SELECT system_memory_id AS memory_id FROM agents
    WHERE system_memory_id = ANY(${memoryIds}::text[]) AND deleted_at IS NULL AND extends_agent_id IS NOT NULL`;
  if (roots.length === 0) return { memoryIds, excludeNodeIds: [], inheritedFrom, roots: [] };

  const inherited = new Set<string>();
  const added: string[] = [];
  for (const { memory_id } of roots) {
    const chain = await systemMemoryChain(db, memory_id);
    for (const link of chain.slice(1)) {
      if (requested.has(link.memoryId) || inheritedFrom.has(link.memoryId)) continue;
      inheritedFrom.set(link.memoryId, { agentId: link.agentId, agentUrn: link.agentUrn });
      added.push(link.memoryId);
    }
    for (const id of (await inheritedNodeIds(db, chain)).keys()) inherited.add(id);
  }
  if (added.length === 0) return { memoryIds, excludeNodeIds: [], inheritedFrom, roots: [] };
  const keep = [...inherited];
  const excluded = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM nodes
    WHERE memory_id = ANY(${added}::text[]) AND NOT (id = ANY(${keep}::text[]))`;
  return { memoryIds: [...memoryIds, ...added], excludeNodeIds: excluded.map((r) => r.id), inheritedFrom, roots: roots.map((r) => r.memory_id) };
}

/**
 * The node a bare `loc` names in `memoryId`'s effective memory: the memory's
 * own live node at that loc, or else the nearest base's inherited one. Null
 * when neither exists. Like {@link effectiveScope}, it reads through a memory
 * the caller has already gated.
 */
export async function findEffectiveNodeIdByLoc(
  db: Db,
  memoryId: string,
  loc: string,
  options: { inheritRoot?: boolean } = {},
): Promise<{ id: string; memoryId: string; inheritedFrom: InheritedFrom | null } | null> {
  // A memory-less child starts at its first contributing base; that root is inherited too.
  const inheritRoot = options.inheritRoot ?? false;
  const chain = await systemMemoryChain(db, memoryId);
  const links = chain.length > 0 ? chain : [{ agentId: '', agentUrn: '', memoryId }];
  const memIds = links.map((l) => l.memoryId);
  const rows = await db.$queryRaw<Array<{ id: string; memory_id: string; pos: number }>>`
    SELECT n.id, n.memory_id, c.pos::int AS pos
    FROM unnest(${memIds}::text[]) WITH ORDINALITY AS c(memory_id, pos)
    JOIN nodes n ON n.memory_id = c.memory_id
    WHERE n.loc = ${loc} AND n.deleted_at IS NULL
      AND ((c.pos = 1 AND NOT ${inheritRoot}) OR n.role IS NULL OR NOT (n.role = ${NOT_INHERITED_ROLE} OR n.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
      AND ((c.pos = 1 AND NOT ${inheritRoot}) OR n.node_type <> ${COMMENT_NODE_TYPE})
    ORDER BY c.pos LIMIT 1`;
  const hit = rows[0];
  if (!hit) return null;
  const link = links[hit.pos - 1]!;
  return { id: hit.id, memoryId: hit.memory_id, inheritedFrom: hit.pos === 1 ? null : { agentId: link.agentId, agentUrn: link.agentUrn, via: memoryId } };
}

/**
 * `findEffectiveNodeIdByLoc` for many roots at once (#2608 / #2724, Atilla's
 * BLIND P2): one walk seeds every root memory, chains kept apart by the root
 * column, and one nearest-hit selection resolves every root — a roster's worth
 * of per-memory lookups becomes one statement. Same edges, same
 * {@link AGENT_BASE_CHAIN_CAP}, same nearest-first pos numbering (memory-less
 * Agents are skipped, exactly as {@link systemMemoryChain} skips them), and
 * the same per-root `inheritRoot` rule: a root flagged inherited filters its
 * own pos-1 nodes by role and node type, one flagged own does not. Results
 * are keyed `"<memoryId>:<inheritRoot>"`, mirroring the flag the singular
 * would have received, so one memory can be asked both ways in one call.
 */
export async function findEffectiveNodeIdsByLoc(
  db: Db,
  roots: Array<{ memoryId: string; inheritRoot: boolean }>,
  loc: string,
): Promise<Map<string, { id: string; memoryId: string; inheritedFrom: InheritedFrom | null } | null>> {
  const out = new Map<string, { id: string; memoryId: string; inheritedFrom: InheritedFrom | null } | null>(
    roots.map((r) => [`${r.memoryId}:${r.inheritRoot}`, null]),
  );
  if (!roots.length) return out;
  const rootIds = roots.map((r) => r.memoryId);
  const rootFlags = roots.map((r) => r.inheritRoot);
  const rows = await db.$queryRaw<
    Array<{ root: string; inherit_root: boolean; node_id: string; memory_id: string; pos: number; agent_id: string; agent_urn: string }>
  >`
    WITH RECURSIVE memup(root, agent_id, depth) AS (
      SELECT r.memory_id, a.id, 1 FROM unnest(${rootIds}::text[]) AS r(memory_id)
      JOIN agents a ON a.system_memory_id = r.memory_id
      WHERE a.deleted_at IS NULL
      UNION ALL
      SELECT memup.root, b.extends_agent_id, memup.depth + 1
      FROM agents b JOIN memup ON b.id = memup.agent_id
      WHERE b.extends_agent_id IS NOT NULL AND memup.depth < ${AGENT_BASE_CHAIN_CAP}
    ),
    walked AS (
      SELECT root, a.id AS agent_id, a.urn AS agent_urn, a.system_memory_id AS memory_id, depth
      FROM memup JOIN agents a ON a.id = memup.agent_id
      WHERE a.deleted_at IS NULL AND a.system_memory_id IS NOT NULL
      UNION ALL
      -- A root no live Agent claims is its own only link, as in the singular.
      SELECT r.memory_id, '', '', r.memory_id, 0 FROM unnest(${rootIds}::text[]) AS r(memory_id)
      WHERE NOT EXISTS (SELECT 1 FROM memup mu WHERE mu.root = r.memory_id)
    ),
    links AS (
      SELECT root, agent_id, agent_urn, memory_id,
             ROW_NUMBER() OVER (PARTITION BY root ORDER BY depth) AS pos
      FROM walked
    ),
    ask(root, inherit_root) AS (SELECT * FROM unnest(${rootIds}::text[], ${rootFlags}::boolean[]) AS a(root, inherit_root))
    SELECT DISTINCT ON (l.root, ask.inherit_root) l.root, ask.inherit_root, n.id AS node_id, l.memory_id, l.pos::int AS pos, l.agent_id, l.agent_urn
    FROM links l
    JOIN ask ON ask.root = l.root
    JOIN nodes n ON n.memory_id = l.memory_id
    WHERE n.loc = ${loc} AND n.deleted_at IS NULL
      AND ((l.pos = 1 AND NOT ask.inherit_root) OR n.role IS NULL OR NOT (n.role = ${NOT_INHERITED_ROLE} OR n.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
      AND ((l.pos = 1 AND NOT ask.inherit_root) OR n.node_type <> ${COMMENT_NODE_TYPE})
    ORDER BY l.root, ask.inherit_root, l.pos`;
  for (const r of rows) {
    out.set(`${r.root}:${r.inherit_root}`, {
      id: r.node_id,
      memoryId: r.memory_id,
      inheritedFrom: r.pos === 1 ? null : { agentId: r.agent_id, agentUrn: r.agent_urn, via: r.root },
    });
  }
  return out;
}

/**
 * Stamp `inheritedFrom` on rows read through {@link effectiveScope}: a row
 * from one of its added base memories is inherited and names that base. Rows
 * already stamped, and rows from the requested memories, are left alone.
 */
export function markInherited<T extends { memoryId: string }>(
  rows: readonly T[],
  inheritedFrom: ReadonlyMap<string, InheritedFrom>,
): void {
  if (inheritedFrom.size === 0) return;
  for (const row of rows) {
    const from = inheritedFrom.get(row.memoryId);
    if (from && !(row as { inheritedFrom?: InheritedFrom }).inheritedFrom) {
      (row as T & { inheritedFrom?: InheritedFrom }).inheritedFrom = from;
    }
  }
}

const isNotInheritedRole = (role: string | null | undefined): boolean =>
  role === NOT_INHERITED_ROLE || role?.startsWith(`${NOT_INHERITED_ROLE}.`) === true;

/**
 * Re-check rows a listing fetched through {@link effectiveScope} (Diego's P2-1
 * on #1891). The scope's exclusion list is a snapshot, taken before the
 * listing's own query: a boot prompt inserted, a node turned into one, a child
 * override added or a base cleared in between would otherwise ride through.
 * So every row from an added base memory is kept only if, NOW, it is still
 * inherited by one of the scope's roots, and the version actually read is not
 * a boot prompt. Rows from the requested memories pass untouched. Order kept.
 */
export async function retainEffective<T extends { id: string; memoryId: string; role?: string | null }>(
  db: Db,
  rows: T[],
  scope: EffectiveScope,
): Promise<T[]> {
  if (scope.inheritedFrom.size === 0) return rows;
  const candidates = rows.filter((r) => scope.inheritedFrom.has(r.memoryId));
  if (candidates.length === 0) return rows;
  // node id -> the first root (in scope order) that inherits it now: the
  // child each kept row is read through, so its edges resolve there (#1893).
  const viaById = new Map<string, string>();
  for (const root of scope.roots) {
    for (const id of (await inheritedNodeIds(db, await systemMemoryChain(db, root))).keys()) {
      if (!viaById.has(id)) viaById.set(id, root);
    }
  }
  const kept = rows.filter((r) => !scope.inheritedFrom.has(r.memoryId) || (viaById.has(r.id) && !isNotInheritedRole(r.role)));
  for (const r of kept) {
    const from = scope.inheritedFrom.get(r.memoryId);
    if (from) (r as T & { inheritedFrom?: InheritedFrom }).inheritedFrom = { ...from, via: viaById.get(r.id)! };
  }
  return kept;
}

/**
 * Is `row`, as read, still the node its child passes down at its loc? For a
 * single read that selected an inherited node and then re-fetched it (the
 * reconcile): the re-fetched version must not be a boot prompt, and the
 * child's effective memory must still resolve the loc to this very node.
 */
export async function stillInherited(
  db: Db,
  from: InheritedFrom,
  row: { id: string; loc: string; role?: string | null },
): Promise<boolean> {
  if (!from.via || isNotInheritedRole(row.role)) return false;
  const effective = await findEffectiveNodeIdByLoc(db, from.via, row.loc);
  return effective?.id === row.id && effective.inheritedFrom !== null;
}

/**
 * Is the endpoint row `resolveInheritedEdges` is about to serve, AS READ, still
 * the node `via`'s effective memory selects at `loc`? (Diego's P2 on #1899.)
 * The selection and the read are separate queries, so a concurrent write can
 * land between them in either order: a selected override turned boot prompt,
 * moved, or replaced before it is hydrated; or an endpoint the edge query
 * preloaded as a boot prompt that stopped being one before the selection.
 * So the version actually read must sit at the selected memory and loc, and
 * a fresh lookup must still resolve the loc to it, not as a boot prompt when
 * inherited. Anything else drops the edge; it is never served under the
 * selection's stale stamp. Exported for #1941: the Agent lists resolve
 * in-chain sources the same way and run the same check (Andi's P2 on #1949).
 */
export async function servedEndpointInEffect(
  db: Db,
  via: string,
  loc: string,
  selected: { id: string; memoryId: string; inheritedFrom: InheritedFrom | null },
  row: { id: string; memoryId: string; loc: string; role?: string | null; deletedAt?: Date | null },
): Promise<boolean> {
  if (row.deletedAt || row.id !== selected.id || row.memoryId !== selected.memoryId || row.loc !== loc) return false;
  if (selected.inheritedFrom) return stillInherited(db, selected.inheritedFrom, row);
  return (await findEffectiveNodeIdByLoc(db, via, loc))?.id === row.id;
}

/** An edge of an inherited node, resolved through its child (#1893). */
export type ResolvedInheritedEdge<E, N> = { edge: E; endpoint: N & { inheritedFrom?: InheritedFrom } };

/**
 * #1893 (cor:dmo:050:14; Holger, team chat #10968 item 2) — an inherited
 * node's edges, read through the child it came through, resolved the way
 * bare-loc links are (#10932):
 *
 * - an endpoint in the child's chain resolves BY LOC through the child's
 *   effective memory: the child's override wins, and an endpoint that isn't
 *   in effect there (overridden away to nothing, a base boot prompt) drops
 *   the edge. A resolved endpoint that is inherited is stamped, `via` the
 *   same child, so its own fields are the sanitized projection too;
 * - an endpoint outside the chain shows only when `canReadMemory` admits its
 *   own memory: never widened.
 *
 * Both directions follow the same rule. So no edge ever hands over a base
 * node that is not in effect for the child (S7 stays shut).
 */
export async function resolveInheritedEdges(
  db: Pick<PrismaClient, '$queryRaw' | 'edge' | 'node'>,
  args: {
    nodeId: string;
    via: string;
    direction: 'out' | 'in';
    canReadMemory: (memoryId: string) => Promise<boolean>;
    /** Batch reads bound retained authorized results and page raw edge metadata, not endpoint bodies. */
    maxResults?: number;
    onLimit?: () => never;
  },
) {
  const chain = await systemMemoryChain(db as Db, args.via);
  const inChain = new Set(chain.map((l) => l.memoryId));
  const far = args.direction === 'out' ? 'target' : 'source';
  const bounded = args.maxResults !== undefined;
  const pageSize = 128;
  let cursor: string | undefined;
  const readPage = () => db.edge.findMany({
    where: args.direction === 'out'
      ? { sourceId: args.nodeId, deletedAt: null, target: { deletedAt: null } }
      : { targetId: args.nodeId, deletedAt: null, source: { deletedAt: null } },
    ...(!bounded ? { include: { [far]: true } as { target: true } | { source: true } } : {}),
    orderBy: bounded ? [{ loc: 'asc' }, { id: 'asc' }] : { loc: 'asc' },
    ...(bounded ? { take: pageSize, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) } : {}),
  });
  let edges = await readPage();
  type EdgeRow = (typeof edges)[number];
  type NodeRow = NonNullable<Awaited<ReturnType<typeof db.node.findUnique>>>;
  const out: Array<ResolvedInheritedEdge<EdgeRow, NodeRow>> = [];
  const checkLimit = () => {
    if (args.maxResults === undefined || out.length <= args.maxResults) return;
    if (args.onLimit) args.onLimit();
    throw new Error('Inherited edge result limit exceeded.');
  };
  do {
    for (const edge of edges) {
      const endpoint = bounded
        ? await db.node.findUnique({ where: { id: args.direction === 'out' ? edge.targetId : edge.sourceId }, select: { id: true, memoryId: true, loc: true, deletedAt: true } })
        : (edge as unknown as Record<string, NodeRow>)[far]!;
      if (!endpoint || endpoint.deletedAt) continue;
      if (!inChain.has(endpoint.memoryId)) {
        if (await args.canReadMemory(endpoint.memoryId)) {
          const row = bounded ? await db.node.findUnique({ where: { id: endpoint.id } }) : endpoint as NodeRow;
          if (row && row.memoryId === endpoint.memoryId && row.loc === endpoint.loc && !row.deletedAt) out.push({ edge, endpoint: row });
        }
        checkLimit();
        continue;
      }
      const effective = await findEffectiveNodeIdByLoc(db as Db, args.via, endpoint.loc);
      if (!effective) continue;
      const row = effective.id === endpoint.id && !bounded ? endpoint as NodeRow : await db.node.findUnique({ where: { id: effective.id } });
      if (!row || !(await servedEndpointInEffect(db as Db, args.via, endpoint.loc, effective, row))) continue;
      out.push({ edge, endpoint: effective.inheritedFrom ? { ...row, inheritedFrom: effective.inheritedFrom } : row });
      checkLimit();
    }
    if (!bounded || edges.length < pageSize) break;
    cursor = edges.at(-1)!.id;
    edges = await readPage();
  } while (edges.length);
  return out;
}

/**
 * #2044 (S7), cor:agt:040:16 / cor:dmo:050:14 (R8) — the chain a COMPILE reads for
 * an App's installed Agent, nearest first: the App's INSTALL MEMORY (when the App
 * has customised the Agent and is live), then the Agent's own system memory, then
 * each base. ONE resolver for inheritance and install overrides, so the two cannot
 * drift into different notions of "nearest".
 *
 * Deliberately NOT {@link systemMemoryChain}: ordinary reads of the Agent's system
 * memory never see an install memory (#1840 stays deferred), and only a compile
 * calls this. `exemptThrough` is how many leading links are NOT bases: the install
 * memory and the Agent's own memory are the App's and the Agent's own, so their
 * boot prompts and comments stay candidates; only a base's boot prompt is dropped
 * (cor:agt:040:05), and it hides nothing (it isn't a candidate at all).
 *
 * A full node URN names exactly that node and never goes through this chain.
 */
export async function compileChain(
  db: Db,
  target: { appId: string; agentId: string },
): Promise<{ links: ChainLink[]; exemptThrough: number; installMemoryId: string | null }> {
  const agent = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ urn: string; system_memory_id: string | null }>>`
    SELECT urn, system_memory_id FROM agents WHERE id = ${target.agentId} AND deleted_at IS NULL`;
  const own = agent[0];
  if (!own) return { links: [], exemptThrough: 0, installMemoryId: null };
  const install = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM memories m JOIN apps a ON a.id = m.app_id
    WHERE m.app_id = ${target.appId} AND m.install_of_agent_id = ${target.agentId}
      AND m.class = 'system' AND m.deleted_at IS NULL
      AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL
      AND EXISTS (SELECT 1 FROM app_agents aa WHERE aa.app_id = a.id AND aa.agent_id = ${target.agentId})`;
  const links: ChainLink[] = [];
  if (install[0]) links.push({ agentId: target.agentId, agentUrn: own.urn, memoryId: install[0].id });
  const base = own.system_memory_id ? await systemMemoryChain(db, own.system_memory_id) : [];
  links.push(...base);
  // The install memory and the Agent's own memory (first of `base`) are not bases.
  return { links, exemptThrough: (install[0] ? 1 : 0) + (base.length > 0 ? 1 : 0), installMemoryId: install[0]?.id ?? null };
}

/**
 * The node a bare `loc` names in a COMPILE for `(App, Agent)`: the nearest of
 * {@link compileChain}'s links that holds a live node there. Null when none does.
 * A link past `exemptThrough` is a base, so its boot prompts and comments don't count.
 */
export async function findCompileNodeIdByLoc(
  db: Db,
  target: { appId: string; agentId: string },
  loc: string,
): Promise<{ id: string; memoryId: string; fromInstall: boolean } | null> {
  const { links, exemptThrough, installMemoryId } = await compileChain(db, target);
  if (links.length === 0) return null;
  const memIds = links.map((l) => l.memoryId);
  const rows = await (db as Pick<PrismaClient, '$queryRaw'>).$queryRaw<Array<{ id: string; memory_id: string; pos: number }>>`
    SELECT n.id, n.memory_id, c.pos::int AS pos
    FROM unnest(${memIds}::text[]) WITH ORDINALITY AS c(memory_id, pos)
    JOIN nodes n ON n.memory_id = c.memory_id
    WHERE n.loc = ${loc} AND n.deleted_at IS NULL
      AND (c.pos <= ${exemptThrough} OR n.role IS NULL OR NOT (n.role = ${NOT_INHERITED_ROLE} OR n.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
      AND (c.pos <= ${exemptThrough} OR n.node_type <> ${COMMENT_NODE_TYPE})
    ORDER BY c.pos LIMIT 1`;
  const hit = rows[0];
  if (!hit) return null;
  return { id: hit.id, memoryId: hit.memory_id, fromInstall: hit.memory_id === installMemoryId };
}
