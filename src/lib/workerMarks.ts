/**
 * #2018 (S2, D-2026-10-16-001, Holger ruling A): one mark. The shared seam every path that moves a worker's marks
 * for message TEXT goes through, inside the caller's transaction: a text-batch ack (S1, `acknowledge.ts`) and a
 * worker's own mentions read (`teamAttention.ts`). Neither opens a transaction nor swallows an error.
 *
 * - `raiseDeliveryMark` is the one writer of `worker_delivery_channels` (moved verbatim from `acknowledge.ts`).
 * - `raiseReadIfMentionOnly` moves the read position with it ONLY on a mention-only attendance: there unread IS
 *   mentions (cor:agt:080:08), so the two marks move together. A full attendance's read position moves only on an
 *   unfiltered read or an explicit mark (ruling A).
 *
 * A textless legacy wake ack calls neither (R53, cor:agt:080:16): it carries no text, so it moves no mark.
 */
import type { Prisma } from '../generated/prisma/index.js';
import { advanceReadState } from './channelReadState.js';
import { collectRegisterRows } from './resolveRegister.js';

export type AckedBy = { ackedByUserId: string | null; ackedByWorkerId: string | null; ackedByAppKeyId: string | null };

/**
 * Raise one worker's delivered-through mark on one channel. GREATEST: it only rises, unless the channel was recreated
 * (then it restarts at the new incarnation). The one writer of `worker_delivery_channels` for wakes and batches alike.
 */
export async function raiseDeliveryMark(
  tx: Prisma.TransactionClient,
  m: { workerId: string; channelId: string; incarnation: number; through: number },
  nowNaive: string,
  ackedBy: AckedBy,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO worker_delivery_channels
      (worker_id, channel_id, channel_incarnation, delivered_through_seq, delivered_at,
       acked_by_user_id, acked_by_worker_id, acked_by_app_key_id)
    VALUES (${m.workerId}, ${m.channelId}, ${m.incarnation}, ${m.through}, ${nowNaive}::timestamp,
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

/**
 * Raise the worker's read position to `through` when its effective attendance of the channel is mention-only
 * (the register row `collectRegisterRows` resolves for it). Monotone (`GREATEST`). Returns whether it was written.
 */
export async function raiseReadIfMentionOnly(
  tx: Prisma.TransactionClient,
  m: { workerId: string; channelId: string; through: number },
): Promise<boolean> {
  const rows = (await collectRegisterRows(tx as never, { workerId: m.workerId }))?.rows ?? [];
  const row = rows.find((r) => r.channelId === m.channelId);
  if (!row || row.role === 'POST' || !row.mentionOnly) return false;
  await advanceReadState(tx, { workerId: m.workerId }, m.channelId, m.through);
  return true;
}
