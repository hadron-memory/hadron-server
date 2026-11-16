/**
 * #4292 (S15 of the Team on Orca epic, #4229) — the host ends an open session of a SHORT_LIVED worker it runs, after
 * proving that no agent runs (the closed reason AGENT_ABSENT). A third explicit end besides the worker's own and the
 * end-session host operation (cor:agt:050:10, Proposed amendment; cross-referenced from 070:05). Holger's C9 ruling
 * (hrn:node:hadronmemory.com:hadron-business:decisions:run-settings-are-not-worker-identity): the same for an
 * interactive short-lived session; the agent ending its own session stays the fast path, the host is the backstop.
 * Whether the agent was interactive or headless is the host's concern when it proves absence; here it is one worker.
 *
 * ONE FUNCTION, TWO ENTRY POINTS: a `worker.end` reported FAILED with AGENT_ABSENT (reportHostOperation), and the
 * host's own `endAgentlessSession`, so the two cannot drift.
 *
 * THE CONDITIONS, judged under the locks:
 *  - the reporting host runs the worker: its registration lists the worker and, under a server-held setup, the
 *    worker is assigned to that host with its workdir confirmed (the launch readers' ASSIGNMENT_IN_EFFECT);
 *  - the session runs on that host: a host-launched session names it as its launch host; for a hand-started one it is
 *    the worker's sole live registration (#4294 §10, Rook P2-1; Peter's ruling, team chat #110707);
 *  - the worker's Agent is SHORT_LIVED (the Agent its open session was bound under, as #4223 reads it);
 *  - the worker is the assignee of no PENDING or STARTED task. A task waiting on its open children is STARTED, so
 *    050:10's G7 is covered.
 *
 * THE LOCK ORDER (src/lib/agentTasks/workerLock.ts): the per-worker assignment lock FIRST, which every assignment,
 * start and bind takes; then the App's host-lapse lock SHARED with its count; then the session row FOR UPDATE; then the App's host-setup lock SHARED and every registration
 * of the App FOR SHARE in id order (resolveSessionEndRequest's order: session, then registrations); then the reads. An
 * assignment to this worker either committed before the lock (the open-task check sees it and refuses) or waits until
 * this transaction ends (it then finds no open session and the ordinary start path runs).
 *
 * THE END: `endedAt` now, `endReason: agent_absent`; this end writes no handoff (the result's `handoff` says whether
 * one the worker wrote before it exited names the session). Without one, the next bind reads continuity MISSING (cor:agt:020:10,
 * "no handoff was recorded"), never an empty handoff. A session that already ended is left exactly as it is.
 */

import { Prisma } from '../../generated/prisma/index.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { lockAppLapseCheckIns } from '../agentTasks/hosts.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { ASSIGNMENT_IN_EFFECT, lockHostSetup } from './assignments.js';
import { workerLifecycle } from './sessionEnd.js';
import { sessionHasHandoff } from './settle.js';

/** The closed proof a host gives that no agent runs in the worker's worktree. */
export const AGENT_ABSENT = 'AGENT_ABSENT';

/**
 * Does a host's free-text failure reason carry the closed proof? Its leading code, up to whitespace or a colon, is
 * exactly AGENT_ABSENT (the context reset's convention for a coded failure reason). Anything else is free text.
 */
export const isAgentAbsentReason = (reason: string | null | undefined): boolean =>
  ((reason ?? '').split(/[\s:]/, 1)[0] ?? '') === AGENT_ABSENT;

export type AgentlessEndRefusalCode = 'HOST_DOES_NOT_RUN_WORKER' | 'SESSION_NOT_WORKERS' | 'WORKER_NOT_SHORT_LIVED' | 'WORKER_HAS_OPEN_TASK';

/** A condition was not met; nothing was written. `taskId` names the open task for WORKER_HAS_OPEN_TASK. */
export class AgentlessEndRefusal extends Error {
  constructor(readonly code: AgentlessEndRefusalCode, message: string, readonly taskId?: string) {
    super(message);
    this.name = 'AgentlessEndRefusal';
  }
}

/**
 * End `sessionId` of `workerId` on the host's proof, in the caller's transaction (which holds the App's authority
 * anchor shared and has re-checked the host key). Returns `ended: true` when this call ended it, `ended: false` when it
 * had already ended (nothing written), and whether a handoff names it. Throws {@link AgentlessEndRefusal}.
 */
export async function endAgentlessSession(
  tx: Prisma.TransactionClient,
  args: { appId: string; hostId: string; workerId: string; sessionId: string; now: Date },
): Promise<{ ended: boolean; handoff: boolean }> {
  const { appId, hostId, workerId, sessionId, now } = args;
  await lockWorkersForAssignment(tx, [workerId]);
  // The App's host-lapse count, held shared until this ends (the start path's order: worker, then lapse; the session-end
  // sweep's: lapse, then session, then registrations), for the sole-live-registration read below.
  const checkIns = await lockAppLapseCheckIns(tx, appId);
  const [session] = await tx.$queryRaw<{
    workerId: string | null; appId: string | null; endedAt: Date | null; deletedAt: Date | null; launchHostId: string | null;
  }[]>`
    SELECT worker_id AS "workerId", app_id AS "appId", ended_at AS "endedAt", deleted_at AS "deletedAt",
      launch_host_id AS "launchHostId"
    FROM sessions WHERE id = ${sessionId} FOR UPDATE`;
  await lockHostSetup(tx, appId, 'shared');
  // Every registration of the App, in id order (pickLiveHost's and fenceHostDecision's lock): the sole-host test below
  // reads them all, so a registration that would add or drop the worker waits for this decision.
  await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${appId} ORDER BY id FOR SHARE`;
  const [reg] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM host_registrations WHERE app_id = ${appId} AND host_id = ${hostId}`;
  const runs = reg
    ? await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM host_registrations r
        JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${workerId}
        JOIN workers wk ON wk.id = w.worker_id AND wk.app_id = r.app_id
        JOIN apps a ON a.id = r.app_id
        LEFT JOIN host_worker_assignments ha
          ON a.host_setup_source = 'server' AND ha.app_id = r.app_id AND ha.host_id = r.host_id AND ha.worker_id = w.worker_id
        WHERE r.id = ${reg.id} AND ${ASSIGNMENT_IN_EFFECT}`
    : [];
  if (runs.length === 0) {
    throw new AgentlessEndRefusal('HOST_DOES_NOT_RUN_WORKER', 'This host does not run that worker.');
  }
  if (!session || session.workerId !== workerId || session.appId !== appId || session.deletedAt) {
    throw new AgentlessEndRefusal('SESSION_NOT_WORKERS', 'That session is not this worker\'s.');
  }
  // #4294 §10 (Rook P2-1; Peter's ruling, team chat #110707): a worker may be registered by several hosts, and a host's
  // proof covers only its own machine. A session started by a launch operation is ended only by that operation's host;
  // a hand-started one (an interactive session, C9) only by the worker's sole live registration. Otherwise refused as
  // not running the worker, so no oracle.
  if (!(await sessionRunsOn(tx, { appId, workerId, hostId, now, checkIns }, session))) {
    throw new AgentlessEndRefusal('HOST_DOES_NOT_RUN_WORKER', 'This host does not run that worker.');
  }
  if (session.endedAt) {
    return { ended: false, handoff: await sessionHasHandoff(tx, workerId, sessionId) };
  }
  const { shortLived } = await workerLifecycle(tx, workerId);
  if (!shortLived) {
    throw new AgentlessEndRefusal('WORKER_NOT_SHORT_LIVED', 'Only a short-lived worker\'s session is ended on a host\'s proof that no agent runs.');
  }
  const open = await tx.agentTask.findFirst({
    where: { assigneeWorkerId: workerId, status: { in: ['pending', 'started'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (open) {
    throw new AgentlessEndRefusal('WORKER_HAS_OPEN_TASK', 'The worker is the assignee of an open task, so its session stays open.', open.id);
  }
  await tx.session.updateMany({ where: { id: sessionId, endedAt: null }, data: { endedAt: now, endReason: 'agent_absent' } });
  return { ended: true, handoff: await sessionHasHandoff(tx, workerId, sessionId) };
}

/**
 * Does the session run on `hostId`? A host-launched session: exactly when its launch host is this host. A hand-started
 * one: when this host is the worker's sole live registration in the App (refreshed within the lapse window, as
 * pickLiveHost and liveRegistrationsFor read it). The caller holds the lapse count and every registration FOR SHARE.
 */
async function sessionRunsOn(
  tx: Prisma.TransactionClient,
  at: { appId: string; workerId: string; hostId: string; now: Date; checkIns: number },
  session: { launchHostId: string | null },
): Promise<boolean> {
  if (session.launchHostId !== null) return session.launchHostId === at.hostId;
  const hosts = await tx.$queryRaw<{ hostId: string }[]>`
    SELECT DISTINCT r.host_id AS "hostId" FROM host_registrations r
    JOIN host_registration_workers w ON w.registration_id = r.id AND w.worker_id = ${at.workerId}
    WHERE r.app_id = ${at.appId}
      AND r.refreshed_at + make_interval(secs => r.poll_interval_seconds * ${at.checkIns}) >= ${toNaiveUtc(at.now)}::timestamp`;
  return hosts.length === 1 && hosts[0]!.hostId === at.hostId;
}
