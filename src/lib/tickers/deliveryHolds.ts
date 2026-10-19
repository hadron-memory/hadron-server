/** Internal trusted S1 write seam; caller supplies live authorization and worker lock. */
import type { Prisma, WorkerDeliveryHold } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { appendDeliveryHeldEvent } from '../agentTasks/events.js';
export const DELIVERY_HOLD_REASONS = ['draft', 'isolated', 'question', 'screen-unknown', 'not-submitted', 'two-agents', 'binding-mismatch'] as const;
export type DeliveryHoldReason = typeof DELIVERY_HOLD_REASONS[number];
export type DeliveryHoldPrincipal = { kind: 'host-key'; appKeyId: string; hostId: string } | { kind: 'worker'; workerId: string; sessionId: string };
export type DeliveryHoldSnapshot = { holdId: string; channelId: string; channelIncarnation: number; firstPendingSeq: number; since: Date; observedAt: Date; reason: DeliveryHoldReason; terminalId: string | null; principal: DeliveryHoldPrincipal };
const invalid = (): never => { throw new Error('DELIVERY_METADATA_INVALID'); };
const id = (v: string) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : invalid();
export function safeHoldPrincipal(p: DeliveryHoldPrincipal): DeliveryHoldPrincipal {
  if (p.kind === 'host-key') return { kind: 'host-key', appKeyId: id(p.appKeyId), hostId: id(p.hostId) };
  if (p.kind === 'worker') return { kind: 'worker', workerId: id(p.workerId), sessionId: id(p.sessionId) };
  return invalid();
}
export function holdSnapshot(r: WorkerDeliveryHold): DeliveryHoldSnapshot {
  return { holdId: r.id, channelId: r.channelId, channelIncarnation: r.channelIncarnation, firstPendingSeq: r.firstPendingSeq, since: r.since, observedAt: r.observedAt, reason: r.reason as DeliveryHoldReason, terminalId: r.terminalId, principal: safeHoldPrincipal(r.principal as DeliveryHoldPrincipal) };
}
/** Canonical marks for the current occupancy; old delivery incarnation never covers new. */
export async function deliveryCoveredThrough(tx: Prisma.TransactionClient, workerId: string, channelId: string, incarnation: number): Promise<number> {
  const [channel, delivered, read] = await Promise.all([
    tx.channel.findUnique({ where: { id: channelId }, select: { incarnation: true, deletedAt: true } }),
    tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId, channelId } } }),
    tx.channelReadState.findFirst({ where: { workerId, channelId }, select: { lastSeenSeq: true } }),
  ]);
  if (!channel || channel.deletedAt || channel.incarnation !== incarnation) throw new Error('DELIVERY_CHANNEL_NOT_CURRENT');
  return Math.max(read?.lastSeenSeq ?? 0, delivered?.channelIncarnation === incarnation ? delivered.deliveredThroughSeq : 0);
}
export async function recordDeliveryHold(tx: Prisma.TransactionClient, a: {
  workerId: string; channelId: string; channelIncarnation: number; firstPendingSeq: number;
  reason: DeliveryHoldReason; terminalId: string | null; principal: DeliveryHoldPrincipal; now: Date;
}): Promise<DeliveryHoldSnapshot> {
  id(a.workerId); id(a.channelId);
  if (!(DELIVERY_HOLD_REASONS as readonly string[]).includes(a.reason) || !Number.isSafeInteger(a.channelIncarnation) || a.channelIncarnation < 0 || !Number.isSafeInteger(a.firstPendingSeq) || a.firstPendingSeq < 1 || !Number.isFinite(a.now.getTime()) || (a.terminalId !== null && !/^term_[A-Za-z0-9_-]{1,128}$/.test(a.terminalId))) invalid();
  const principal = safeHoldPrincipal(a.principal);
  if (principal.kind === 'worker' && principal.workerId !== a.workerId) throw new Error('DELIVERY_WORKER_MISMATCH');
  const through = await deliveryCoveredThrough(tx, a.workerId, a.channelId, a.channelIncarnation);
  if (a.firstPendingSeq <= through) throw new Error('DELIVERY_HOLD_NOT_PENDING');
  const key = { workerId: a.workerId, channelId: a.channelId, channelIncarnation: a.channelIncarnation };
  let old = await tx.workerDeliveryHold.findUnique({ where: { workerId_channelId_channelIncarnation: key } });
  if (old && old.firstPendingSeq <= through) {
    await tx.workerDeliveryHold.delete({ where: { id: old.id } }); old = null;
  }
  if (old && a.now < old.observedAt) throw new Error('DELIVERY_HOLD_STALE');
  const firstPendingSeq = Math.min(old?.firstPendingSeq ?? a.firstPendingSeq, a.firstPendingSeq);
  if (old && old.reason === a.reason && old.terminalId === a.terminalId && old.firstPendingSeq === firstPendingSeq && JSON.stringify(safeHoldPrincipal(old.principal as DeliveryHoldPrincipal)) === JSON.stringify(principal)) return holdSnapshot(old);
  const data = { firstPendingSeq, reason: a.reason, terminalId: a.terminalId, principal, observedAt: a.now };
  const row = old ? await tx.workerDeliveryHold.update({ where: { id: old.id }, data }) : await tx.workerDeliveryHold.create({ data: { id: generateId(), ...key, ...data, since: a.now } });
  const worker = await tx.worker.findUniqueOrThrow({ where: { id: a.workerId }, select: { appId: true } });
  const snapshot = holdSnapshot(row);
  await appendDeliveryHeldEvent(tx, { appId: worker.appId, workerId: a.workerId, hold: snapshot, now: a.now });
  return snapshot;
}
