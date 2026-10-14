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
 *
 * Addressing (Holger, team chat #10929): an inherited node keeps its own
 * address, the base's URN, and is marked as inherited, naming the base it
 * comes from. It is never re-addressed into the child's memory.
 *
 * This module only computes the set. Who may read it is the callers' gate.
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { AGENT_BASE_CHAIN_CAP } from './agentBase.js';

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
 * for a node outside any Agent's system memory, a boot prompt, or a node every
 * descendant overrides.
 */
export async function descendantMemoriesInheriting(
  db: Db,
  node: { id: string; memoryId: string; loc: string; role: string | null },
): Promise<string[]> {
  if (node.role === NOT_INHERITED_ROLE || node.role?.startsWith(`${NOT_INHERITED_ROLE}.`)) return [];
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
 *   the scope inherits (boot prompts, and nodes every inheriting memory in the
 *   scope overrides). A listing applies `id NOT IN excludeNodeIds` with the
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
): Promise<{ id: string; memoryId: string; inheritedFrom: InheritedFrom | null } | null> {
  const chain = await systemMemoryChain(db, memoryId);
  const links = chain.length > 0 ? chain : [{ agentId: '', agentUrn: '', memoryId }];
  const memIds = links.map((l) => l.memoryId);
  const rows = await db.$queryRaw<Array<{ id: string; memory_id: string; pos: number }>>`
    SELECT n.id, n.memory_id, c.pos::int AS pos
    FROM unnest(${memIds}::text[]) WITH ORDINALITY AS c(memory_id, pos)
    JOIN nodes n ON n.memory_id = c.memory_id
    WHERE n.loc = ${loc} AND n.deleted_at IS NULL
      AND (c.pos = 1 OR n.role IS NULL OR NOT (n.role = ${NOT_INHERITED_ROLE} OR n.role LIKE ${NOT_INHERITED_ROLE + '.%'}))
    ORDER BY c.pos LIMIT 1`;
  const hit = rows[0];
  if (!hit) return null;
  const link = links[hit.pos - 1]!;
  return { id: hit.id, memoryId: hit.memory_id, inheritedFrom: hit.pos === 1 ? null : { agentId: link.agentId, agentUrn: link.agentUrn, via: memoryId } };
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
  const live = new Set<string>();
  for (const root of scope.roots) {
    for (const id of (await inheritedNodeIds(db, await systemMemoryChain(db, root))).keys()) live.add(id);
  }
  return rows.filter((r) => !scope.inheritedFrom.has(r.memoryId) || (live.has(r.id) && !isNotInheritedRole(r.role)));
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
