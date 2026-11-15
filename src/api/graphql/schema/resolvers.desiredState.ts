/**
 * #4224 (S3 of the Team on Orca epic, #4229) — the GraphQL surface of the desired state: the per-host read, the
 * leave-alone marker and the App's sweep mode. The rule itself is src/lib/desiredState/desiredState.ts.
 *
 * WHO READS `hostDesiredState`: whoever reads the App's tasks and events (cor:agt:050:21: a participant, the App's
 * own key), and a host key for ITS OWN host only. A key that holds, or ever held, `host:operate` reads no other
 * host: the answer for another host is the answer for a host that does not exist, so it is no oracle for which
 * hosts the App has (the cor:agt:070:04 rule that a host sees only its own; the sentence that adds this read to
 * that rule is drafted in S5, #4226). A host key's read is a recorded use (cor:agt:070:07).
 *
 * WHO WRITES the marker and the mode: whoever manages the App, as themselves or through their held worker's
 * instruction (cor:dmo:050:12), like the team pause. No App key writes either.
 */

import type { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import {
  actorManagesApp, inTaskWriteTx, recordInstructedManagerAct, requireWritable, resolveParticipatedApp, taskError,
  withInstruction, withReadableApp,
} from './resolvers.agentTask.js';
import { resolveAvailabilityWorker } from './resolvers.agentTaskAlarms.js';
import { recordingRefusal } from './resolvers.hostOperation.js';
import { writeInApp } from './resolvers.ticker.js';
import { maySeeWorkerInternals } from './resolvers.worker.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import { appendLeaveAloneChangedEvent, appendSweepModeChangedEvent, eventActor } from '../../../lib/agentTasks/events.js';
import { keyEverHeldHostOperate, keyHostId, recordHostKeyUseApart } from '../../../lib/hostOperations/hostKey.js';
import { loadHostDesiredState, SWEEP_MODES, type SweepMode } from '../../../lib/desiredState/desiredState.js';

/** The longest leave-alone reason, after trimming. */
export const LEAVE_ALONE_REASON_MAX = 500;

const badInput = (message: string): GraphQLError => taskError('BAD_USER_INPUT', message);
const workerNotFound = (ref: string): GraphQLError => taskError('WORKER_NOT_FOUND', 'Worker not found.', { ref });
/** One answer for a host the App does not have and for a host the calling host key is not. */
const hostNotFound = (hostId: string): GraphQLError =>
  taskError('HOST_NOT_FOUND', 'No host with that id is registered in this App.', { hostId });

export const desiredStateQueries = {
  /** The desired state of every worker one host runs (see the file header for who reads it). */
  hostDesiredState: (_: unknown, a: { appRef: string; hostId: string }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const hostId = typeof a.hostId === 'string' ? a.hostId.trim() : '';
      const out = await withReadableApp(ctx, a.appRef, async (c, app) => {
        const key = appKeyCaller(c);
        // A host key, live or revoked, reads its own live host and nothing else. Decided before the host is looked
        // up, so a foreign host and a missing one cannot be told apart.
        if (key && (await keyEverHeldHostOperate(c.db, key.appKeyId)) && (await keyHostId(c.db, key)) !== hostId) {
          throw hostNotFound(hostId);
        }
        const state = hostId ? await loadHostDesiredState(c.db, app.id, hostId, new Date()) : null;
        if (!state) throw hostNotFound(hostId);
        return state;
      });
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: out.workers.length });
      return out;
    }),
};

type LeaveAloneInput = { worker: string; appRef?: string | null; leaveAlone: boolean; reason?: string | null };

export const desiredStateMutations = {
  /**
   * Set or clear a worker's leave-alone marker: whoever manages the App. A change writes the marker, its reason,
   * who set it and when together, and one `worker.leave-alone-changed` event; a call that changes nothing writes
   * and records nothing. Every refusal is judged before the write.
   */
  setWorkerLeaveAlone: async (
    _: unknown,
    { input, instruction }: { input: LeaveAloneInput; instruction?: ActInstruction | null },
    ctx: Context,
  ) => {
    if (!input || typeof input.leaveAlone !== 'boolean') throw badInput('input.leaveAlone is required.');
    const reason = typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null;
    if (reason && !input.leaveAlone) throw badInput('A reason is given only when marking a worker leave-alone.');
    if (reason && reason.length > LEAVE_ALONE_REASON_MAX) throw badInput(`A leave-alone reason is at most ${LEAVE_ALONE_REASON_MAX} characters.`);
    const resolved = await resolveAvailabilityWorker(ctx, input.worker, input.appRef);
    const { workerId, app } = resolved;
    const actor = withInstruction(resolved.actor, instruction);
    requireWritable(ctx, app);
    return inTaskWriteTx(ctx, app, actor, () => workerNotFound(input.worker), async (tx, txCtx, fresh) => {
      if (!(await actorManagesApp(txCtx, fresh, actor, actor.instructed))) {
        throw taskError('WORKER_LEAVE_ALONE_NOT_PERMITTED', 'Only whoever manages this App marks a worker leave-alone or clears the marker.');
      }
      // The row this write changes, locked last: two writers of one marker serialize, and each judges what the other left.
      const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null; leaveAlone: boolean; reason: string | null; by: string | null; at: Date | null }[]>`
        SELECT app_id AS "appId", retired_at AS "retiredAt", leave_alone AS "leaveAlone", leave_alone_reason AS reason,
               leave_alone_by AS by, leave_alone_at AS at
        FROM workers WHERE id = ${workerId} FOR UPDATE`;
      if (!w || w.appId !== fresh.id) throw workerNotFound(input.worker);
      if (w.retiredAt) throw taskError('WORKER_RETIRED', 'This worker is retired.', { workerId });
      const view = (r: { leaveAlone: boolean; reason: string | null; by: string | null; at: Date | null }) => ({ workerId, ...r });
      // Unchanged: the marker as it is, and (when marked) the reason as it is.
      if (w.leaveAlone === input.leaveAlone && (!input.leaveAlone || w.reason === reason)) {
        return view({ leaveAlone: w.leaveAlone, reason: w.reason, by: w.by, at: w.at });
      }
      const next = input.leaveAlone
        ? { leaveAlone: true, reason, by: txCtx.userId ?? null, at: new Date() }
        : { leaveAlone: false, reason: null, by: null, at: null };
      await tx.worker.update({
        where: { id: workerId },
        data: { leaveAlone: next.leaveAlone, leaveAloneReason: next.reason, leaveAloneBy: next.by, leaveAloneAt: next.at },
      });
      // The event is the marker's history: one per change of the marker itself (a new reason alone is not one).
      if (w.leaveAlone !== next.leaveAlone) {
        await appendLeaveAloneChangedEvent(tx, { appId: fresh.id, actor: eventActor(txCtx.userId), workerId, leaveAlone: next.leaveAlone });
      }
      await recordInstructedManagerAct(tx, fresh.id, actor, 'worker.leave-alone', { workerId });
      return view(next);
    });
  },

  /**
   * Set the App's sweep mode: whoever manages the App. A change writes one `team.sweep-mode-changed` event; setting
   * the mode it already has writes and records nothing.
   */
  setAppSweepMode: async (
    _: unknown,
    { appRef, mode, instruction }: { appRef: string; mode: string; instruction?: ActInstruction | null },
    ctx: Context,
  ) => {
    if (!(SWEEP_MODES as readonly string[]).includes(mode)) throw badInput(`mode is one of ${SWEEP_MODES.join(', ')}.`);
    const to = mode as SweepMode;
    const participated = await resolveParticipatedApp(ctx, appRef);
    const { app } = participated;
    const actor = withInstruction(participated.actor, instruction);
    return writeInApp(ctx, app, actor, () => taskError('APP_NOT_FOUND', 'App not found.'), async (tx, txCtx, fresh) => {
      if (!(await actorManagesApp(txCtx, fresh, actor, actor.instructed))) {
        throw taskError('FORBIDDEN', "Only whoever manages this App can set its sweep mode.");
      }
      // writeInApp holds the App exclusively for this write, so the read and the update are one decision.
      const cur = await tx.app.findUniqueOrThrow({ where: { id: fresh.id }, select: { sweepMode: true } });
      if (cur.sweepMode !== to) {
        await tx.app.update({ where: { id: fresh.id }, data: { sweepMode: to } });
        await appendSweepModeChangedEvent(tx, { appId: fresh.id, actor: eventActor(txCtx.userId), from: cur.sweepMode, to });
        await recordInstructedManagerAct(tx, fresh.id, actor, 'app.sweep-mode');
      }
      return { sweepMode: to };
    }, { lockMode: 'exclusive' });
  },
};

type WorkerMarker = { appId: string; leaveAloneReason: string | null; leaveAloneBy: string | null };

/** The marker's reason and setter are working state, masked like `retiredBy`; the marker itself reads with the worker. */
export const desiredStateWorkerFields = {
  leaveAloneReason: async (w: WorkerMarker, _: unknown, ctx: Context) =>
    (await maySeeWorkerInternals(ctx, w.appId)) ? w.leaveAloneReason : null,
  leaveAloneBy: async (w: WorkerMarker, _: unknown, ctx: Context) =>
    (await maySeeWorkerInternals(ctx, w.appId)) ? w.leaveAloneBy : null,
};
