// #2138 §1/§3.3/§3.4 — which workers are NOT expected to check their team channel right now, and why.
//
// One source for the ticker's `live-check` rule (never due for a PENDING worker) and the roster status
// (PENDING + reason): a worker is PENDING when it has no task, is in standby, is isolated or paused, its App
// is under a team pause, or (#2022) a `pause` or `halt` stop signal covers it, which stops its ticks (R68). A worker HAS a task when a Hadron task assigned to it is pending or started, or when its
// Agent has `usesTasks: false`. Pure reads; the caller supplies `now`.

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { coveringSignals, timeStoppedWorkers } from '../stopSignals/state.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type PendingReason = 'NO_TASK' | 'STANDBY' | 'ISOLATED' | 'PAUSED' | 'TEAM_PAUSED' | 'STOPPED';

/** Precedence when several apply: a team pause, a stop signal, the worker's own pause, isolation, standby, no task. */
export async function loadPendingReasons(db: Db, appId: string, workerIds: string[], now: Date): Promise<Map<string, PendingReason | null>> {
  const out = new Map<string, PendingReason | null>();
  if (workerIds.length === 0) return out;
  const [app, workers, settings, open] = await Promise.all([
    db.app.findUnique({ where: { id: appId }, select: { teamPausedAt: true } }),
    db.worker.findMany({ where: { id: { in: workerIds }, appId }, select: { id: true, agent: { select: { usesTasks: true } } } }),
    db.workerWakeSettings.findMany({ where: { workerId: { in: workerIds } }, select: { workerId: true, pausedUntil: true, isolatedUntil: true } }),
    db.agentTask.findMany({
      where: { appId, assigneeWorkerId: { in: workerIds }, status: { in: ['pending', 'started'] } },
      select: { assigneeWorkerId: true },
      distinct: ['assigneeWorkerId'],
    }),
  ]);
  const stopped = timeStoppedWorkers(await coveringSignals(db, appId, workerIds, now));
  const settingOf = new Map(settings.map((s) => [s.workerId, s]));
  const hasOpenTask = new Set(open.map((t) => t.assigneeWorkerId));
  const t = now.getTime();
  for (const w of workers) {
    const s = settingOf.get(w.id);
    let reason: PendingReason | null = null;
    if (app?.teamPausedAt) reason = 'TEAM_PAUSED';
    else if (stopped.has(w.id)) reason = 'STOPPED';
    else if (s?.pausedUntil && s.pausedUntil.getTime() > t) reason = 'PAUSED';
    else if (s?.isolatedUntil && s.isolatedUntil.getTime() > t) reason = 'ISOLATED';
    // STANDBY: not built (deliveryStandbyEnabled is refused), so it is unreachable here; it is a reason in the type for the roster.
    else if (w.agent.usesTasks !== false && !hasOpenTask.has(w.id)) reason = 'NO_TASK';
    out.set(w.id, reason);
  }
  return out;
}
