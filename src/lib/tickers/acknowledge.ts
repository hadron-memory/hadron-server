// acknowledgeWakes — #1748, cor:agt:080:16/:17 (plan §4.3, R4).
//
// The router delivers a nudge, then hands back the wake proof. In ONE
// transaction this records each ticker's tick, records who acknowledged, and
// counts the wake against the
// App's daily budget unless the proof says it was exempt (releasing the
// reservation dueWakes made for it). A repeat changes nothing. It NEVER touches
// ChannelReadState: delivery and reading are different facts.
//
// #2072 (Holger R53 / A′, cor:agt:080:04/:16): a wake carries no message text, so acknowledging it moves NO message
// mark, neither delivered-through nor the read position, whatever the proof's version. Only an S1 text batch
// (acknowledgeBatchProofs) or the worker's own read moves them. A v1/v2 proof that still names channel ranges is
// validated as before (a recreated channel is stale) and its ranges are otherwise ignored; its reservation key is
// still derived from them, so it spends the reservation it was issued against.
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
import { raiseDeliveryMark, raiseReadIfMentionOnly, type AckedBy } from '../workerMarks.js';
import {
  proofWakeKey, sameBatchRequester, sameRequester, verifyBatchProof, verifyWakeProof, WAKE_PROOF_MAX_AGE_MS,
  type BatchProof, type BatchRequester, type WakeProof, type WakeRequester,
} from './wakeProof.js';

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
  /** App-key scope locks for the complete batch, before any per-worker lock. */
  prepareWorkers?: (tx: Prisma.TransactionClient, proofs: readonly WakeProof[]) => Promise<void>;
  now?: Date;
}): Promise<AcknowledgeResult> {
  const { ctx, requester } = args;
  const now = args.now ?? new Date();
  const entered = performance.now();
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
  const ackedBy: AckedBy = {
    ackedByUserId: 'userId' in requester ? requester.userId : null,
    ackedByWorkerId: by.workerId ?? null,
    ackedByAppKeyId: 'appKeyId' in requester ? requester.appKeyId : null,
  };

  const appIds = [...new Set(proofs.map((p) => p.appId))].sort();
  const anchors = await authorityAnchorsOf(ctx, appIds);

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
    await args.prepareWorkers?.(tx, proofs);
    for (const p of [...proofs].sort((a, b) => a.workerId.localeCompare(b.workerId))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + p.workerId}, 0))`;
      if (!(await args.mayReadWorker(p, tx, txCtx))) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This wake proof was issued to someone else.');
      const worker = await tx.worker.findUnique({ where: { id: p.workerId }, select: { appId: true, retiredAt: true } });
      if (!worker || worker.appId !== p.appId || worker.retiredAt) refuse('WAKE_PROOF_STALE', 'The worker of this wake is gone.');
      // #2102 (Dara P2-3, cor:agt:080:17): fresh at the write, not only at entry: the locks and the gate above may wait.
      if (!freshAfterWait(now, entered, p.issuedAt)) refuse('WAKE_PROOF_STALE', 'This wake proof is too old. Ask for the due wakes again.');

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
      // #2072 (R53): the wake's receipt, which is what a textless acknowledgement records (cor:agt:080:04): the floor's
      // clock (080:13) and the once-per-wake budget test (080:15). Written only when no receipt of this key was recorded
      // at or after this proof's issue: a repeat, or an older proof's replay, changes nothing (Diego P2-3), while the
      // same wake offered again after the floor (a fresh issue) is a new delivery, floored and charged again (Vera, #2072).
      const issuedNaive = toNaiveUtc(new Date(p.issuedAt));
      const delivered = (await tx.$executeRaw`
        INSERT INTO worker_wake_acks (worker_id, wake_key, acked_at, acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
        VALUES (${p.workerId}, ${proofWakeKey(p)}, ${nowNaive}::timestamp,
                ${ackedBy.ackedByUserId}, ${ackedBy.ackedByWorkerId}, ${ackedBy.ackedByAppKeyId})
        ON CONFLICT (worker_id, wake_key) DO UPDATE SET
          acked_at = EXCLUDED.acked_at,
          acked_by_user_id = EXCLUDED.acked_by_user_id,
          acked_by_worker_id = EXCLUDED.acked_by_worker_id,
          acked_by_app_key_id = EXCLUDED.acked_by_app_key_id
        WHERE worker_wake_acks.acked_at < ${issuedNaive}::timestamp`) > 0;
      // Only the reservation of THIS wake is spent or void: the one carrying this proof's wake key. A re-read of an
      // unchanged wake shares the key, so it is freed whichever proof is acknowledged. Under R53 a mark no longer moves,
      // so the same wake offered again after the floor carries the SAME key: only a delivering acknowledgement frees
      // it, and an old proof's replay (refused by the receipt above) can never cancel the allowance of a wake issued
      // after it (Diego cycle 2, P2-3). Every earlier reservation of the key was freed by the receipt's own write.
      let spent: string[] | null = null;
      if (delivered) {
        const freed = await tx.$queryRaw<Array<{ absorbed_keys: string[] }>>(Prisma.sql`
          DELETE FROM app_wake_reservations WHERE worker_id = ${p.workerId} AND wake_key = ${proofWakeKey(p)} RETURNING absorbed_keys`);
        if (freed.length > 0) {
          spent = freed[0]!.absorbed_keys ?? [];
          // #2069 + R53 (Xavier, #21593): a wake that absorbed earlier reasons covers its ancestors. Their keys' receipts are
          // advanced to this acknowledgement, so an ancestor's proof acknowledged AFTER this one finds a receipt at or after
          // its issue and is neither a delivery nor another charge; the floor already counts from this acknowledgement.
          // #2102 (Dara P2-4): ADVANCED, never left behind. Under R53 the same still-due wake is offered again after the
          // floor, so an ancestor key may hold a receipt from a PRIOR cycle; keeping that older time would let a late
          // current-cycle ancestor proof pass as a fresh delivery and charge again. Monotone: a newer receipt is kept.
          for (const k of spent) {
            await tx.$executeRaw`
              INSERT INTO worker_wake_acks (worker_id, wake_key, acked_at, acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
              VALUES (${p.workerId}, ${k}, ${nowNaive}::timestamp, ${ackedBy.ackedByUserId}, ${ackedBy.ackedByWorkerId}, ${ackedBy.ackedByAppKeyId})
              ON CONFLICT (worker_id, wake_key) DO UPDATE SET
                acked_at = EXCLUDED.acked_at,
                acked_by_user_id = EXCLUDED.acked_by_user_id,
                acked_by_worker_id = EXCLUDED.acked_by_worker_id,
                acked_by_app_key_id = EXCLUDED.acked_by_app_key_id
              WHERE worker_wake_acks.acked_at < EXCLUDED.acked_at`;
          }
        }
      }
      if (!delivered && !advanced) { unchanged++; continue; }
      acknowledged++;
      // #2069: ONE allowance per outstanding wake. An ancestor proof (its key absorbed into the reservation still outstanding)
      // may deliver what it names, but the slot belongs to the descendant, which is spent and charged by ITS proof.
      if (delivered && spent === null) {
        const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(*)::bigint AS n FROM app_wake_reservations WHERE worker_id = ${p.workerId} AND ${proofWakeKey(p)} = ANY(absorbed_keys)`);
        if (Number(n) > 0) continue;
      }
      // Counted against the day's budget once per delivered wake: a repeat acknowledgement is not another wake.
      if (delivered && !p.exempt) {
        const dayText = now.toISOString().slice(0, 10);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO app_wake_days (app_id, day, wakes) VALUES (${p.appId}, ${dayText}::date, 1)
          ON CONFLICT (app_id, day) DO UPDATE SET wakes = app_wake_days.wakes + 1`);
      }
    }
    return { acknowledged, unchanged };
  }
}

/**
 * #2102 (Dara P2-3): is a proof still inside its 15 minutes (cor:agt:080:17) at the moment the marks are written? The
 * entry check alone admits a call that then waits on locks or a gate past expiry. The elapsed wait is measured on the
 * monotonic clock and added to the call's `now`, so an injected `now` keeps its meaning.
 */
function freshAfterWait(now: Date, entered: number, issuedAt: number): boolean {
  return now.getTime() + (performance.now() - entered) - issuedAt <= WAKE_PROOF_MAX_AGE_MS;
}

/**
 * The authority an acknowledgement rests on, anchored BEFORE any row or advisory lock (Diego cycle 2, P2-1): every App
 * in the call, its org and its owner. Revokers of that authority take the same anchors exclusively.
 */
async function authorityAnchorsOf(ctx: Context, appIds: string[]): Promise<AuthorityAnchor[]> {
  const apps = await ctx.db.app.findMany({ where: { id: { in: appIds } }, select: { id: true, organizationId: true, ownerUserId: true } });
  return apps.flatMap((a) => [
    { kind: 'app' as const, id: a.id },
    ...(a.organizationId ? [{ kind: 'org' as const, id: a.organizationId }] : []),
    ...(a.ownerUserId ? [{ kind: 'user' as const, id: a.ownerUserId }] : []),
  ]);
}

// acknowledgeBatchProofs — #2017 (S1), cor:agt:080:12/:16/:17.
//
// The host types a rendered delivery batch, then hands back its signed id. In ONE transaction each channel's
// delivered-through mark rises to the end of the range the batch rendered, or, with a partial `through`, to the listed
// rendered seq of each LISTED channel (an omitted channel moves nothing and stays due). It writes
// WorkerDeliveryChannel and, on a mention-only attendance only, ChannelReadState to the same seq (#2018, ruling A);
// no tick, no wake budget or reservation (a batch is not a wake). A repeat changes nothing. The host/scope authority is re-derived by the caller's `mayAckBatch` inside the transaction.
//
// Refusals: a forged, malformed or wrong-kind id, or a range past the channel's head → WAKE_PROOF_INVALID; an id issued
// to somebody else, or authority gone → WAKE_PROOF_REQUESTER_MISMATCH; older than 15 minutes, issued in the future, a
// channel recreated or deleted, a worker gone, or a range that starts above the worker's delivered mark (it would
// acknowledge an unseen prefix) → WAKE_PROOF_STALE (the batch stays due and the next read re-derives it); a `through`
// naming a channel not in the batch, a channel twice, or a seq the batch did not render → BAD_USER_INPUT. Nothing is
// written unless every id in the call passes.

export type BatchThrough = { channelId: string; seq: number };
export type BatchAck = { proof: string; through?: BatchThrough[] };

export async function acknowledgeBatchProofs(args: {
  ctx: Context;
  requester: BatchRequester;
  acks: BatchAck[];
  /**
   * Decides, per batch and INSIDE the transaction (after the worker's wake lock), that the requester may still
   * acknowledge this worker's batches: the S1 host/scope re-derivation (slice c). Same contract as `mayReadWorker`.
   */
  mayAckBatch: (proof: BatchProof, tx: Prisma.TransactionClient, txCtx: Context) => Promise<boolean>;
  now?: Date;
}): Promise<AcknowledgeResult> {
  const { ctx, requester } = args;
  const now = args.now ?? new Date();
  const entered = performance.now();
  if (args.acks.length === 0) return { acknowledged: 0, unchanged: 0 };
  if (args.acks.length > ACK_MAX_PROOFS) refuse('BAD_USER_INPUT', `Acknowledge at most ${ACK_MAX_PROOFS} batches at a time.`);

  const batches = args.acks.map((a) => {
    const proof = verifyBatchProof(a.proof);
    if (!sameBatchRequester(proof, requester)) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This delivery batch was issued to someone else.');
    if (now.getTime() - proof.issuedAt > WAKE_PROOF_MAX_AGE_MS || proof.issuedAt > now.getTime() + 60_000) {
      refuse('WAKE_PROOF_STALE', 'This delivery batch id is too old. Read the batch again.');
    }
    return { proof, marks: marksOf(proof, a.through) };
  });

  const nowNaive = toNaiveUtc(now);
  // Who delivered: a host key (and the worker session behind the request, if any), or, on the self arm, the worker itself
  // through its own session, stamped with the person driving that session (cor:agt:020:03; Vera, team chat #21429, as
  // S2's own-read delivered row). Attribution only: whether the session may acknowledge is mayAckBatch's decision.
  const ackedByOf = (p: BatchProof, sessionUserId: string | null): AckedBy => ('appKeyId' in requester
    ? { ackedByUserId: null, ackedByWorkerId: currentActor().workerId ?? null, ackedByAppKeyId: requester.appKeyId }
    : { ackedByUserId: sessionUserId, ackedByWorkerId: p.workerId, ackedByAppKeyId: null });
  const appIds = [...new Set(batches.map((b) => b.proof.appId))].sort();
  const anchors = await authorityAnchorsOf(ctx, appIds);

  try {
    return await withAuthorizedTx(ctx, anchors, async () => undefined, (tx, txCtx) => writeBatchAcks(tx, txCtx));
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This delivery batch was issued to someone else.');
    throw e;
  }

  async function writeBatchAcks(tx: Prisma.TransactionClient, txCtx: Context): Promise<AcknowledgeResult> {
    let acknowledged = 0;
    let unchanged = 0;
    const sessionUserId = 'sessionId' in requester
      ? (await tx.session.findUnique({ where: { id: requester.sessionId }, select: { userId: true } }))?.userId ?? null
      : null;
    // The lock order of acknowledgeWakes: the Apps' budget locks, then the per-worker wake locks by worker id. A batch
    // spends no budget, but sharing the order means a batch ack, a wake ack and an issue never wait in a cycle.
    for (const appId of appIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + appId}, 0))`;
    for (const { proof: p, marks } of [...batches].sort((a, b) => a.proof.workerId.localeCompare(b.proof.workerId))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + p.workerId}, 0))`;
      if (!(await args.mayAckBatch(p, tx, txCtx))) refuse('WAKE_PROOF_REQUESTER_MISMATCH', 'This delivery batch was issued to someone else.');
      const worker = await tx.worker.findUnique({ where: { id: p.workerId }, select: { appId: true, retiredAt: true } });
      if (!worker || worker.appId !== p.appId || worker.retiredAt) refuse('WAKE_PROOF_STALE', 'The worker of this delivery batch is gone.');
      // #2102 (Dara P2-3, cor:agt:080:17): fresh at the write, not only at entry: the locks and the gate above may wait.
      if (!freshAfterWait(now, entered, p.issuedAt)) refuse('WAKE_PROOF_STALE', 'This delivery batch id is too old. Read the batch again.');

      const live = await tx.channel.findMany({
        where: { id: { in: p.channels.map((c) => c.channelId) }, deletedAt: null },
        select: { id: true, incarnation: true, lastSeq: true },
      });
      for (const c of p.channels) {
        const cur = live.find((l) => l.id === c.channelId);
        if (!cur || cur.incarnation !== c.incarnation) refuse('WAKE_PROOF_STALE', 'A channel of this delivery batch was recreated since it was read.');
        // Seqs only rise within an incarnation, so a range past the head was never issued here.
        if (c.through > cur!.lastSeq) refuse('WAKE_PROOF_INVALID', 'Not a valid delivery batch id.');
      }

      let advanced = false;
      for (const m of marks) {
        const row = await tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: p.workerId, channelId: m.channelId } } });
        const sameIncarnation = row?.channelIncarnation === m.incarnation;
        // The batch covers from..through. A mark below from - 1 would leave seqs between it and from unseen yet
        // acknowledged; the loader issues from = mark + 1 and the mark only rises, so this is a batch to re-read.
        if (row && sameIncarnation && row.deliveredThroughSeq < m.from - 1) {
          refuse('WAKE_PROOF_STALE', 'This delivery batch no longer starts at the delivered mark. Read the batch again.');
        }
        if (!row || !sameIncarnation || m.through > row.deliveredThroughSeq) advanced = true;
        await raiseDeliveryMark(tx, { workerId: p.workerId, channelId: m.channelId, incarnation: m.incarnation, through: m.through }, nowNaive, ackedByOf(p, sessionUserId));
        // #2018 (S2, ruling A): on a mention-only attendance the read position moves with it, in this transaction.
        await raiseReadIfMentionOnly(tx, { workerId: p.workerId, channelId: m.channelId, through: m.through });
      }
      if (advanced) acknowledged++; else unchanged++;
    }
    return { acknowledged, unchanged };
  }
}

/**
 * The marks one batch ack moves. Without `through`, every channel to its range end. With it, ONLY the listed
 * channels, each to its listed seq, which must be one the batch rendered (so the covered prefix is the batch's own
 * start through a shown message, never a gap). Validated before any lock: a bad `through` is the caller's error.
 */
function marksOf(proof: BatchProof, through: BatchThrough[] | undefined): Array<{ channelId: string; incarnation: number; from: number; through: number }> {
  if (through === undefined) return proof.channels.map((c) => ({ channelId: c.channelId, incarnation: c.incarnation, from: c.from, through: c.through }));
  const seen = new Set<string>();
  return through.map((t) => {
    const c = proof.channels.find((x) => x.channelId === t.channelId);
    if (!c) return refuse('BAD_USER_INPUT', `Channel ${t.channelId} is not in this delivery batch.`);
    if (seen.has(t.channelId)) return refuse('BAD_USER_INPUT', `Channel ${t.channelId} is listed twice in through.`);
    seen.add(t.channelId);
    if (!c.seqs.includes(t.seq)) return refuse('BAD_USER_INPUT', `Seq ${t.seq} is not a message this delivery batch rendered in channel ${t.channelId}.`);
    return { channelId: c.channelId, incarnation: c.incarnation, from: c.from, through: t.seq };
  });
}
