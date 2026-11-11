/**
 * #3833 — the skeleton parent nodes of an Agent's system memory.
 *
 * A new Agent's system memory gets four empty parents, so the places an Agent's
 * boot rules, processes and tasks live exist from the start:
 *
 *   boot        "Boot Instructions"    (parent of boot:source, boot:compiled, boot:rules)
 *   boot:rules  "Boot Prompt Rules"    (the rules a boot prompt includes)
 *   processes   "Processes"
 *   tasks       "Tasks"
 *
 * The rules, each from the spec review on the issue (hrn:node:hadronmemory.com:specs:cor:dmo:050:14,
 * cor:agt:040:06, :16, cor:dmo:050:18):
 *
 * - SYSTEM MEMORIES ONLY, never an install memory. An install-memory node replaces the Agent's node at the
 *   same loc for that App (cor:agt:040:16), so a skeleton there would hide the Agent's own `boot`, `processes`
 *   and `tasks`. The retrofit selects `class = 'system'` and `is_install_memory = false`.
 * - OPTION B, only locs the Agent's effective memory lacks. At a shared loc the nearest Agent's node wins
 *   (cor:dmo:050:14), so a skeleton node in a derived Agent would hide its base's node (the base's `boot:rules`
 *   text). A loc the chain already provides (own node, or an inherited non-boot-prompt one) is skipped.
 * - NEVER OVERWRITE. A loc that has any row in the memory, live or tombstoned, is left alone: its name and
 *   content are not touched, and a tombstone is not revived (the (loc, memory) key is unique anyway).
 * - `tasksIndexRef` / `processesIndexRef` are never read or written here (cor:dmo:050:15, :16).
 */

import type { Prisma, PrismaClient } from '../generated/prisma/index.js';
import { generateId } from './id.js';
import { findEffectiveNodeIdByLoc } from './effectiveSystemMemory.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** One skeleton parent. */
export type SkeletonNode = { loc: string; name: string; description: string };

/** The skeleton, parents before children. */
export const AGENT_SKELETON: readonly SkeletonNode[] = [
  { loc: 'boot', name: 'Boot Instructions', description: 'Parent of the Agent\'s boot prompt source, its compiled prompt and the rules a boot prompt includes.' },
  { loc: 'boot:rules', name: 'Boot Prompt Rules', description: 'Parent of the rule nodes a boot prompt includes with an include tag.' },
  { loc: 'processes', name: 'Processes', description: 'Parent of the Agent\'s processes.' },
  { loc: 'tasks', name: 'Tasks', description: 'Parent of the Agent\'s tasks.' },
];

/**
 * Create the skeleton nodes the Agent's effective memory does not already provide, in `memoryId`.
 * Returns the locs created. Idempotent: a second call creates nothing.
 *
 * The caller owns the memory: it must be a live Agent system memory (`class = 'system'`,
 * `is_install_memory = false`); this function does not check.
 */
export async function seedAgentSkeleton(db: Db, memoryId: string, createdBy: string | null): Promise<string[]> {
  const created: string[] = [];
  for (const node of AGENT_SKELETON) {
    // The effective lookup covers the memory's own live node and each base's inherited one.
    if (await findEffectiveNodeIdByLoc(db, memoryId, node.loc)) continue;
    // A tombstone holds the unique (loc, memory) key: leave it, never revive or overwrite.
    const tomb = await db.node.findFirst({ where: { memoryId, loc: node.loc }, select: { id: true } });
    if (tomb) continue;
    await db.node.create({
      data: { id: generateId(), memoryId, loc: node.loc, name: node.name, description: node.description, createdBy },
    });
    created.push(node.loc);
  }
  return created;
}

/** What a retrofit pass did to one Agent's system memory. */
export type RetrofitRow = { agentUrn: string; memoryId: string; created: string[] };

/** Thrown inside a dry run's outer transaction to roll everything back. */
class DryRunRollback extends Error {}

/**
 * One Agent's retrofit step, inside a transaction: re-judge the target under a row lock, then seed.
 * The selection ran earlier, so the memory may have changed since (promoted away from `system`, turned into an
 * install memory, retired, or detached from the Agent); a stale selection must write nothing (#3833 review F1).
 */
async function retrofitOne(tx: Prisma.TransactionClient, agentId: string, memoryId: string, actor: string | null): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM memories m
    WHERE m.id = ${memoryId} AND m.deleted_at IS NULL AND m.class = 'system' AND m.is_install_memory = false
      AND EXISTS (SELECT 1 FROM agents a WHERE a.id = ${agentId} AND a.deleted_at IS NULL AND a.system_memory_id = m.id)
    FOR UPDATE OF m`;
  if (!rows.length) return [];
  return seedAgentSkeleton(tx, memoryId, actor);
}

/**
 * The retrofit (#3833): give every live Agent's system memory the skeleton parents its effective memory lacks.
 *
 * Selects ONLY `class = 'system'` memories with `is_install_memory = false` that are some live Agent's own
 * `system_memory_id`: an install memory is never touched (cor:agt:040:16), and neither is any other class. That
 * selection is re-judged under a row lock in each Agent's own transaction, so a memory that changed since is skipped.
 * Bases are processed before their children (shallowest chain first), so a child sees the skeleton its base just gained
 * and skips those locs instead of hiding them (option B).
 * `dryRun` runs the very same steps in one outer transaction and rolls it back, so its report equals what an apply
 * would create, children included. Idempotent.
 */
export async function retrofitAgentSkeletons(db: PrismaClient, opts: { dryRun?: boolean; actor?: string | null } = {}): Promise<RetrofitRow[]> {
  const agents = await db.$queryRaw<Array<{ id: string; urn: string; memory_id: string; depth: number }>>`
    WITH RECURSIVE up(root, id, depth) AS (
      SELECT a.id, a.extends_agent_id, 0 FROM agents a WHERE a.deleted_at IS NULL
      UNION ALL
      SELECT up.root, a.extends_agent_id, up.depth + 1 FROM agents a JOIN up ON a.id = up.id
      WHERE up.depth < 8
    )
    SELECT a.id, a.urn, a.system_memory_id AS memory_id,
           (SELECT count(*) FROM up WHERE up.root = a.id AND up.id IS NOT NULL)::int AS depth
    FROM agents a JOIN memories m ON m.id = a.system_memory_id
    WHERE a.deleted_at IS NULL AND m.deleted_at IS NULL
      AND m.class = 'system' AND m.is_install_memory = false
    ORDER BY depth, a.urn`;
  const actor = opts.actor ?? 'system:3833';
  const out: RetrofitRow[] = [];
  if (opts.dryRun) {
    try {
      await db.$transaction(async (tx) => {
        for (const a of agents) out.push({ agentUrn: a.urn, memoryId: a.memory_id, created: await retrofitOne(tx, a.id, a.memory_id, actor) });
        throw new DryRunRollback();
      }, { timeout: 600_000, maxWait: 30_000 });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    return out;
  }
  for (const a of agents) {
    const created = await db.$transaction((tx) => retrofitOne(tx, a.id, a.memory_id, actor));
    out.push({ agentUrn: a.urn, memoryId: a.memory_id, created });
  }
  return out;
}
