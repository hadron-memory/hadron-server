/**
 * #4414 (#4360 S5), cor:agt:050:30 r15: the role tasks (runnable instruction nodes) an assignee followed, recorded on
 * the finished result as `workedFromRoleTaskRefs`. Mirrors `finishFindings`: optional, judged BEFORE any write, kept as
 * `{nodeId, urn, revision}` in the order given, immutable with the rest of the result (the database guard in
 * prisma/agent-task-role-task-refs-invariants.sql).
 *
 * Each reference is an id or a URN and must be a live, runnable node whose memory the caller may read, by the SAME
 * gate a node read uses (`resolveNodeRefForCaller` + `isMemoryReadableCached`); this adds no gate of its own. A node
 * the caller may not read and a node that does not exist are one answer, byte for byte (no existence oracle), and the
 * refusal names no reference. Duplicates are judged after resolving, so an id and a URN of one node count once.
 */
import { GraphQLError } from 'graphql';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { isMemoryReadableCached } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolveNodeRefForCaller } from '../../api/graphql/schema/resolvers.nodeRefAccess.js';
import { EntityNotFoundError } from '../entityRef/entityNotFound.js';
import { AmbiguousLegacyUrnError } from '../entityRef/errors.js';
import { UrnNotQualifiedError, UrnParseError } from '../urn.js';
import { safeNodeUrnV2 } from '../urnEmit.js';

/** The most role tasks one finish may name (cor:agt:050:30, Proposed: Holger to confirm). */
export const ROLE_TASK_REFS_MAX = 10;
export type StoredRoleTaskRef = { nodeId: string; urn: string; revision: number };

const invalid = () => new GraphQLError(
  `Invalid workedFromRoleTaskRefs: give at most ${ROLE_TASK_REFS_MAX} distinct runnable nodes you may read, by id or URN.`,
  { extensions: { code: 'TASK_ROLE_TASK_REFS_INVALID' } },
);

/**
 * Resolve and check `input`. `undefined` means the finish carries none (omitted or null: stored as NULL, the legacy
 * shape). Throws TASK_ROLE_TASK_REFS_INVALID, writing nothing, on any failure. `ctx` is the finishing transaction's
 * context, so every read sees the state the finish commits against.
 */
export async function finishRoleTaskRefs(ctx: Context, input: unknown): Promise<StoredRoleTaskRef[] | undefined> {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length > ROLE_TASK_REFS_MAX) throw invalid();
  const stored: StoredRoleTaskRef[] = [];
  const seen = new Set<string>();
  for (const ref of input) {
    if (typeof ref !== 'string' || ref.trim() === '') throw invalid();
    let id: string;
    try {
      id = (await resolveNodeRefForCaller(ctx, ref)).id;
    } catch (e) {
      // Only "no such node / not a usable address": a database fault must surface as itself, not as a bad reference.
      if (e instanceof EntityNotFoundError || e instanceof AmbiguousLegacyUrnError
        || e instanceof UrnNotQualifiedError || e instanceof UrnParseError) throw invalid();
      throw e;
    }
    if (seen.has(id)) throw invalid();
    seen.add(id);
    const node = await ctx.db.node.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, loc: true, revSeq: true, isRunnable: true, memoryId: true, memory: { select: { urn: true, deletedAt: true } } },
    });
    if (!node || node.memory.deletedAt || node.isRunnable !== true) throw invalid();
    if (!(await isMemoryReadableCached(ctx, node.memoryId))) throw invalid();
    stored.push({ nodeId: node.id, urn: safeNodeUrnV2(node.memory.urn, node.loc), revision: node.revSeq });
  }
  return stored;
}
