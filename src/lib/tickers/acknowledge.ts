// acknowledgeWakes — #1748, cor:agt:080:16/:17 (plan §4.3, R4).
//
// The router delivers a nudge, then hands back the wake proof. In ONE
// transaction this raises deliveredThroughSeq (monotonic: GREATEST), records
// each ticker's tick, records who acknowledged, and counts the wake against the
// App's daily budget unless the proof says it was exempt (releasing the
// reservation dueWakes made for it). A repeat changes nothing. It NEVER touches
// ChannelReadState: delivery and reading are different facts.
//
// Refusals: an unknown version, a forged signature or an attention token →
// WAKE_PROOF_INVALID; a proof issued to somebody else → WAKE_PROOF_REQUESTER_MISMATCH;
// older than 15 minutes, or a channel recreated since issue → WAKE_PROOF_STALE
// (the wake stays due; the router asks again). Nothing is written unless every
// proof in the call passes.

import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { currentActor } from '../requestActor.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { sameRequester, verifyWakeProof, WAKE_PROOF_MAX_AGE_MS, type WakeProof, type WakeRequester } from './wakeProof.js';

export const ACK_MAX_PROOFS = 200;

const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): never => {
  throw new GraphQLError(message, { extensions: { code, ...extra } });
};

export type AcknowledgeResult = { acknowledged: number; unchanged: number };

export async function acknowledgeWakes(args: {
  ctx: Context;
  requester: WakeRequester;
  proofs: string[];
  /**
   * Decides, per proof and INSIDE the acknowledgement's transaction (after the
   * worker's wake lock), that the requester may still read this worker's wakes.
   * It must hold what it reads (the holder's row, the caller's memberships), so a
   * release or demotion cannot commit between the check and the write.
   */
  mayReadWorker: (proof: WakeProof, tx: Prisma.TransactionClient) => Promise<boolean>;
  now?: Date;
}): Promise<AcknowledgeResult> {
  const { ctx, requester } = args;
  const now = args.now ?? new Date();
  if (args.proofs.length === 0) return { acknowledged: 0, unchanged: 0 };
  if (args.proofs.length > ACK_MAX_PROOFS) {
    refuse('BAD_USER_INPUT', `Acknowledge at most ${ACK_MAX_PROOFS} wakes at a time.`);
  }
  const proofs = args.proofs.map((p) => verifyWakeProof(p));
  for (const p of proofs) {
    if (!sameRequester(p, requester)) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
    if (now.getTime() - p.issuedAt > WAKE_PROOF_MAX_AGE_MS || p.issuedAt > now.getTime() + 60_000) {
      refuse('WAKE_PROOF_STALE', 'This wake proof is too old. Ask for the due wakes again.');
    }
  }

  // Naive-UTC literals: Prisma binds a JS Date as timestamptz but these columns are timestamp WITHOUT time zone
  // (findings:prisma-naive-timestamp-raw-sql).
  const nowNaive = toNaiveUtc(now);
  const by = currentActor();
  const ackedBy = {
    ackedByUserId: 'userId' in requester ? requester.userId : null,
    ackedByWorkerId: by.workerId ?? null,
    ackedByAppKeyId: 'appKeyId' in requester ? requester.appKeyId : null,
  };

  return ctx.db.$transaction(async (tx) => {
    let acknowledged = 0;
    let unchanged = 0;
    // A stable order, so two acknowledgements of overlapping workers cannot deadlock on the per-worker locks.
    for (const p of [...proofs].sort((a, b) => a.workerId.localeCompare(b.workerId))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + p.workerId}, 0))`;
      if (!(await args.mayReadWorker(p, tx))) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
      const worker = await tx.worker.findUnique({ where: { id: p.workerId }, select: { appId: true, retiredAt: true } });
      if (!worker || worker.appId !== p.appId || worker.retiredAt) refuse('WAKE_PROOF_STALE', 'The worker of this wake is gone.');

      // A channel recreated since issue (or deleted) invalidates the proof: its seqs restarted.
      const live = p.channels.length === 0 ? [] : await tx.channel.findMany({
        where: { id: { in: p.channels.map((c) => c.channelId) }, deletedAt: null },
        select: { id: true, incarnation: true },
      });
      for (const c of p.channels) {
        const cur = live.find((l) => l.id === c.channelId);
        if (!cur || cur.incarnation !== c.incarnation) refuse('WAKE_PROOF_STALE', 'A channel of this wake was recreated since it was issued.');
      }

      let advanced = false;
      for (const c of p.channels) {
        const row = await tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: p.workerId, channelId: c.channelId } } });
        if (!row || row.channelIncarnation !== c.incarnation || c.through > row.deliveredThroughSeq) advanced = true;
        // GREATEST: delivered-through only rises, unless the channel was recreated (then it restarts).
        await tx.$executeRaw`
          INSERT INTO worker_delivery_channels
            (worker_id, channel_id, channel_incarnation, delivered_through_seq, delivered_at,
             acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
          VALUES (${p.workerId}, ${c.channelId}, ${c.incarnation}, ${c.through}, ${nowNaive}::timestamp,
                  ${ackedBy.ackedByUserId}, ${ackedBy.ackedByWorkerId}, ${ackedBy.ackedByAppKeyId})
          ON CONFLICT (worker_id, channel_id) DO UPDATE SET
            delivered_through_seq = CASE WHEN worker_delivery_channels.channel_incarnation = EXCLUDED.channel_incarnation
                                         THEN GREATEST(worker_delivery_channels.delivered_through_seq, EXCLUDED.delivered_through_seq)
                                         ELSE EXCLUDED.delivered_through_seq END,
            -- A repeat of what is already delivered changes NOTHING, neither the ceiling's clock nor who delivered it (Diego P2-3).
            delivered_at = CASE WHEN worker_delivery_channels.channel_incarnation <> EXCLUDED.channel_incarnation
                                  OR EXCLUDED.delivered_through_seq > worker_delivery_channels.delivered_through_seq
                                THEN EXCLUDED.delivered_at ELSE worker_delivery_channels.delivered_at END,
            acked_by_user_id = CASE WHEN worker_delivery_channels.channel_incarnation <> EXCLUDED.channel_incarnation
                                      OR EXCLUDED.delivered_through_seq > worker_delivery_channels.delivered_through_seq
                                    THEN EXCLUDED.acked_by_user_id ELSE worker_delivery_channels.acked_by_user_id END,
            acked_by_worker_id = CASE WHEN worker_delivery_channels.channel_incarnation <> EXCLUDED.channel_incarnation
                                        OR EXCLUDED.delivered_through_seq > worker_delivery_channels.delivered_through_seq
                                      THEN EXCLUDED.acked_by_worker_id ELSE worker_delivery_channels.acked_by_worker_id END,
            acked_by_app_key_id = CASE WHEN worker_delivery_channels.channel_incarnation <> EXCLUDED.channel_incarnation
                                         OR EXCLUDED.delivered_through_seq > worker_delivery_channels.delivered_through_seq
                                       THEN EXCLUDED.acked_by_app_key_id ELSE worker_delivery_channels.acked_by_app_key_id END,
            channel_incarnation = EXCLUDED.channel_incarnation`;
      }
      for (const t of p.ticks) {
        const row = await tx.workerDeliveryTick.findUnique({ where: { workerId_tickerId: { workerId: p.workerId, tickerId: t.tickerId } } });
        if (!row || t.k > row.lastAckedTick) advanced = true;
        const ticker = await tx.ticker.findUnique({ where: { id: t.tickerId }, select: { appId: true } });
        if (!ticker || ticker.appId !== p.appId) continue; // a deleted ticker's tick records nothing
        await tx.$executeRaw`
          INSERT INTO worker_delivery_ticks
            (worker_id, ticker_id, last_acked_tick, acked_at, acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
          VALUES (${p.workerId}, ${t.tickerId}, ${t.k}, ${nowNaive}::timestamp,
                  ${ackedBy.ackedByUserId}, ${ackedBy.ackedByWorkerId}, ${ackedBy.ackedByAppKeyId})
          ON CONFLICT (worker_id, ticker_id) DO UPDATE SET
            last_acked_tick = GREATEST(worker_delivery_ticks.last_acked_tick, EXCLUDED.last_acked_tick),
            acked_at = CASE WHEN EXCLUDED.last_acked_tick > worker_delivery_ticks.last_acked_tick THEN EXCLUDED.acked_at ELSE worker_delivery_ticks.acked_at END,
            acked_by_user_id = CASE WHEN EXCLUDED.last_acked_tick > worker_delivery_ticks.last_acked_tick THEN EXCLUDED.acked_by_user_id ELSE worker_delivery_ticks.acked_by_user_id END,
            acked_by_worker_id = CASE WHEN EXCLUDED.last_acked_tick > worker_delivery_ticks.last_acked_tick THEN EXCLUDED.acked_by_worker_id ELSE worker_delivery_ticks.acked_by_worker_id END,
            acked_by_app_key_id = CASE WHEN EXCLUDED.last_acked_tick > worker_delivery_ticks.last_acked_tick THEN EXCLUDED.acked_by_app_key_id ELSE worker_delivery_ticks.acked_by_app_key_id END`;
      }
      // The reservation this wake held (dueWakes) is spent or void either way.
      await tx.$executeRaw`DELETE FROM app_wake_reservations WHERE worker_id = ${p.workerId}`;
      // Counted against the day's budget only when it moved something: a repeat acknowledgement is not another wake.
      if (!advanced) { unchanged++; continue; }
      acknowledged++;
      if (!p.exempt) {
        const dayText = now.toISOString().slice(0, 10);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO app_wake_days (app_id, day, wakes) VALUES (${p.appId}, ${dayText}::date, 1)
          ON CONFLICT (app_id, day) DO UPDATE SET wakes = app_wake_days.wakes + 1`);
      }
    }
    return { acknowledged, unchanged };
  });
}
