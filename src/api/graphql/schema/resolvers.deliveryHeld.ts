/** #2021 / cor:agt:050:26: authenticated hold observations, never an acknowledgement or caller-reported resume. */
import { Prisma } from '../../../generated/prisma/index.js';
import { type Context } from './resolvers.helpers.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { taskError } from './resolvers.agentTask.js';
import { batchKeyEntry, ownBatchSession } from './resolvers.deliveryBatch.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { keyHostId, recordHostKeyUse } from '../../../lib/hostOperations/hostKey.js';
import { verifyBatchProof, sameBatchRequester, WAKE_PROOF_MAX_AGE_MS, MAX_PROOF_CHARS } from '../../../lib/tickers/wakeProof.js';
import { loadDeliveryEligibility } from '../../../lib/tickers/deliveryBatch.js';
import { lockDeliveryState } from '../../../lib/tickers/deliveryState.js';
import { recordDeliveryHold, DELIVERY_HOLD_REASONS, type DeliveryHoldReason, type DeliveryHoldPrincipal } from '../../../lib/tickers/deliveryHolds.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';

const bad = (): never => { throw taskError('BAD_USER_INPUT', 'Invalid delivery hold report.'); };
const mismatch = (): never => { throw taskError('WAKE_PROOF_REQUESTER_MISMATCH', 'This delivery batch was issued to someone else.'); };
const stale = (): never => { throw taskError('WAKE_PROOF_STALE', 'This delivery batch is no longer current. Read the batch again.'); };

/** Strict allowlist before any logging or metadata write; errors never echo input values. */
function parse(input: unknown): { batchId: string; reason: DeliveryHoldReason; terminalId: string | null } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad();
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some(k => !['batchId', 'reason', 'terminalId'].includes(k)) || typeof row.batchId !== 'string' ||
      row.batchId.length > MAX_PROOF_CHARS || typeof row.reason !== 'string' || !(DELIVERY_HOLD_REASONS as readonly string[]).includes(row.reason) ||
      (row.terminalId != null && (typeof row.terminalId !== 'string' || !/^term_[A-Za-z0-9_-]{1,128}$/.test(row.terminalId)))) return bad();
  return { batchId: row.batchId, reason: row.reason as DeliveryHoldReason, terminalId: row.terminalId as string | null ?? null };
}

export const deliveryHeldMutations = {
  reportDeliveryHold: async (_: unknown, a: { input: unknown }, ctx: Context) => {
    const input = parse(a.input);
    const proof = verifyBatchProof(input.batchId);
    const key = appKeyCaller(ctx);
    if (ctx.sessionBindingRefused && !key) throw taskError('SESSION_NOT_LIVE', 'The named session is not live or cannot bind.');
    const selfMode = ctx.sessionId && (!key || !(await keyHostId(ctx.db, key)));
    const own = selfMode ? await ownBatchSession(ctx) : null;
    if (own) {
      if (!sameBatchRequester(proof, { sessionId: own.session.id }) || proof.hostId !== null ||
          proof.workerId !== own.worker.id || proof.appId !== own.session.appId) mismatch();
    } else if (!key || !sameBatchRequester(proof, { appKeyId: key.appKeyId }) || proof.appId !== key.appId || proof.hostId === null) mismatch();
    // Entry is re-run inside the transaction too. The host identity is never a supplied worker/host field.
    const hostEntry = own ? null : await batchKeyEntry(ctx, proof.appId);
    if (hostEntry && proof.hostId !== hostEntry.host.hostId) mismatch();
    const appScope = hostEntry?.app ?? await ctx.db.app.findUnique({ where: { id: proof.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
    if (!appScope) stale();
    const subject = await ctx.db.worker.findUnique({ where: { id: proof.workerId }, select: { heldByUserId: true } });
    const channels = await ctx.db.channel.findMany({ where: { id: { in: proof.channels.map(c => c.channelId) } },
      select: { id: true, memoryId: true, memory: { select: { organizationId: true, ownerUserId: true, userId: true } } } });
    const anchors: AuthorityAnchor[] = [
      { kind: 'app', id: proof.appId },
      ...(appScope!.organizationId ? [{ kind: 'org' as const, id: appScope!.organizationId }] : []),
      ...(appScope!.ownerUserId ? [{ kind: 'user' as const, id: appScope!.ownerUserId }] : []),
      ...[ctx.userId, subject?.heldByUserId].filter((id): id is string => !!id).map(id => ({ kind: 'user' as const, id })),
      ...channels.flatMap(c => [{ kind: 'memory' as const, id: c.memoryId },
        ...(c.memory.organizationId ? [{ kind: 'org' as const, id: c.memory.organizationId }] : []),
        ...[c.memory.ownerUserId, c.memory.userId].filter((id): id is string => !!id).map(id => ({ kind: 'user' as const, id }))]),
    ];
    return withAuthorizedTx(ctx, anchors, async () => undefined, async (tx, txCtx) => {
      // The shared wrapper fences authority AND owner/memory rows before graph/budget/worker locks.
      const currentApp = await tx.app.findUnique({ where: { id: proof.appId }, select: { organizationId: true, ownerUserId: true } });
      if (!currentApp || currentApp.organizationId !== appScope!.organizationId || currentApp.ownerUserId !== appScope!.ownerUserId) mismatch();
      await lockDeliveryState(tx, proof.appId, proof.workerId);
      // Keep Worker -> Session row order, after authority / budget / wake locks.
      await tx.$queryRaw`SELECT id FROM workers WHERE id = ${proof.workerId} FOR SHARE`;
      const worker = await tx.worker.findUnique({ where: { id: proof.workerId }, select: { heldByUserId: true } });
      if (worker?.heldByUserId !== subject?.heldByUserId) mismatch();
      const self = own ? await ownBatchSession(txCtx, proof.appId, true) : null;
      const entry = own ? null : await batchKeyEntry(txCtx, proof.appId);
      if (self && (self.session.id !== own!.session.id || self.worker.id !== proof.workerId)) mismatch();
      if (entry) {
        if (entry.host.hostId !== proof.hostId) mismatch();
        await entry.authorize(tx);
        const registered = await tx.hostRegistrationWorker.findFirst({ where: { workerId: proof.workerId,
          registration: { appId: proof.appId, hostId: entry.host.hostId, lostAt: null } }, select: { workerId: true } });
        if (!registered) mismatch();
      }
      const app = entry?.app ?? await tx.app.findUniqueOrThrow({ where: { id: proof.appId } });
      const eligible = await loadDeliveryEligibility({ ctx: txCtx, app, hostId: entry?.host.hostId ?? null, workerIds: [proof.workerId], first: 1 });
      const selected = eligible.workers.find(w => w.workerId === proof.workerId) ?? mismatch();
      for (const c of proof.channels) {
        const channel = selected.channels.find(x => x.channelId === c.channelId);
        const current = await tx.channel.findUnique({ where: { id: c.channelId }, select: { memoryId: true, memory: { select: { organizationId: true, ownerUserId: true, userId: true } } } });
        if (current && JSON.stringify(current.memory) !== JSON.stringify(channels.find(x => x.id === c.channelId)?.memory)) mismatch();
        if (!channel || channel.incarnation !== c.incarnation || current?.memoryId !== channels.find(x => x.id === c.channelId)?.memoryId) stale();
        const remaining = await tx.$queryRaw<Array<{ seq: number }>>(Prisma.sql`
          SELECT n.seq::int AS seq FROM nodes n WHERE ${channel!.predicate} AND n.seq IN (${Prisma.join(c.seqs)})`);
        if (remaining.length !== c.seqs.length) stale();
      }
      // Fresh deciding time AFTER every lock wait and eligibility check. No grace for a future-issued descriptor.
      const now = new Date();
      if (!Number.isFinite(proof.issuedAt) || proof.issuedAt > now.getTime() || now.getTime() - proof.issuedAt > WAKE_PROOF_MAX_AGE_MS) stale();
      if (own) await ownBatchSession(txCtx, proof.appId);
      if (entry) await entry.authorize(tx);
      const principal: DeliveryHoldPrincipal = self
        ? { kind: 'worker', workerId: self.worker.id, sessionId: self.session.id }
        : { kind: 'host-key', appKeyId: entry!.host.appKeyId, hostId: entry!.host.hostId };
      const holds = [];
      // A verified proof carries <=10 rendered seqs, hence <=10 channels. All mutate or none; no truncation.
      for (const c of proof.channels) {
        const { principal: _privatePrincipal, ...hold } = await recordDeliveryHold(tx, { workerId: proof.workerId,
          channelId: c.channelId, channelIncarnation: c.incarnation, firstPendingSeq: c.seqs[0]!,
          reason: input.reason, terminalId: input.terminalId, principal, now });
        holds.push(hold);
      }
      if (entry) await recordHostKeyUse(tx, entry.host, 'deliver', { count: holds.length });
      return { workerId: proof.workerId, holds, pageInfo: { hasNextPage: false, endCursor: null } };
    }, { timeout: 30_000 }).catch((error: unknown) => {
      // Only the common transaction's typed stale-authority refusals are translated.
      // Database outages and persistence failures must still fail the whole report.
      if (error instanceof Error && error.message === 'DELIVERY_WORKER_NOT_FOUND') stale();
      if (error instanceof Error && error.message === 'DELIVERY_AUTHORITY_CHANGED') mismatch();
      throw error;
    });
  },
};
