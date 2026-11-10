/**
 * #3789 (Grants S2a-read): `grant(ref:)` and `grants`. Read only, and only by a BOUND WORKER SESSION in its own App. The row
 * scope lives in src/lib/grants/read.ts (to be shared with the run tool of #3710, which does not exist yet); this file is the CALLER gate, and a failed gate is an
 * empty page / null, never an error, so it discloses nothing and answers exactly as a missing row does.
 * No MCP tool: Holger's rule (2026-10-31), "Agents: yes, Workers: no". No writer exists on any surface.
 */
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { getGrantForWorker, listGrantsForWorker, type GrantReader } from '../../../lib/grants/read.js';
import { currentActor } from '../../../lib/requestActor.js';
import { loadGrantSignatureStatuses, type GrantSignatureStatusView, type GrantSignatureView } from '../../../lib/signing/grantStatus.js';
import { clampListTake, type Context } from './resolvers.helpers.js';
import { loadApp, resolveTaskActor } from './resolvers.agentTask.js';
import { resolveRevisionEditor } from './resolvers.types.js';

/**
 * The worker this request is, in the App that worker belongs to, or null. A worker session driven by a person: not an App
 * key, not a run (a run carries an App and maybe a user but is not a session), not an impersonated session, and the worker
 * is live (not retired) in a live App the person can still drive (`resolveTaskActor`, the one gate every worker read shares).
 */
export async function resolveGrantReader(ctx: Context): Promise<GrantReader | null> {
  const bound = currentActor();
  if (!bound.workerId || !ctx.userId) return null;
  if (ctx.impersonation || appKeyCaller(ctx) || isRunPrincipal(ctx)) return null;
  const worker = await ctx.db.worker.findUnique({ where: { id: bound.workerId }, select: { appId: true } });
  if (!worker) return null;
  const app = await loadApp(ctx, worker.appId);
  if (!app) return null;
  const actor = await resolveTaskActor(ctx, app);
  if (!actor || actor.kind !== 'worker' || actor.workerId !== bound.workerId) return null;
  return { appId: app.id, workerId: bound.workerId };
}

export const grantQueries = {
  grant: async (_p: unknown, { ref }: { ref: string }, ctx: Context) => {
    const reader = await resolveGrantReader(ctx);
    return reader ? getGrantForWorker(ctx.db, reader, ref) : null;
  },
  grants: async (_p: unknown, { limit, offset }: { limit?: number | null; offset?: number | null }, ctx: Context) => {
    const reader = await resolveGrantReader(ctx);
    if (!reader) return { items: [], total: 0 };
    return listGrantsForWorker(ctx.db, reader, { take: clampListTake(limit), skip: Math.max(0, offset ?? 0) });
  },
};

type StatusBatch = { pending: Map<string, Array<(v: GrantSignatureStatusView) => void>>; failures: Array<(e: unknown) => void> };
const statusBatches = new WeakMap<Context, StatusBatch>();

/**
 * #3649 slice D — the signatureStatus of every grant resolved in one tick of a request shares ONE load (the
 * Node.signatureStatus batch pattern, #1632), so a `grants` page pays per page, not per row. The parent grant was already
 * authorized by `grant(ref:)` / `grants`, the only reads that return a Grant; this field adds no reach.
 */
function loadGrantSignatureStatus(ctx: Context, grantId: string): Promise<GrantSignatureStatusView> {
  let batch = statusBatches.get(ctx);
  if (!batch) {
    const fresh: StatusBatch = { pending: new Map(), failures: [] };
    batch = fresh;
    statusBatches.set(ctx, fresh);
    setImmediate(() => {
      statusBatches.delete(ctx);
      void (async () => {
        try {
          const statuses = await loadGrantSignatureStatuses(ctx.db, [...fresh.pending.keys()]);
          for (const [id, waiters] of fresh.pending) for (const resolve of waiters) resolve(statuses.get(id)!);
        } catch (error) {
          for (const reject of fresh.failures) reject(error);
        }
      })();
    });
  }
  const target = batch;
  return new Promise((resolve, reject) => {
    const waiters = target.pending.get(grantId) ?? [];
    waiters.push(resolve);
    target.pending.set(grantId, waiters);
    target.failures.push(reject);
  });
}

export const grantFieldResolvers = {
  Grant: {
    /** #3649 slice D (cor:acl:140:07): the grant's signatures, re-verified on this read. */
    signatureStatus: (g: { id: string }, _: unknown, ctx: Context) => loadGrantSignatureStatus(ctx, g.id),
  },
  GrantSignature: {
    /** cor:acl:140:08: a live person as handle and URN; an erased signer reads null (a deleted user). The sealed id is never echoed. */
    signer: (s: GrantSignatureView, _: unknown, ctx: Context) => resolveRevisionEditor(ctx, [s.signerId]),
  },
};
