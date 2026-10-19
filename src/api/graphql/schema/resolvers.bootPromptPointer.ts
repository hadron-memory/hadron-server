/**
 * #2045 (S8, cor:agt:040:07) — the boot-prompt pointer READ fields on Agent,
 * AppAgent and Worker: `bootPromptRef` (the canonical URN of what the pointer
 * names now) and `bootPromptTargetDeleted` (null with no pointer, true when the
 * target is soft- or hard-deleted, false otherwise).
 *
 * Both fields of an owner sit behind ONE exposure gate, the owner's own, and a
 * masked reader sees null in both (6258606109 §5). A deleted target is never a
 * reason to widen it:
 *
 *  - Agent: a caller who may read the Agent's system memory. A PUBLIC Agent's
 *    outsider reaches the Agent object (#551) but not this.
 *  - AppAgent: the App's participants.
 *  - Worker: the worker read gate (`maySeeWorkerInternals`), like the rest of
 *    its working state.
 *
 * Every field derives through `resolveBootPromptPointer`, the seam S10's serve
 * and S11's lint share, so no surface re-derives a pointer.
 */
import type { Context } from './resolvers.helpers.js';
import { isAppParticipant, isMemoryReadableCached, loadApp } from './resolvers.helpers.js';
import { maySeeWorkerInternals } from './resolvers.worker.js';
import {
  resolveBootPromptPointer,
  type ResolvedBootPromptPointer,
  type StoredBootPromptPointer,
} from '../../../lib/bootPromptPointer.js';

type Pointer = Partial<StoredBootPromptPointer>;

/** The parent's stored pair, re-read when a slim select left it out (never treated as "no pointer"). */
async function storedPair(
  parent: Pointer,
  load: () => Promise<StoredBootPromptPointer | null>,
): Promise<StoredBootPromptPointer> {
  if (parent.bootPromptNodeId !== undefined && parent.bootPromptUrn !== undefined) {
    return { bootPromptNodeId: parent.bootPromptNodeId, bootPromptUrn: parent.bootPromptUrn };
  }
  return (await load()) ?? { bootPromptNodeId: null, bootPromptUrn: null };
}

/** Resolve once per stored pointer per request; both fields and every sibling row share it. */
function resolvedFor(ctx: Context, pair: StoredBootPromptPointer): Promise<ResolvedBootPromptPointer | null> {
  if (pair.bootPromptNodeId === null) return Promise.resolve(null);
  const holder = ctx as Context & { bootPromptPointerCache?: Map<string, Promise<ResolvedBootPromptPointer | null>> };
  const cache = (holder.bootPromptPointerCache ??= new Map());
  const key = `${pair.bootPromptNodeId}\u0000${pair.bootPromptUrn ?? ''}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = resolveBootPromptPointer(ctx.db, pair);
    cache.set(key, pending);
  }
  return pending;
}

async function agentPointer(
  a: Pointer & { id: string; systemMemoryId?: string | null },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await storedPair(a, () =>
    ctx.db.agent.findUnique({ where: { id: a.id }, select: { bootPromptNodeId: true, bootPromptUrn: true } }));
  if (row.bootPromptNodeId === null) return null;
  const systemMemoryId = a.systemMemoryId !== undefined
    ? a.systemMemoryId
    : (await ctx.db.agent.findUnique({ where: { id: a.id }, select: { systemMemoryId: true } }))?.systemMemoryId ?? null;
  if (!systemMemoryId || !(await isMemoryReadableCached(ctx, systemMemoryId))) return null;
  return resolvedFor(ctx, row);
}

async function appAgentPointer(
  aa: Pointer & { appId: string; agentId: string },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await storedPair(aa, () => ctx.db.appAgent.findUnique({
    where: { appId_agentId: { appId: aa.appId, agentId: aa.agentId } },
    select: { bootPromptNodeId: true, bootPromptUrn: true },
  }));
  if (row.bootPromptNodeId === null) return null;
  const app = await loadApp(ctx, aa.appId);
  if (!app || app.deletedAt || !(await isAppParticipant(ctx, app))) return null;
  return resolvedFor(ctx, row);
}

async function workerPointer(
  w: Pointer & { id: string; appId: string },
  ctx: Context,
): Promise<ResolvedBootPromptPointer | null> {
  const row = await storedPair(w, () =>
    ctx.db.worker.findUnique({ where: { id: w.id }, select: { bootPromptNodeId: true, bootPromptUrn: true } }));
  if (row.bootPromptNodeId === null) return null;
  if (!(await maySeeWorkerInternals(ctx, w.appId))) return null;
  return resolvedFor(ctx, row);
}

const fields = <P>(pointer: (parent: P, ctx: Context) => Promise<ResolvedBootPromptPointer | null>) => ({
  bootPromptRef: async (parent: P, _: unknown, ctx: Context) => (await pointer(parent, ctx))?.urn ?? null,
  bootPromptTargetDeleted: async (parent: P, _: unknown, ctx: Context) => (await pointer(parent, ctx))?.deleted ?? null,
});

export const bootPromptPointerFieldResolvers = {
  Agent: fields(agentPointer),
  AppAgent: fields(appAgentPointer),
  Worker: fields(workerPointer),
};
