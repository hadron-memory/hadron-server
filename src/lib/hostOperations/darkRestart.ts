/**
 * #4855 (cor:agt:070:08 S4a; Holger, 2026-11-22; cor:acl:140:02) — the worker dedicated to manage agents ends a DARK open session of a
 * named worker and starts that worker again, in one transaction, with no person in the loop, under a person-signed
 * `worker.session.restart` grant.
 *
 * WHO MAY. Only a worker, through its own session, and only under a live grant a person who manages the App signed, held by that worker
 * itself (never its role agent), naming the target worker (a list, never a wildcard). No table, flag or role designates the holder:
 * the grant IS the authority, so it is given once, signed, and revocable by the ways every grant ends. A person, a run, an App key
 * or an impersonation is not that worker and is refused by the same single refusal. Authority is judged BEFORE anything is read about the
 * target, so a caller without the grant learns nothing of a target's session, hold or host.
 *
 * WHO DECIDES DARK. Not the server and not an assignment. "An open session is never started over" stays true for a QUIET session (S4;
 * silence is not abandonment, #1114, ruling 0265 V16-V19): `launchForAssignment` never ends a session. The holder of the grant says a
 * session is dark by calling this door; the platform's part is the fence around the call: a LIVE session is refused (one driven recently is
 * certainly not dark), nothing is ended unless the start can be issued (one transaction, so a refused start leaves the session open), and
 * the end and the start are one act under the target's lock, so a restart and a fresh assignment cannot both launch the worker.
 *
 * THE ORDER (the start's own, launch.ts): the caller's transaction holds the App's authority anchors, the stop fence and the target's
 * assignment lock; the actor's worker row FOR SHARE; then the target row FOR UPDATE (`lockStartableWorker`, refusing a live session, an
 * unheld or retired worker and a start already in flight); then the host decision's fence (`fenceHostDecision`); then the open session
 * rows FOR UPDATE; the covering grant rows FOR UPDATE as the act's LAST lock (cover.ts), judged on the database clock; then the end, the
 * spend (one `use_count + 1`, one USE event) and the start. A refusal anywhere rolls the whole act back and spends nothing.
 *
 * THE END: `endedAt` now, `endReason: ended` (no new reason: the audit of who ended it is the grant's USE event and the start's issuer),
 * no handoff written (the next bind reads continuity MISSING, cor:agt:020:10). The start names the issuing worker and carries the target's
 * oldest open task, if any; the host collects it and the holder's agent binds as for any start.
 */

import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { coverableAction, findCoveringGrants, spendGrant } from '../grants/cover.js';
import { sessionMayUseGrant } from '../grants/triggerGrant.js';
import { fenceHostDecision, insertWorkerStart, LaunchRefusal, lockStartableWorker, planStart } from './launch.js';

export type RestartResult = { operationId: string; hostId: string; taskId: string | null; endedSessionIds: string[] };

/** The worker acting, through its own session (judged by the caller from the bound session; a person or a run is never one). */
export type RestartActor = { workerId: string; sessionId: string | null; hostLaunched: boolean; userId: string | null; agentId: string | null };

const REFUSAL_MESSAGE = 'A worker needs a signed grant from a person who manages the App to restart another worker\'s session.';

/**
 * The ONE refusal for every authority miss: no grant, pending, revoked, spent, expired, another worker's or another App's grant, a target the
 * grant does not name, a target that is not a worker of this App, a caller that is not a worker. Fixed text naming nothing.
 */
export function restartGrantRequired(): GraphQLError {
  return new GraphQLError(REFUSAL_MESSAGE, { extensions: { code: 'RESTART_GRANT_REQUIRED' } });
}

/**
 * Whether a live grant covers this actor's restart of `workerId` (unlocked, read-only; the door's gate before it takes any lock, and the
 * library's own first judgement). The actor is the worker itself, never its role agent (the action's reach).
 */
export async function restartGrantHeld(
  db: Prisma.TransactionClient | PrismaClient,
  a: { appId: string; workerId: string; actorWorkerId: string; hostLaunched: boolean },
): Promise<boolean> {
  if (a.actorWorkerId === a.workerId) return false;
  const found = await findCoveringGrants(db, {
    appId: a.appId, action: coverableAction('worker.session.restart'), workerId: a.actorWorkerId, values: { worker: a.workerId }, order: 'CAPPED_FIRST',
  });
  return found.some((g) => sessionMayUseGrant(g.maxUses, a.hostLaunched));
}

/**
 * End `workerId`'s open sessions and issue its start, in the caller's transaction (which holds the authority anchors, the stop fence and the
 * target's assignment lock). Throws {@link restartGrantRequired} (authority, before anything of the target is read) or {@link LaunchRefusal}
 * (`WORKER_NOT_FOUND`, `WORKER_RETIRED`, `WORKER_NOT_HELD`, `WORKER_LIVE`, `WORKER_START_PENDING`, `NO_OPEN_SESSION`, `NO_LIVE_HOST`), which
 * rolls the caller's transaction back.
 */
export async function restartDarkSession(
  tx: Prisma.TransactionClient,
  a: { appId: string; workerId: string; actor: RestartActor; now: Date },
  /** Refusals that are the platform's start fence (team pause, stop signal), run once authority is shown and before anything is written. */
  startFence: () => Promise<void> = async () => {},
): Promise<RestartResult> {
  const action = coverableAction('worker.session.restart');
  // The actor: a live worker of this App. FOR SHARE, so a retirement that committed is seen and one that comes next waits.
  const [me] = await tx.$queryRaw<Array<{ app_id: string; retired_at: Date | null }>>`
    SELECT app_id, retired_at FROM workers WHERE id = ${a.actor.workerId} FOR SHARE`;
  if (!me || me.app_id !== a.appId || me.retired_at !== null || a.actor.workerId === a.workerId) throw restartGrantRequired();
  // Authority first, unlocked: a caller whose grant does not cover this target learns nothing about the target.
  const covers = (lock: 'UPDATE') => findCoveringGrants(tx, {
    appId: a.appId, action, workerId: a.actor.workerId, values: { worker: a.workerId }, order: 'CAPPED_FIRST', lock,
  });
  if (!(await restartGrantHeld(tx, { appId: a.appId, workerId: a.workerId, actorWorkerId: a.actor.workerId, hostLaunched: a.actor.hostLaunched }))) throw restartGrantRequired();

  await startFence();
  // The live test, not the open one: a LIVE session is never dark and is refused here; a quiet open one is the case.
  const hold = await lockStartableWorker(tx, a.appId, a.workerId, a.now, 'live');
  await fenceHostDecision(tx, a.appId);
  const open = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM sessions
    WHERE worker_id = ${a.workerId} AND app_id = ${a.appId} AND ended_at IS NULL AND deleted_at IS NULL
    ORDER BY id FOR UPDATE`;
  if (open.length === 0) throw new LaunchRefusal('NO_OPEN_SESSION', 'This worker has no open session, so there is nothing to restart.');
  // The host and settings are decided BEFORE anything is written: no live host lists the worker, nothing is ended and nothing is spent.
  const task = await tx.agentTask.findFirst({
    where: { appId: a.appId, assigneeWorkerId: a.workerId, status: { in: ['pending', 'started'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const plan = await planStart(tx, { appId: a.appId, workerId: a.workerId, taskId: task?.id ?? null, now: a.now });
  if (!plan) throw new LaunchRefusal('NO_LIVE_HOST', 'No live host registers this worker with a worktree, so it cannot be started; its session was not ended.');

  // The grant rows, FOR UPDATE, as the act's LAST lock, judged again on the database clock; then the spend. A miss is the one refusal.
  const locked = (await covers('UPDATE')).filter((g) => sessionMayUseGrant(g.maxUses, a.actor.hostLaunched));
  if (locked.length === 0) throw restartGrantRequired();
  await spendGrant(tx, locked[0]!.id, { appId: a.appId, workerId: a.actor.workerId, sessionId: a.actor.sessionId }, restartGrantRequired);

  const endedSessionIds = open.map((s) => s.id);
  await tx.session.updateMany({ where: { id: { in: endedSessionIds }, endedAt: null }, data: { endedAt: a.now, endReason: 'ended' } });
  const operationId = await insertWorkerStart(tx, {
    appId: a.appId, hostId: plan.reg.hostId, workerId: a.workerId, worktree: plan.reg.worktrees[0]!, family: plan.reg.family,
    profile: plan.reg.profile, settings: plan.settings, taskId: task?.id ?? null,
    issuer: { issuedBy: 'worker', issuedByUserId: a.actor.userId, issuedByWorkerId: a.actor.workerId, issuedByAgentId: a.actor.agentId },
    hold,
  });
  return { operationId, hostId: plan.reg.hostId, taskId: task?.id ?? null, endedSessionIds };
}
