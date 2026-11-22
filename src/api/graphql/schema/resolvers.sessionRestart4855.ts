/**
 * #4855 (cor:agt:070:08 S4a; Holger, 2026-11-22; cor:acl:140:02): the door of the dark-session restart. The rule, the order of the
 * locks and the end are in src/lib/hostOperations/darkRestart.ts; this file is the caller's resolution and the transaction.
 *
 * `restartWorkerSession` — who may call: a worker, through its own bound session, holding a live `worker.session.restart` grant a
 * person who manages the App signed, naming the target (cor:acl:140:02, no wildcard). Nobody else. A caller who is no participant of the
 * App (a stranger, a run, an App key: no task door resolves one as an actor) gets APP_NOT_FOUND, as at every task door; a participant
 * who is not that worker, and a worker with no such grant for this target, get the one refusal RESTART_GRANT_REQUIRED, whatever the
 * target's state is. No role is named, no flag designates anyone: the signed grant is the whole of the authority.
 */

import type { Context } from './resolvers.helpers.js';
import { inTaskWriteTx, requireWritable, resolveParticipatedApp, resolveTaskWorkerId, taskError } from './resolvers.agentTask.js';
import { LaunchRefusal } from '../../../lib/hostOperations/launch.js';
import { restartDarkSession, restartGrantRequired, type RestartActor, type RestartResult } from '../../../lib/hostOperations/darkRestart.js';
import { workerBoundActor } from '../../../lib/grants/triggerGrant.js';
import { restartGrantHeld } from '../../../lib/hostOperations/darkRestart.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { afterWaits, anchorNow, coveringSignals } from '../../../lib/stopSignals/state.js';
import { GraphQLError } from 'graphql';

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const REASON_MAX = 500;

type RestartInput = { appRef: string; worker: string; reason: string };

export const sessionRestartMutations = {
  restartWorkerSession: async (_: unknown, { input }: { input: RestartInput }, ctx: Context): Promise<RestartResult> => {
    if (!input) throw badInput('input is required.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '') throw badInput('reason is required: say what you tried and why this session is dark.');
    if (reason.length > REASON_MAX) throw badInput(`reason is at most ${REASON_MAX} characters.`);
    const { app, actor } = await resolveParticipatedApp(ctx, input.appRef);
    requireWritable(ctx, app);
    // Only a worker acts here, through the session it is bound to; every other caller is the one refusal, before any target is read.
    if (actor.kind !== 'worker') throw restartGrantRequired();
    const bound = await workerBoundActor(ctx);
    if (!bound || bound.workerId !== actor.workerId) throw restartGrantRequired();
    const who: RestartActor = {
      workerId: actor.workerId, sessionId: bound.sessionId, hostLaunched: bound.hostLaunched, userId: actor.userId, agentId: actor.agentId,
    };
    // The target resolves inside the actor's own App only; a name that is none is the same refusal as a missing grant (no oracle).
    const workerId = await resolveTaskWorkerId(ctx, app.id, input.worker);
    if (!workerId) throw restartGrantRequired();
    // Authority before any lock: a worker without a covering grant takes no assignment lock on the target (it could otherwise make
    // other writers wait on any worker of its App). Unlocked and read-only; the library judges again under the locks.
    if (!(await restartGrantHeld(ctx.db, { appId: app.id, workerId, actorWorkerId: actor.workerId, hostLaunched: bound.hostLaunched }))) throw restartGrantRequired();
    const now = new Date();
    const anchor = anchorNow();
    let result: RestartResult;
    try {
      // lockWorkerIds are locked in id order, once (workerLock.ts), so two workers restarting each other take the same lock first.
      result = await inTaskWriteTx(ctx, app, actor, () => restartGrantRequired(), (tx, _txCtx, freshApp) =>
        restartDarkSession(tx, { appId: freshApp.id, workerId, actor: who, now }, async () => {
          // Under a team pause or a stop signal the platform starts nobody (launchForAssignment's two refusals): so not here either.
          const [state] = await tx.$queryRaw<{ teamPausedAt: Date | null }[]>`SELECT team_paused_at AS "teamPausedAt" FROM apps WHERE id = ${freshApp.id}`;
          if (state?.teamPausedAt) throw taskError('TEAM_PAUSED', 'The team is paused, so the platform starts nobody; the session was not ended.');
          if ((await coveringSignals(tx, freshApp.id, [workerId], afterWaits(now, anchor))).has(workerId)) {
            throw taskError('WORKER_STOPPED', 'A stop signal covers this worker, so it is not started; its session was not ended.');
          }
        }), { stopFence: 'shared', lockWorkerIds: [workerId, actor.workerId] });
    } catch (e) {
      if (e instanceof LaunchRefusal) throw taskError(e.code, e.message, { workerId });
      throw e;
    }
    const done: RestartResult = result;
    // An ended session releases its memory keys once its end is durable, as every end does.
    for (const id of done.endedSessionIds) sessionKeyCache.evict(id);
    // The audit of an end no human saw: ids and the caller's free-text reason, to the log only (no table here holds a reason, and the
    // task makes no migration). The durable record is the grant's USE event (who, which session) and the start's issuer.
    console.info('[session-restart] dark session ended and worker started', {
      appId: app.id, workerId, operationId: done.operationId, endedSessionIds: done.endedSessionIds, taskId: done.taskId,
      by: { workerId: actor.workerId }, reason,
    });
    return done;
  },
};
