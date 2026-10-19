/**
 * S5 persistence primitives. INTERNAL ONLY: policy producers and S1/S2 must
 * authorize under their own live gates in this transaction before calling.
 * There is deliberately no hold/resumed reporting API or activation sweep yet.
 * No request body, proof, draft, screen or rendered message enters this module.
 */
import { type Prisma, type PrismaClient, type WorkerDeliveryAlarmEpisode } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { appendDeliveryResumedEvent, appendDeliveryStuckEvent, appendDeliveryChannelRetiredEvent, type DeliveryMarkPrincipal, type AlarmChain } from '../agentTasks/events.js';
export type { DeliveryMarkPrincipal } from '../agentTasks/events.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { lockAppReportsTo, reportsToChain } from '../workerReportsTo.js';
import { appManagerUserIds } from '../auth/appManagement.js';
import { loadDeliverySettings } from './deliverySettings.js';
import { deliveryCoveredThrough } from './deliveryHolds.js';
import { deliveryWait, oldestStuckMessage, nextDeliveryOwnerDue, DELIVERY_EXCEPTION_CAUSES, type DeliveryMessage, type WaitException, type WaitCoverage } from './deliveryWait.js';

type Tx = Prisma.TransactionClient;
/** S1/S7 internal seam: exact authorized identity in this transaction, coverage metadata only. */
export type StandbyCoverageClassifier = (tx: Tx, identity: {
  workerId: string; channelId: string; incarnation: number; seq: number; headWorkerId: string;
}) => Promise<{ held: boolean; headWorkerId: string } | null>;
function fail(code: string): never { throw new Error(code); }

/** Preserve authority -> reporting graph -> App budget -> worker wake order. */
export async function deliveryStateTransaction<T>(db: PrismaClient, appId: string, workerId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    const app = await tx.app.findUnique({ where: { id: appId }, select: { organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true } });
    if (!app || app.deletedAt || app.uninstalledAt) fail('DELIVERY_WORKER_NOT_FOUND');
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: appId }, ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []), ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : [])], 'shared');
    const current = await tx.app.findUnique({ where: { id: appId }, select: {
      organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true,
      organization: { select: { deletedAt: true } }, ownerUser: { select: { deletedAt: true } },
    } });
    if (!current || current.deletedAt || current.uninstalledAt || current.organization?.deletedAt || current.ownerUser?.deletedAt) fail('DELIVERY_WORKER_NOT_FOUND');
    if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) fail('DELIVERY_AUTHORITY_CHANGED');
    await lockDeliveryState(tx, appId, workerId);
    return fn(tx);
  }, { timeout: 30_000 });
}

type DeliveryLockSet = { appId: string; workers: ReadonlySet<string>; acquired: boolean };
const deliveryLockSets = new WeakMap<Tx, DeliveryLockSet>();

/**
 * Caller already holds its complete authority set and reporting graph in the
 * required mode. Acquire this transaction's COMPLETE worker set before any
 * deciding membership/Worker rows. Planned cast IDs need not exist yet.
 * No authority, graph upgrade, row lookup or nested transaction happens here.
 */
export async function lockDeliveryWorkers(tx: Tx, appId: string, workerIds: readonly string[]): Promise<void> {
  if (typeof (tx as unknown as { $transaction?: unknown }).$transaction === 'function') fail('DELIVERY_TRANSACTION_REQUIRED');
  if (!appId || !workerIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))) fail('DELIVERY_LOCK_SET_STALE');
  const workers = new Set(workerIds);
  const prior = deliveryLockSets.get(tx);
  if (prior) {
    if (!prior.acquired || prior.appId !== appId || [...workers].some(id => !prior.workers.has(id))) fail('DELIVERY_LOCK_SET_STALE');
    return;
  }
  // Seal before waiting: concurrent calls cannot expand the set or use a
  // partially acquired set. A failed acquisition poisons this transaction.
  const held: DeliveryLockSet = { appId, workers, acquired: false };
  deliveryLockSets.set(tx, held);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wakebudget:' + appId}, 0))`;
  for (const id of [...workers].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'wake:' + id}, 0))`;
  held.acquired = true;
}

/** Producer writes may only touch the predeclared worker set of this tx. */
export function assertDeliveryWorkerLocked(tx: Tx, workerId: string): void {
  const held = deliveryLockSets.get(tx);
  if (!held?.acquired || !held.workers.has(workerId)) fail('DELIVERY_LOCK_NOT_HELD');
}

/** After the caller holds its authority/owner rows, share the canonical graph -> budget -> worker order. */
export async function lockDeliveryState(tx: Tx, appId: string, workerId: string): Promise<void> {
    await lockAppReportsTo(tx, appId, 'shared');
    await lockDeliveryWorkers(tx, appId, [workerId]);
    const worker = await tx.worker.findFirst({ where: { id: workerId, appId, retiredAt: null, app: { deletedAt: null, uninstalledAt: null } }, select: { id: true } });
    if (!worker) fail('DELIVERY_WORKER_NOT_FOUND');
}

export async function beginDeliveryTracking(tx: Tx, workerId: string, at: Date): Promise<void> {
  assertDeliveryWorkerLocked(tx, workerId);
  await tx.workerDeliveryWaitState.upsert({ where: { workerId }, create: { workerId, trackedFrom: at, observedThrough: at }, update: {} });
}

function coverageKey(c: WaitCoverage): string {
  if (c.kind === 'worker') return 'worker';
  if (c.kind === 'standby-mode') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(c.headWorkerId)) fail('DELIVERY_COVERAGE_INVALID');
    return `standby-mode:${c.headWorkerId}`;
  }
  if (c.kind !== 'range' || !c.channelId || c.channelId.length > 256 || ![c.channelIncarnation, c.fromSeq, c.throughSeq].every(Number.isSafeInteger) || c.channelIncarnation < 0 || c.fromSeq < 1 || c.throughSeq < c.fromSeq) fail('DELIVERY_COVERAGE_INVALID');
  return JSON.stringify([c.channelId, c.channelIncarnation, c.fromSeq, c.throughSeq]);
}

/** Standby alone may use a head-fixed mode; budget coverage remains an exact range. */
function validateCoverageCause(cause: WaitException['cause'], coverage: WaitCoverage) {
  if ((coverage.kind === 'standby-mode' && cause !== 'standby') ||
      (cause === 'wake-budget' && coverage.kind !== 'range') ||
      (cause === 'standby' && !['range', 'standby-mode'].includes(coverage.kind))) fail('DELIVERY_COVERAGE_INVALID');
}

/** Idempotent effective-time producer write. Caller holds worker lock and knows exact coverage. */
export async function recordDeliveryException(tx: Tx, e: WaitException): Promise<void> {
  assertDeliveryWorkerLocked(tx, e.workerId);
  if (!(DELIVERY_EXCEPTION_CAUSES as readonly string[]).includes(e.cause) || !Number.isFinite(e.startedAt.getTime()) || (e.endedAt && (!Number.isFinite(e.endedAt.getTime()) || e.endedAt < e.startedAt))) fail('DELIVERY_EXCEPTION_INVALID');
  const state = await tx.workerDeliveryWaitState.findUnique({ where: { workerId: e.workerId } });
  if (!state || e.startedAt < state.trackedFrom) fail('DELIVERY_WAIT_INCOMPLETE');
  validateCoverageCause(e.cause, e.coverage);
  const key = coverageKey(e.coverage);
  const identity = { workerId: e.workerId, cause: e.cause, coverageKey: key, startedAt: e.startedAt };
  const prior = await tx.workerDeliveryWaitException.findUnique({ where: { workerId_cause_coverageKey_startedAt: identity } });
  if (!prior && e.startedAt < state.observedThrough) fail('DELIVERY_POLICY_LATE');
  if (prior && !prior.endedAt && e.endedAt && e.endedAt < state.observedThrough) fail('DELIVERY_POLICY_LATE');
  if (prior?.endedAt && prior.endedAt.getTime() !== e.endedAt?.getTime()) fail('DELIVERY_EXCEPTION_CONFLICT');
  const c = e.coverage;
  await tx.workerDeliveryWaitException.upsert({ where: { workerId_cause_coverageKey_startedAt: identity },
    create: { id: generateId(), ...identity, endedAt: e.endedAt, channelId: c.kind === 'range' ? c.channelId : null, channelIncarnation: c.kind === 'range' ? c.channelIncarnation : null, fromSeq: c.kind === 'range' ? c.fromSeq : null, throughSeq: c.kind === 'range' ? c.throughSeq : null },
    update: prior?.endedAt ? {} : { endedAt: e.endedAt },
  });
}

/**
 * Policy-owner seam for an effective change, including cancellation of a stored
 * future expiry. Call after re-reading that policy under the shared authority /
 * budget / worker locks; this is not a client-supplied reporting operation.
 * Changes may replace unobserved future time, never certified past time.
 * Other causes and selective ranges remain independent.
 */
export async function transitionDeliveryException(tx: Tx, change: {
  workerId: string; cause: WaitException['cause']; coverage: WaitCoverage;
  effectiveAt: Date; active: boolean; until?: Date | null;
}): Promise<void> {
  const { workerId, cause, coverage, effectiveAt, active } = change;
  assertDeliveryWorkerLocked(tx, workerId);
  const until = change.until ?? null;
  if (!(DELIVERY_EXCEPTION_CAUSES as readonly string[]).includes(cause) ||
      !Number.isFinite(effectiveAt.getTime()) ||
      (until && (!Number.isFinite(until.getTime()) || until <= effectiveAt))) fail('DELIVERY_EXCEPTION_INVALID');
  validateCoverageCause(cause, coverage);
  const key = coverageKey(coverage);
  const state = await tx.workerDeliveryWaitState.findUnique({ where: { workerId } });
  if (!state || effectiveAt < state.trackedFrom) fail('DELIVERY_WAIT_INCOMPLETE');
  if (effectiveAt < state.observedThrough) fail('DELIVERY_POLICY_LATE');
  const spans = await tx.workerDeliveryWaitException.findMany({ where: {
    workerId, cause, coverageKey: key, startedAt: { lte: effectiveAt },
    OR: [{ endedAt: null }, { endedAt: { gt: effectiveAt } }],
  } });
  // A repeated active notification must not split/reset the persisted clock.
  if (active && spans.length === 1 && spans[0]!.endedAt?.getTime() === until?.getTime()) return;
  for (const span of spans) {
    await tx.workerDeliveryWaitException.update({ where: { id: span.id }, data: { endedAt: effectiveAt } });
  }
  if (!active) return;
  // A policy correction at the same effective instant replaces only that
  // instant's span, retaining its identity and all earlier elapsed intervals.
  const identity = { workerId, cause, coverageKey: key, startedAt: effectiveAt };
  const c = coverage;
  await tx.workerDeliveryWaitException.upsert({
    where: { workerId_cause_coverageKey_startedAt: identity },
    create: { id: generateId(), ...identity, endedAt: until,
      channelId: c.kind === 'range' ? c.channelId : null,
      channelIncarnation: c.kind === 'range' ? c.channelIncarnation : null,
      fromSeq: c.kind === 'range' ? c.fromSeq : null, throughSeq: c.kind === 'range' ? c.throughSeq : null },
    update: { endedAt: until },
  });
}

/** Completeness certificate from the integrated policy producer, not the evaluator's clock. */
export async function observeDeliveryPolicyThrough(tx: Tx, workerId: string, through: Date): Promise<void> {
  assertDeliveryWorkerLocked(tx, workerId);
  if (!Number.isFinite(through.getTime())) fail('DELIVERY_WAIT_INVALID');
  await tx.workerDeliveryWaitState.updateMany({ where: { workerId, observedThrough: { lt: through } }, data: { observedThrough: through } });
}

async function waitInputs(tx: Tx, workerId: string, now: Date, oldestDueAt: Date) {
  const state = await tx.workerDeliveryWaitState.findUnique({ where: { workerId } });
  if (!state || state.observedThrough < now) fail('DELIVERY_WAIT_INCOMPLETE');
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(oldestDueAt.getTime())) fail('DELIVERY_WAIT_INVALID');
  // Only intervals intersecting a candidate/anchor's possible wait can matter.
  // Never scan the worker's entire lifetime for a recently posted message.
  const lower = new Date(Math.min(now.getTime(), Math.max(state.trackedFrom.getTime(), oldestDueAt.getTime())));
  const rows = await tx.workerDeliveryWaitException.findMany({ where: { workerId, startedAt: { lte: now }, OR: [{ endedAt: null }, { endedAt: { gt: lower } }] }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] });
  const exceptions: WaitException[] = rows.map(r => ({ workerId, cause: r.cause as WaitException['cause'], startedAt: r.startedAt, endedAt: r.endedAt,
    coverage: r.coverageKey.startsWith('standby-mode:') ? { kind: 'standby-mode', headWorkerId: r.coverageKey.slice('standby-mode:'.length) } : r.channelId === null ? { kind: 'worker' } : { kind: 'range', channelId: r.channelId, channelIncarnation: r.channelIncarnation!, fromSeq: r.fromSeq!, throughSeq: r.throughSeq! } }));
  return { state, exceptions };
}

/** No supplied classification map is trusted by the persisted service; resolve canonical evidence afresh. */
async function classifyStandby(tx: Tx, message: DeliveryMessage, exceptions: readonly WaitException[], state: { trackedFrom: Date }, asOf: Date, classifier?: StandbyCoverageClassifier): Promise<DeliveryMessage> {
  const start = Math.max(message.dueSince.getTime(), state.trackedFrom.getTime());
  const heads = new Set(exceptions.flatMap(e => e.workerId === message.workerId && e.coverage.kind === 'standby-mode' &&
    e.startedAt <= asOf && (!e.endedAt || e.endedAt.getTime() > start) ? [e.coverage.headWorkerId] : []));
  if (!heads.size) return message;
  if (!classifier) fail('DELIVERY_WAIT_INCOMPLETE');
  const coverage = new Map<string, boolean>();
  for (const headWorkerId of heads) {
    const decision = await classifier(tx, { workerId: message.workerId, channelId: message.channelId,
      incarnation: message.channelIncarnation, seq: message.seq, headWorkerId });
    if (!decision || typeof decision.held !== 'boolean' || decision.headWorkerId !== headWorkerId ||
        Object.keys(decision).some(k => k !== 'held' && k !== 'headWorkerId')) fail('DELIVERY_WAIT_INCOMPLETE');
    coverage.set(headWorkerId, decision.held);
  }
  return { ...message, standbyCoverage: coverage };
}

export async function loadDeliveryWait(tx: Tx, message: DeliveryMessage, now: Date, classifier?: StandbyCoverageClassifier) {
  const { state, exceptions } = await waitInputs(tx, message.workerId, now, message.dueSince);
  return deliveryWait(await classifyStandby(tx, message, exceptions, state, now, classifier), exceptions, state, now);
}

/** One ledger read for the complete pending set; empty still verifies coverage. */
export async function loadDeliveryWaits(tx: Tx, workerId: string, messages: readonly DeliveryMessage[], asOf: Date, classifier?: StandbyCoverageClassifier) {
  if (messages.some(m => m.workerId !== workerId)) fail('DELIVERY_WORKER_MISMATCH');
  const oldest = new Date(messages.reduce((n, m) => Math.min(n, m.dueSince.getTime()), asOf.getTime()));
  const { state, exceptions } = await waitInputs(tx, workerId, asOf, oldest);
  if (state.trackedFrom > asOf) fail('DELIVERY_WAIT_INCOMPLETE');
  const waits = [];
  for (const message of messages) waits.push(deliveryWait(await classifyStandby(tx, message, exceptions, state, asOf, classifier), exceptions, state, asOf));
  return waits;
}

/** Capture under deliveryStateTransaction's shared reportsTo/authority fences. */
export async function deliveryAlarmChain(tx: Tx, workerId: string): Promise<AlarmChain> {
  const worker = await tx.worker.findUniqueOrThrow({ where: { id: workerId }, select: { appId: true } });
  const chain = await reportsToChain(tx, workerId);
  if (chain.length) {
    // The graph writer enforces this; fail closed on corrupt legacy pointers.
    const members = await tx.worker.count({ where: { id: { in: chain }, appId: worker.appId } });
    if (new Set(chain).size !== chain.length || chain.includes(workerId) || members !== chain.length) fail('DELIVERY_CHAIN_INVALID');
    return chain.map(id => ({ workerId: id }));
  }
  const app = await tx.app.findUniqueOrThrow({ where: { id: worker.appId }, select: { id: true, organizationId: true, ownerUserId: true } });
  return (await appManagerUserIds(tx, app)).map(userId => ({ userId, via: 'manager' }));
}

export type DeliveryAlarmInput = {
  workerId: string; candidates: DeliveryMessage[]; now: Date;
  standbyClassifier?: StandbyCoverageClassifier;
  hold: { reason: 'draft' | 'isolated' | 'question' | 'screen-unknown' | 'not-submitted' | 'two-agents' | 'binding-mismatch'; terminalId: string | null } | null;
  /** S1/S2 supply provenance only AFTER persisting marks. Claimed ranges are verified below. */
  mark?: { channelId: string; channelIncarnation: number; throughSeq: number; principal: DeliveryMarkPrincipal };
};

async function channelStillCurrent(tx: Tx, channelId: string, incarnation: number): Promise<boolean> {
  const channel = await tx.channel.findUnique({ where: { id: channelId }, select: { deletedAt: true, incarnation: true } });
  return !!channel && !channel.deletedAt && channel.incarnation === incarnation;
}

/** R62: recorded lifecycle evidence, never missing candidates or policy suppression. */
async function closeRetiredChannelAlarm(tx: Tx, appId: string, active: WorkerDeliveryAlarmEpisode, now: Date): Promise<string | null> {
  if (await channelStillCurrent(tx, active.channelId, active.channelIncarnation)) return null;
  const resumed = await appendDeliveryChannelRetiredEvent(tx, {
    appId, workerId: active.workerId, episodeId: active.episodeId,
    channelId: active.channelId, channelIncarnation: active.channelIncarnation, now,
  });
  await tx.workerDeliveryAlarmEpisode.delete({ where: { workerId: active.workerId } });
  return resumed;
}

/** One active worker episode; covering marks or R62 lifecycle closure, immediate aged successor. */
export async function reconcileDeliveryAlarm(tx: Tx, input: DeliveryAlarmInput): Promise<{ raised: string | null; resumed: string | null }> {
  const { workerId, now } = input;
  const safeId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : fail('DELIVERY_METADATA_INVALID');
  const chain = await deliveryAlarmChain(tx, workerId);
  const principal = input.mark ? (p => p.kind === 'worker' ? { kind: p.kind, workerId: safeId(p.workerId) } : p.kind === 'user' ? { kind: p.kind, userId: safeId(p.userId) } : { kind: p.kind, appKeyId: safeId(p.appKeyId), hostId: safeId(p.hostId) })(input.mark.principal) : null;
  const worker = await tx.worker.findUniqueOrThrow({ where: { id: workerId }, select: { appId: true } });
  const { stuckWindowSeconds } = await loadDeliverySettings(tx, worker.appId);
  if (input.candidates.some(m => m.workerId !== workerId)) fail('DELIVERY_WORKER_MISMATCH');
  let active = await tx.workerDeliveryAlarmEpisode.findUnique({ where: { workerId } });
  let resumed = active ? await closeRetiredChannelAlarm(tx, worker.appId, active, now) : null;
  if (resumed) active = null;
  let coveredThrough = -1;
  if (input.mark) {
    const mark = input.mark;
    const delivered = await tx.workerDeliveryChannel.findUnique({ where: { workerId_channelId: { workerId, channelId: mark.channelId } } });
    const channel = await tx.channel.findUnique({ where: { id: mark.channelId }, select: { incarnation: true } });
    const read = channel?.incarnation === mark.channelIncarnation ? await tx.channelReadState.findFirst({ where: { workerId, channelId: mark.channelId } }) : null;
    coveredThrough = Math.max(delivered?.channelIncarnation === mark.channelIncarnation ? delivered.deliveredThroughSeq : -1, read?.lastSeenSeq ?? -1);
    if (mark.throughSeq > coveredThrough) fail('DELIVERY_MARK_NOT_COMMITTED');
    coveredThrough = Math.min(coveredThrough, mark.throughSeq);
    if (active && active.channelId === mark.channelId && active.channelIncarnation === mark.channelIncarnation && active.anchorSeq <= coveredThrough) {
      resumed = await appendDeliveryResumedEvent(tx, { appId: worker.appId, workerId, episodeId: active.episodeId,
        channelId: active.channelId, channelIncarnation: active.channelIncarnation, throughSeq: coveredThrough,
        principal: principal as DeliveryMarkPrincipal, now });
      await tx.workerDeliveryAlarmEpisode.delete({ where: { workerId } });
      active = null;
    }
  }
  if (active) return { raised: null, resumed };
  const liveChannels = await tx.channel.findMany({ where: { id: { in: [...new Set(input.candidates.map(m => m.channelId))] }, deletedAt: null }, select: { id: true, incarnation: true } });
  const current = new Map(liveChannels.map(c => [c.id, c.incarnation]));
  const candidates = input.candidates.filter(m => current.get(m.channelId) === m.channelIncarnation && !(input.mark && m.channelId === input.mark.channelId && m.channelIncarnation === input.mark.channelIncarnation && m.seq <= coveredThrough));
  if (!candidates.length) return { raised: null, resumed };
  const oldestDueAt = new Date(candidates.reduce((oldest, m) => Math.min(oldest, m.dueSince.getTime()), now.getTime()));
  const { state, exceptions } = await waitInputs(tx, workerId, now, oldestDueAt);
  const classified: DeliveryMessage[] = [];
  for (const candidate of candidates) classified.push(await classifyStandby(tx, candidate, exceptions, state, now, input.standbyClassifier));
  const selected = oldestStuckMessage(classified, exceptions, state, now, stuckWindowSeconds);
  if (!selected) return { raised: null, resumed };
  if (input.hold?.terminalId && !/^term_[A-Za-z0-9_-]{1,128}$/.test(input.hold.terminalId)) fail('DELIVERY_TERMINAL_INVALID');
  const episodeId = generateId(), eventId = generateId();
  const m = selected.message;
  await appendDeliveryStuckEvent(tx, { id: eventId, appId: worker.appId, workerId, episodeId,
    channelId: m.channelId, channelIncarnation: m.channelIncarnation, firstPendingSeq: m.seq,
    dueSince: m.dueSince, windowSeconds: stuckWindowSeconds,
    reason: input.hold?.reason ?? null, terminalId: input.hold?.terminalId ?? null,
    chain: chain as AlarmChain, now });
  await tx.workerDeliveryAlarmEpisode.create({ data: { workerId, episodeId, channelId: m.channelId, channelIncarnation: m.channelIncarnation, anchorSeq: m.seq, dueSince: m.dueSince, alarmEventId: eventId, createdAt: now } });
  if (chain.length) {
    await tx.agentTeamAlarmSchedule.createMany({ data: chain.map((_, chainIndex) => ({ eventId, chainIndex, dueAt: now, wokenAt: chainIndex === 0 ? now : null, deliveryWaitBaselineMs: chainIndex === 1 ? BigInt(selected.waitedMs) : null })) });
  }
  return { raised: eventId, resumed };
}

/** Delivery alarms do not participate in the task evaluator's wall-clock escalation. */
export async function advanceDeliveryEscalation(tx: Tx, workerId: string, now: Date, classifier?: StandbyCoverageClassifier): Promise<boolean> {
  const active = await tx.workerDeliveryAlarmEpisode.findUnique({ where: { workerId } });
  if (!active) return false;
  const worker = await tx.worker.findUniqueOrThrow({ where: { id: workerId }, select: { appId: true } });
  if (await closeRetiredChannelAlarm(tx, worker.appId, active, now)) return false;
  const { stuckWindowSeconds } = await loadDeliverySettings(tx, worker.appId);
  const [event] = await tx.$queryRaw<{ acknowledgedAt: Date | null }[]>`
    SELECT acknowledged_at AS "acknowledgedAt" FROM agent_team_events WHERE id = ${active.alarmEventId} FOR SHARE`;
  if (!event || event.acknowledgedAt) return false;
  const next = await tx.agentTeamAlarmSchedule.findFirst({ where: { eventId: active.alarmEventId, wokenAt: null }, orderBy: { chainIndex: 'asc' } });
  if (!next || next.deliveryWaitBaselineMs === null) return false;
  const wait = await loadDeliveryWait(tx, { workerId, channelId: active.channelId, channelIncarnation: active.channelIncarnation, seq: active.anchorSeq, dueSince: active.dueSince }, now, classifier);
  if (!nextDeliveryOwnerDue(wait, Number(next.deliveryWaitBaselineMs), stuckWindowSeconds, false)) return false;
  const changed = await tx.agentTeamAlarmSchedule.updateMany({ where: { eventId: active.alarmEventId, chainIndex: next.chainIndex, wokenAt: null }, data: { wokenAt: now } });
  if (!changed.count) return false;
  await tx.agentTeamAlarmSchedule.updateMany({ where: { eventId: active.alarmEventId, chainIndex: next.chainIndex + 1, wokenAt: null }, data: { deliveryWaitBaselineMs: BigInt(wait.waitedMs) } });
  return true;
}

/** S13's read seam: return safe currentness/wait only, never the raw coverage ledger. */
export async function deliveryAlarmSnapshot(tx: Tx, workerId: string, asOf: Date, classifier?: StandbyCoverageClassifier) {
  const active = await tx.workerDeliveryAlarmEpisode.findUnique({ where: { workerId } });
  if (!active || !(await channelStillCurrent(tx, active.channelId, active.channelIncarnation))) return null;
  if (active.anchorSeq <= await deliveryCoveredThrough(tx, workerId, active.channelId, active.channelIncarnation)) return null;
  const wait = await loadDeliveryWait(tx, { workerId, channelId: active.channelId, channelIncarnation: active.channelIncarnation, seq: active.anchorSeq, dueSince: active.dueSince }, asOf, classifier);
  const event = await tx.agentTeamEvent.findUniqueOrThrow({ where: { id: active.alarmEventId }, select: { acknowledgedAt: true, acknowledgedByWorkerId: true, acknowledgedByUserId: true } });
  return { episodeId: active.episodeId, eventId: active.alarmEventId, channelId: active.channelId, channelIncarnation: active.channelIncarnation, firstPendingSeq: active.anchorSeq, waitedMs: wait.waitedMs, waitAsOf: asOf, state: wait.suppressed ? 'SUPPRESSED' as const : 'ACTIVE' as const, acknowledgedAt: event.acknowledgedAt, acknowledgedBy: event.acknowledgedByWorkerId ? { kind: 'worker' as const, workerId: event.acknowledgedByWorkerId } : event.acknowledgedByUserId ? { kind: 'user' as const, userId: event.acknowledgedByUserId } : null };
}
