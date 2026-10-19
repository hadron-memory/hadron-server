// S7 (#2023, R90, D-2026-10-16-005) — the assignment raise: when a task is assigned to a worker that was on standby
// immediately before, its delivered mark rises past the messages held from it, and the count is returned ONCE.
//
// A NAMED EXCEPTION to cor:agt:080:16, not an acknowledgement. It runs only inside the assignment's own transaction
// (appendTaskEvent, for the three assigned event types), never on an acknowledgement path (standbyAssignment.test.ts pins
// that no ack entry point reaches it), and it never passes a message that standby ADMITS but has not been delivered: the
// raise stops one short of the lowest admitted undelivered seq. Only the assignee's own marks move; the read position never does.
//
// LOCKS: the per-worker `wake:<id>` advisory lock, the one batch/wake acknowledgement and issuance take, acquired after the
// task path's own per-worker lock. An acknowledgement takes no task lock, so the two orders cannot cycle.
//
// COUNT: the messages in (effective mark, raise] that REACH the worker (the standby filter not applied). Its own posts and chatter that never reached it
// are not counted. Plaintext channels only: an encrypted channel is never delivered (deliveryBatch.ts), so there is nothing held.
import { Prisma } from '../../generated/prisma/index.js';
import { collectRegisterRows } from '../resolveRegister.js';
import { mentionReachSql } from '../mentionReach.js';
import { mentionTokenOf } from '../mentionToken.js';
import { raiseDeliveryMark } from '../workerMarks.js';
import { standbyAdmitsSql, workerStandby } from './standby.js';
import { s7Available } from './s7Availability.js';

export type AssignmentActor = { userId: string | null; workerId: string | null };

/** @returns the number of held messages the raise passed (0 when the worker was not on standby or nothing was held). */
export async function raiseDeliveredOnAssignment(
  tx: Prisma.TransactionClient,
  args: { workerId: string; taskId: string; actor: AssignmentActor; now?: Date },
): Promise<number> {
  if (!s7Available()) return 0; // inert until S7b: no lock, no marks, no count (Ada #25413 option a)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + args.workerId}, 0))`;
  const state = await workerStandby(tx, args.workerId, { excludeTaskId: args.taskId });
  if (!state.onStandby || !state.headWorkerId) return 0;
  const worker = await tx.worker.findUnique({ where: { id: args.workerId }, select: { name: true } });
  const token = worker ? mentionTokenOf(worker.name) : null;
  if (!token) return 0;
  const rows = (await collectRegisterRows(tx as unknown as Parameters<typeof collectRegisterRows>[0], { workerId: args.workerId }))?.rows ?? [];
  const channelIds = [...new Set(rows.filter((r) => r.role !== 'POST').map((r) => r.channelId))].sort();
  if (channelIds.length === 0) return 0;
  const channels = await tx.channel.findMany({
    where: { id: { in: channelIds }, deletedAt: null, memory: { isEncrypted: false } },
    select: { id: true, lastSeq: true, incarnation: true },
    orderBy: { id: 'asc' },
  });
  const now = args.now ?? new Date();
  const nowNaive = now.toISOString().replace('Z', '');
  const tokens = Prisma.sql`${[token]}::text[]`;
  let held = 0;
  for (const ch of channels) {
    const [seen, delivered] = await Promise.all([
      tx.channelReadState.findFirst({ where: { workerId: args.workerId, channelId: ch.id }, select: { lastSeenSeq: true } }),
      tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId: args.workerId, channelId: ch.id } } }),
    ]);
    const mark = delivered && delivered.channelIncarnation === ch.incarnation ? delivered.deliveredThroughSeq : 0;
    const lo = Math.max(seen?.lastSeenSeq ?? 0, mark);
    const head = ch.lastSeq;
    if (head <= lo) continue;
    const reaches = Prisma.sql`n.message_channel_id = ${ch.id} AND n.node_type = 'chat-message' AND n.deleted_at IS NULL
      AND n.seq > ${lo} AND n.seq <= ${head}
      AND (n.data -> 'authorWorkerId') IS DISTINCT FROM ${JSON.stringify(args.workerId)}::jsonb
      AND ${mentionReachSql(Prisma.sql`n.data`, tokens)}`;
    // The raise never passes an admitted, undelivered message (Xan).
    const firstAdmitted = await tx.$queryRaw<Array<{ seq: number | null }>>(Prisma.sql`
      SELECT MIN(n.seq)::int AS seq FROM nodes n WHERE ${reaches} AND ${standbyAdmitsSql(Prisma.sql`n.data`, tokens, state.headWorkerId)}`);
    const first = firstAdmitted[0]?.seq ?? null;
    const raise = first === null ? head : Math.min(head, first - 1);
    if (raise <= mark) continue;
    const counted = await tx.$queryRaw<Array<{ c: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS c FROM nodes n WHERE ${reaches} AND n.seq <= ${raise}`);
    held += Number(counted[0]?.c ?? 0);
    await raiseDeliveryMark(tx, { workerId: args.workerId, channelId: ch.id, incarnation: ch.incarnation, through: raise }, nowNaive,
      { ackedByUserId: args.actor.userId, ackedByWorkerId: args.actor.workerId, ackedByAppKeyId: null });
  }
  return held;
}
