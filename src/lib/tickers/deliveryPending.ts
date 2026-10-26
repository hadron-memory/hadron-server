/** #2026: optional post-operation self-only metadata. Every refusal/fault/deadline is omission, with no writes. */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { withoutRequestCaches } from '../../api/graphql/schema/resolvers.helpers.js';
import { liveTxContext } from '../../api/graphql/schema/authorizedTx.js';
import { ownBatchSession } from '../../api/graphql/schema/resolvers.deliveryBatch.js';
import { loadApp } from '../../api/graphql/schema/resolvers.agentTask.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../auth/authorityAnchors.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { currentActorAmbiguity } from '../requestActor.js';
import { loadPendingDeliverySummary } from './deliveryBatch.js';

export type DeliveryPending = { v: 1; count: number; complete: true; asOf: string };
export const DELIVERY_PENDING_BUDGET_MS = 250;

export async function deliveryPending(ctx: Context, namedSession?: string): Promise<DeliveryPending | undefined> {
  // A tool's explicit session is still untrusted here: ownBatchSession validates it inside the bounded snapshot.
  // It answers connection ambiguity only for this footer, without publishing an actor or changing the tool.
  if (namedSession) ctx = { ...ctx, sessionId: namedSession };
  if (!ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx) || (!namedSession && currentActorAmbiguity())) return;
  const start = performance.now();
  const now = new Date();
  try {
    // No uncancelled Promise.race: pool acquisition, transaction lifetime and backend statements are bounded.
    const result = await ctx.db.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '180ms'`;
      let txCtx = withoutRequestCaches(ctx, tx);
      const initial = await ownBatchSession(txCtx);
      const app = await loadApp(txCtx, initial.worker.appId);
      if (!app || app.deletedAt || app.uninstalledAt) throw new Error('Unavailable footer App');
      const anchors: AuthorityAnchor[] = [{ kind: 'app', id: app.id },
        ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
        ...[...new Set([app.ownerUserId, ctx.userId].filter((v): v is string => !!v))].map(id => ({ kind: 'user' as const, id }))];
      await lockAuthorityAnchors(tx, anchors, 'shared');
      // Same owner/App -> Worker -> Session row order as the self-batch gate. A stale locking snapshot aborts/omits.
      if (app.organizationId) await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${app.organizationId} FOR SHARE`;
      for (const id of anchors.filter(a => a.kind === 'user').map(a => a.id).sort()) await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM apps WHERE id = ${app.id} FOR SHARE`;
      txCtx = await liveTxContext(ctx, tx);
      const bound = await ownBatchSession(txCtx, app.id, true);
      if (bound.worker.id !== initial.worker.id) throw new Error('Footer binding changed');
      const count = await loadPendingDeliverySummary({ ctx: txCtx, app, hostId: null, workerIds: [bound.worker.id], now });
      await ownBatchSession(txCtx, app.id);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Unsafe footer count');
      return { v: 1 as const, count, complete: true as const, asOf: now.toISOString() };
    }, { isolationLevel: 'RepeatableRead', maxWait: 20, timeout: 210 });
    if (performance.now() - start <= DELIVERY_PENDING_BUDGET_MS) return result;
  } catch { /* A footer never changes the operation's data, errors or outcome. */ }
}

export async function appendDeliveryPending<T>(result: T, ctx: Context, namedSession?: string): Promise<T> {
  if (!result || typeof result !== 'object' || (result as { isError?: boolean }).isError) return result;
  const pending = await deliveryPending(ctx, namedSession);
  if (!pending) return result;
  const r = result as { _meta?: Record<string, unknown>; content?: unknown[] };
  return { ...result, _meta: { ...r._meta, 'hadron/deliveryPending': pending },
    ...(pending.count > 0 && Array.isArray(r.content) ? { content: [...r.content, { type: 'text', text: `${pending.count} messages waiting; pull with hadron_team_chat_inbox.` }] } : {}) };
}
