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

/**
 * The retrofit (#3833): give every live Agent's system memory the skeleton parents its effective memory lacks.
 *
 * Selects ONLY `class = 'system'` memories with `is_install_memory = false` that are some live Agent's own
 * `system_memory_id`: an install memory is never touched (cor:agt:040:16), and neither is any other class.
 * Bases are processed before their children (shallowest chain first), one transaction per Agent, so a child
 * sees the skeleton its base just gained and skips those locs instead of hiding them (option B).
 * `dryRun` reports the locs it would create and writes nothing. Idempotent.
 */
export async function retrofitAgentSkeletons(db: PrismaClient, opts: { dryRun?: boolean; actor?: string | null } = {}): Promise<RetrofitRow[]> {
  const agents = await db.$queryRaw<Array<{ urn: string; memory_id: string; depth: number }>>`
    WITH RECURSIVE up(root, id, depth) AS (
      SELECT a.id, a.extends_agent_id, 0 FROM agents a WHERE a.deleted_at IS NULL
      UNION ALL
      SELECT up.root, a.extends_agent_id, up.depth + 1 FROM agents a JOIN up ON a.id = up.id
      WHERE up.depth < 8
    )
    SELECT a.urn, a.system_memory_id AS memory_id,
           (SELECT count(*) FROM up WHERE up.root = a.id AND up.id IS NOT NULL)::int AS depth
    FROM agents a JOIN memories m ON m.id = a.system_memory_id
    WHERE a.deleted_at IS NULL AND m.deleted_at IS NULL
      AND m.class = 'system' AND m.is_install_memory = false
    ORDER BY depth, a.urn`;
  const out: RetrofitRow[] = [];
  for (const a of agents) {
    if (opts.dryRun) {
      const missing: string[] = [];
      for (const n of AGENT_SKELETON) {
        if (await findEffectiveNodeIdByLoc(db, a.memory_id, n.loc)) continue;
        if (await db.node.findFirst({ where: { memoryId: a.memory_id, loc: n.loc }, select: { id: true } })) continue;
        missing.push(n.loc);
      }
      out.push({ agentUrn: a.urn, memoryId: a.memory_id, created: missing });
    } else {
      const created = await db.$transaction((tx) => seedAgentSkeleton(tx, a.memory_id, opts.actor ?? 'system:3833'));
      out.push({ agentUrn: a.urn, memoryId: a.memory_id, created });
    }
  }
  return out;
}
