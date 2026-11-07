/**
 * #3659 (hrn:node:hadronmemory.com:specs:cor:dmo:160:01, ruling 0199): Node.validationTasks, the
 * tasks a content-validation report for a node may name now. It calls the recorder's own
 * {@link judgeValidationTaskSet}, so the read cannot list what the write refuses.
 *
 * The audience is the write's (gate 6703640950, R1). The writer check runs before anything about
 * the node is judged, so a reader who cannot write gets one UNAVAILABLE on every node and learns
 * nothing a manager's config read would show. Task readability is the recorder's per-memory
 * predicate, never the whole-set fold: for a session-bound App key the two differ on PUBLIC
 * knowledge.
 *
 * The author check is deliberately not here. It depends on the revision reported on, not on the
 * node, so the node's author can be listed a task the recorder then refuses for that revision.
 */
import { judgeValidationTaskSet, validationRules, VALIDATION_TASK_SELECT, type ValidationTaskRow, type ValidationTaskSet } from '../../../lib/contentValidationReport.js';
import type { Context } from './resolvers.js';
import { isAuthorizationDenial, isMemoryReadableCached, requireMemoryWriteAccess } from './resolvers.helpers.js';

const UNAVAILABLE: ValidationTaskSet = { state: 'UNAVAILABLE', tasks: [] };

/** Whether this caller may record at all, by the recorder's gates in the recorder's order. */
async function mayRecordIn(ctx: Context, memoryId: string): Promise<boolean> {
  if (ctx.impersonation || ctx.sessionBindingRefused) return false;
  try {
    // The recorder's pre-flight. A pooled decision is honoured only where nothing is written unfenced;
    // this door writes nothing, and without the marker an install memory's writer would read UNAVAILABLE.
    await requireMemoryWriteAccess({ ...ctx, installWritePreflight: true }, memoryId);
    return true;
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    return false;
  }
}

/**
 * One set per node id, read together so a list costs the same as one node. An id is absent from
 * the map when the node is gone or its memory fails the node-content gate: a path wider than that
 * gate (#781) gets nothing derived from the memory's config. `ctx` must carry what the recorder's
 * does (impersonation, the session binding); a context that drops them answers for a writer the
 * recorder would refuse.
 */
export async function validationTaskSetsForNodes(ctx: Context, nodeIds: readonly string[]): Promise<Map<string, ValidationTaskSet>> {
  const out = new Map<string, ValidationTaskSet>();
  const nodes = await ctx.db.node.findMany({
    where: { id: { in: [...new Set(nodeIds)] }, deletedAt: null },
    select: { id: true, memoryId: true, role: true, isRunnable: true },
  });
  const writable = new Map<string, boolean>();
  const readable = new Set<string>();
  for (const memoryId of new Set(nodes.map((n) => n.memoryId))) {
    if (!(await isMemoryReadableCached(ctx, memoryId))) continue;
    readable.add(memoryId);
    writable.set(memoryId, await mayRecordIn(ctx, memoryId));
  }
  const writers = [...writable].filter(([, may]) => may).map(([memoryId]) => memoryId);
  const configs = writers.length === 0 ? [] : await ctx.db.memoryConfig.findMany({
    where: { memoryId: { in: writers } }, include: { rules: true },
  });
  const rulesOf = new Map(configs.map((config) => [config.memoryId, config.rules]));
  const judged = nodes.filter((n) => writable.get(n.memoryId));
  const taskIds = new Set(judged.flatMap((n) => validationRules(n.role, n.isRunnable, rulesOf.get(n.memoryId) ?? [])
    .flatMap((rule) => (rule.validationTaskId ? [rule.validationTaskId] : []))));
  const tasks: readonly ValidationTaskRow[] = taskIds.size === 0 ? [] : await ctx.db.node.findMany({
    where: { id: { in: [...taskIds] } }, select: VALIDATION_TASK_SELECT,
  });
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const node of nodes) {
    if (!readable.has(node.memoryId)) continue;
    if (!writable.get(node.memoryId)) { out.set(node.id, UNAVAILABLE); continue; }
    out.set(node.id, await judgeValidationTaskSet({
      role: node.role, runnable: node.isRunnable, rules: rulesOf.get(node.memoryId) ?? [],
      loadTasks: async (ids) => ids.flatMap((id) => taskById.get(id) ?? []),
      canReadTaskMemory: (taskMemoryId) => isMemoryReadableCached(ctx, taskMemoryId),
    }));
  }
  return out;
}

type Pending = { resolve: (set: ValidationTaskSet | null) => void; reject: (reason: unknown) => void; promise: Promise<ValidationTaskSet | null> };
const batches = new WeakMap<Context, Map<string, Pending>>();

/** Collect sibling Node fields into one {@link validationTaskSetsForNodes} per event-loop turn. */
export function loadValidationTaskSet(ctx: Context, nodeId: string): Promise<ValidationTaskSet | null> {
  let batch = batches.get(ctx);
  if (!batch) {
    const created = new Map<string, Pending>();
    batch = created;
    batches.set(ctx, created);
    setImmediate(() => {
      batches.delete(ctx);
      validationTaskSetsForNodes(ctx, [...created.keys()]).then(
        (sets) => { for (const [id, item] of created) item.resolve(sets.get(id) ?? null); },
        (error: unknown) => { for (const item of created.values()) item.reject(error); },
      );
    });
  }
  const existing = batch.get(nodeId);
  if (existing) return existing.promise;
  let resolve!: Pending['resolve'];
  let reject!: Pending['reject'];
  const promise = new Promise<ValidationTaskSet | null>((res, rej) => { resolve = res; reject = rej; });
  batch.set(nodeId, { resolve, reject, promise });
  return promise;
}
