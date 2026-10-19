/** Safe S5 read projection. Caller owns App visibility and a consistent read transaction. */
import type { Prisma } from '../../generated/prisma/index.js';
import type { DeliveryMessage } from './deliveryWait.js';
import { loadDeliveryWaits, deliveryAlarmSnapshot } from './deliveryState.js';
import { holdSnapshot } from './deliveryHolds.js';
import { loadDeliverySettings } from './deliverySettings.js';

/** S1 adapter must finish ALL pages at one asOf before constructing this input. */
export type CompletePendingDeliverySnapshot = { complete: true; asOf: Date; messages: readonly DeliveryMessage[] };
export async function deliveryHealthSnapshot(tx: Prisma.TransactionClient, a: {
  appId: string; workerId: string; asOf: Date; pending: CompletePendingDeliverySnapshot; limit?: number;
}) {
  const p = a.pending;
  if (!p || p.complete !== true || !(p.asOf instanceof Date) || !(a.asOf instanceof Date) || !Number.isFinite(a.asOf.getTime()) || p.asOf.getTime() !== a.asOf.getTime() || !Array.isArray(p.messages)) throw new Error('DELIVERY_PENDING_INCOMPLETE');
  const keys = new Set<string>();
  for (const m of p.messages) {
    const key = JSON.stringify([m.channelId, m.channelIncarnation, m.seq]);
    if (m.workerId !== a.workerId || !m.channelId || !Number.isSafeInteger(m.channelIncarnation) || m.channelIncarnation < 0 || !Number.isSafeInteger(m.seq) || m.seq < 1 || !(m.dueSince instanceof Date) || !Number.isFinite(m.dueSince.getTime()) || m.dueSince > a.asOf || keys.has(key)) throw new Error('DELIVERY_PENDING_INCOMPLETE');
    keys.add(key);
  }
  const worker = await tx.worker.findFirst({ where: { id: a.workerId, appId: a.appId, retiredAt: null }, select: { id: true } });
  if (!worker) throw new Error('DELIVERY_WORKER_NOT_FOUND');
  const storedHolds = await tx.workerDeliveryHold.findMany({ where: { workerId: a.workerId } });
  const channelIdsInScope = [...new Set([...p.messages.map(m => m.channelId), ...storedHolds.map(h => h.channelId)])];
  const [channels, reads, deliveries, settings] = await Promise.all([
    tx.channel.findMany({ where: { deletedAt: null, id: { in: channelIdsInScope } }, select: { id: true, incarnation: true } }),
    tx.channelReadState.findMany({ where: { workerId: a.workerId, channelId: { in: channelIdsInScope } }, select: { channelId: true, lastSeenSeq: true } }),
    tx.workerDeliveryChannel.findMany({ where: { workerId: a.workerId, channelId: { in: channelIdsInScope } }, select: { channelId: true, channelIncarnation: true, deliveredThroughSeq: true } }),
    loadDeliverySettings(tx, a.appId),
  ]);
  const current = new Map(channels.map(c => [c.id, c.incarnation]));
  const readMarks = new Map(reads.map(r => [r.channelId, r.lastSeenSeq]));
  const deliveryMarks = new Map(deliveries.map(r => [r.channelId, r]));
  const covered = (channelId: string, incarnation: number) => {
    const d = deliveryMarks.get(channelId);
    return Math.max(readMarks.get(channelId) ?? 0, d?.channelIncarnation === incarnation ? d.deliveredThroughSeq : 0);
  };
  const messages = p.messages.filter(m => current.get(m.channelId) === m.channelIncarnation && m.seq > covered(m.channelId, m.channelIncarnation));
  const holds = storedHolds.filter(h => current.get(h.channelId) === h.channelIncarnation && h.firstPendingSeq > covered(h.channelId, h.channelIncarnation));
  const waits = await loadDeliveryWaits(tx, a.workerId, messages, a.asOf);
  const alarm = await deliveryAlarmSnapshot(tx, a.workerId, a.asOf);
  const channelIds = [...new Set([...messages.map(m => m.channelId), ...holds.map(h => h.channelId)])].sort();
  const grouped = new Map<string, (DeliveryMessage & (typeof waits)[number] & { suppressionClassification: 'EXCEPTION' | 'NONE' })[]>();
  messages.forEach((m, i) => {
    const group = grouped.get(m.channelId) ?? [];
    group.push({ ...m, ...waits[i]!, suppressionClassification: waits[i]!.suppressed ? 'EXCEPTION' : 'NONE' });
    grouped.set(m.channelId, group);
  });
  const heldByChannel = new Map(holds.map(h => [h.channelId, h]));
  const all = channelIds.map(channelId => {
    const channelIncarnation = current.get(channelId)!;
    const candidates = grouped.get(channelId) ?? [];
    // Match S5 selection: qualifying uncovered first; selective suppression may
    // leave a later reached message eligible while the oldest is withheld.
    const rank = (m: typeof candidates[number]) => m.suppressed ? 2 : m.waitedMs >= settings.stuckWindowSeconds * 1000 ? 0 : 1;
    candidates.sort((x, y) => rank(x) - rank(y) || x.dueSince.getTime() - y.dueSince.getTime() || x.seq - y.seq);
    const chosen = candidates[0];
    const candidate = chosen ? { channelId, channelIncarnation, seq: chosen.seq, dueSince: chosen.dueSince, waitedMs: chosen.waitedMs, waitAsOf: chosen.waitAsOf, suppressionClassification: chosen.suppressionClassification } : null;
    const h = heldByChannel.get(channelId);
    return { channelId, channelIncarnation, hold: h ? holdSnapshot(h) : null, pendingMessageCount: candidates.length, candidate };
  });
  const limit = Math.max(1, Math.min(200, Number.isFinite(a.limit) ? Math.trunc(a.limit!) : 50));
  return { appId: a.appId, workerId: a.workerId, asOf: a.asOf,
    pendingMessageCount: messages.length, heldChannelCount: holds.length,
    activeAlarmCount: alarm?.state === 'ACTIVE' ? 1 : 0, suppressedAlarmCount: alarm?.state === 'SUPPRESSED' ? 1 : 0,
    alarm: alarm ? { episodeId: alarm.episodeId, eventId: alarm.eventId, anchor: { channelId: alarm.channelId, channelIncarnation: alarm.channelIncarnation, seq: alarm.firstPendingSeq }, state: alarm.state, waitedMs: alarm.waitedMs, waitAsOf: alarm.waitAsOf, suppressionClassification: alarm.state === 'SUPPRESSED' ? 'EXCEPTION' as const : 'NONE' as const, acknowledgedAt: alarm.acknowledgedAt, acknowledgedBy: alarm.acknowledgedBy } : null,
    channels: all.slice(0, limit), totalChannels: all.length, hasMore: all.length > limit,
  };
}
export type DeliveryHealthSnapshot = Awaited<ReturnType<typeof deliveryHealthSnapshot>>;
