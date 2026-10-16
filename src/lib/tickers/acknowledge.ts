// acknowledgeWakes — #1748, cor:agt:080:16/:17 (plan §4.3, R4).
//
// The router delivers a nudge, then hands back the wake proof. In ONE
// transaction this raises deliveredThroughSeq (monotonic: GREATEST), records
// each ticker's tick, records who acknowledged, and counts the wake against the
// App's daily budget unless the proof says it was exempt (releasing the
// reservation dueWakes made for it). A repeat changes nothing. It NEVER touches
// ChannelReadState: delivery and reading are different facts.
//
// #1708 (T5): a v2 proof also names task events. Each is recorded delivered on
// (worker, event, chain position), once. That is a receipt, NEVER an alarm
// acknowledgement (cor:agt:050:20): nothing here touches the alarm row, so a
// delivery cannot silently stop an escalation. An event of another App is
// skipped, like a deleted ticker's tick.
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
import { withAuthorizedTx } from '../../api/graphql/schema/authorizedTx.js';
import type { AuthorityAnchor } from '../auth/authorityAnchors.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { sameRequester, verifyWakeProof, wakeIdentity, WAKE_PROOF_MAX_AGE_MS, type WakeProof, type WakeRequester } from './wakeProof.js';

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
   * `txCtx` carries the caller's platform roles re-read under the authority anchors,
   * and the App, its org and its owner are anchored for the whole transaction, so a
   * demotion, an uninstall or an ownership change either commits first or waits.
   * It must hold the rows it reads (the holder's row, the caller's memberships).
   */
  mayReadWorker: (proof: WakeProof, tx: Prisma.TransactionClient, txCtx: Context) => Promise<boolean>;
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

  // The authority the acknowledgement rests on, anchored BEFORE any row or advisory lock (Diego cycle 2, P2-1): every
  // App in the batch, its org and its owner. Revokers of that authority take the same anchors exclusively.
  const appIds = [...new Set(proofs.map((p) => p.appId))].sort();
  const apps = await ctx.db.app.findMany({ where: { id: { in: appIds } }, select: { id: true, organizationId: true, ownerUserId: true } });
  const anchors: AuthorityAnchor[] = apps.flatMap((a) => [
    { kind: 'app' as const, id: a.id },
    ...(a.organizationId ? [{ kind: 'org' as const, id: a.organizationId }] : []),
    ...(a.ownerUserId ? [{ kind: 'user' as const, id: a.ownerUserId }] : []),
  ]);

  try {
    return await withAuthorizedTx(ctx, anchors, async () => undefined, (tx, txCtx) => writeAcks(tx, txCtx));
  } catch (e) {
    // An App uninstalled or deleted, or a user gone, under the anchors: nobody may acknowledge for it.
    if (e instanceof Error && e.message === 'Forbidden') refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
    throw e;
  }

  async function writeAcks(tx: Prisma.TransactionClient, txCtx: Context): Promise<AcknowledgeResult> {
    let acknowledged = 0;
    let unchanged = 0;
    // One order for every lock below, across every caller: the Apps' budget locks (the same lock `dueWakes` issues
    // under, so a reservation becomes a spent wake atomically with respect to issuance), then the per-worker wake
    // locks by worker id. Two acknowledgements, or an acknowledgement and an issue, can then never wait in a cycle.
    for (const appId of appIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + appId}, 0))`;
    for (const p of [...proofs].sort((a, b) => a.workerId.localeCompare(b.workerId))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + p.workerId}, 0))`;
      if (!(await args.mayReadWorker(p, tx, txCtx))) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
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
      for (const t of p.tasks) {
        const ev = await tx.agentTeamEvent.findUnique({ where: { id: t.eventId }, select: { appId: true } });
        if (!ev || ev.appId !== p.appId) continue; // a forged or foreign event records nothing
        // Delivered once: a repeat moves nothing, neither the time nor who acknowledged it (cf. Diego P2-3 above).
        const moved = await tx.$executeRaw`
          INSERT INTO worker_delivery_task_events
            (worker_id, event_id, chain_index, delivered_at, acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
          VALUES (${p.workerId}, ${t.eventId}, ${t.chainIndex}, ${nowNaive}::timestamp,
                  ${ackedBy.ackedByUserId}, ${ackedBy.ackedByWorkerId}, ${ackedBy.ackedByAppKeyId})
          ON CONFLICT (worker_id, event_id, chain_index) DO UPDATE SET
            delivered_at = EXCLUDED.delivered_at,
            acked_by_user_id = EXCLUDED.acked_by_user_id,
            acked_by_worker_id = EXCLUDED.acked_by_worker_id,
            acked_by_app_key_id = EXCLUDED.acked_by_app_key_id
          WHERE worker_delivery_task_events.delivered_at IS NULL`;
        if (moved > 0) advanced = true;
      }
      // Only the reservation of THIS wake is spent or void: the one carrying this proof's wake key. A re-read of an
      // unchanged wake shares the key, so it is freed whichever proof is acknowledged; a replay of an old, unchanged
      // proof matches nothing newer, so it can never cancel the allowance of a wake issued after it (Diego cycle 2, P2-3).
      await tx.$executeRaw(Prisma.sql`DELETE FROM app_wake_reservations WHERE worker_id = ${p.workerId} AND wake_key = ${wakeIdentity(p)}`);
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
  }
}
