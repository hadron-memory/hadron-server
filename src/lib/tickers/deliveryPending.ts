/** #2026: optional post-operation self-only metadata. Every refusal/fault/deadline is omission, with no writes. */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { liveReadSnapshotContext } from '../../api/graphql/schema/authorizedTx.js';
import { ownBatchSession } from '../../api/graphql/schema/resolvers.deliveryBatch.js';
import { loadApp } from '../../api/graphql/schema/resolvers.agentTask.js';
import { isRunPrincipal } from '../auth/runPrincipal.js';
import { currentActorAmbiguity } from '../requestActor.js';
import { loadPendingDeliverySummary } from './deliveryBatch.js';
import { createFooterOmissionReporter, footerFailureReason } from './deliveryPendingDiagnostics.js';

const omission = createFooterOmissionReporter();

export type DeliveryPending = { v: 1; count: number; complete: true; asOf: string };
export const DELIVERY_PENDING_BUDGET_MS = 250;

export async function deliveryPending(ctx: Context, namedSession?: string): Promise<DeliveryPending | undefined> {
  // A tool's explicit session is still untrusted here: ownBatchSession validates it inside the bounded snapshot.
  // It answers connection ambiguity only for this footer, without publishing an actor or changing the tool.
  if (namedSession) ctx = { ...ctx, sessionId: namedSession };
  if (!ctx.sessionId || ctx.sessionBindingRefused || ctx.impersonation || isRunPrincipal(ctx) || (!namedSession && currentActorAmbiguity())) return;
  const start = performance.now();
  try {
    // No uncancelled Promise.race: pool acquisition, transaction lifetime and backend statements are bounded.
    const result = await ctx.db.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '180ms'`;
      // Pure metadata is authorized at this coherent snapshot. The database refuses any accidental write;
      // credential refresh and the shared self gate use that same snapshot, without write-door audit paths.
      const txCtx = await liveReadSnapshotContext(ctx, tx);
      const now = new Date();
      const bound = await ownBatchSession(txCtx);
      const app = await loadApp(txCtx, bound.worker.appId);
      if (!app || app.deletedAt || app.uninstalledAt) throw Object.assign(new Error('Unavailable footer App'), { code: 'FOOTER_APP_UNAVAILABLE' });
      const count = await loadPendingDeliverySummary({ ctx: txCtx, app, hostId: null, workerIds: [bound.worker.id], now });
      if (!Number.isSafeInteger(count) || count < 0) throw Object.assign(new Error('Unsafe footer count'), { code: 'FOOTER_UNSAFE_COUNT' });
      return { v: 1 as const, count, complete: true as const, asOf: now.toISOString() };
    }, { isolationLevel: 'RepeatableRead', maxWait: 20, timeout: 210 });
    if (performance.now() - start <= DELIVERY_PENDING_BUDGET_MS) return result;
    omission('deadline');
  } catch (error) { omission(footerFailureReason(error)); }
}

export async function appendDeliveryPending<T>(result: T, ctx: Context, namedSession?: string): Promise<T> {
  if (!result || typeof result !== 'object' || (result as { isError?: boolean }).isError) return result;
  const pending = await deliveryPending(ctx, namedSession);
  if (!pending) return result;
  const r = result as { _meta?: Record<string, unknown>; content?: unknown[] };
  return { ...result, _meta: { ...r._meta, 'hadron/deliveryPending': pending },
    ...(pending.count > 0 && Array.isArray(r.content) ? { content: [...r.content, { type: 'text', text: `${pending.count} ${pending.count === 1 ? 'message' : 'messages'} waiting; pull with hadron_team_chat_inbox.` }] } : {}) };
}
