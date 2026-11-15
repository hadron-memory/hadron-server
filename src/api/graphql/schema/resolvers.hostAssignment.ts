// Host worker assignments — #4222 (S1a of #4229): the platform holds which workers each host of a team App runs
// (hrn:node:hadronmemory.com:specs:cor:agt:070:01; its change is drafted as Proposed in #4226). The rules, the
// switch and the lock are in src/lib/hostOperations/assignments.ts.
//
// WHO WRITES: whoever manages the App (hrn:node:hadronmemory.com:specs:cor:dmo:050:12), as a person, or a held
// worker on its holder's instruction (#3321's arm). No App key writes: a host never assigns itself a worker.
//
// WHO READS: whoever reads the App's tasks and events (a participant, or the App's own key that never held
// host:operate). A HOST KEY reads only its own host's rows: the host is the key's, and a filter naming another host
// answers exactly like a host that has no assignments, so it learns nothing about another host
// (hrn:node:hadronmemory.com:specs:cor:agt:070:04). A key whose host scope was revoked reads nothing here, as on
// the operations listing (#1894).

import { Prisma } from '../../../generated/prisma/index.js';
import type { Context } from './resolvers.helpers.js';
import {
  actorManagesApp,
  inTaskWriteTx,
  recordInstructedManagerAct,
  requireWritable,
  resolveParticipatedApp,
  resolveTaskWorkerId,
  taskError,
  withInstruction,
  withReadableApp,
  type TaskActor,
  type TaskApp,
} from './resolvers.agentTask.js';
import { appKeyCaller } from '../../../lib/appKeyScopes/scopes.js';
import type { ActInstruction } from '../../../lib/auth/instructedAct.js';
import type { ManagerAct } from '../../../lib/agentTasks/events.js';
import { matchAfterChange } from '../../../lib/agentTasks/matcher.js';
import { generateId } from '../../../lib/id.js';
import { keyEverHeldHostOperate, keyHostId, recordHostKeyUseApart } from '../../../lib/hostOperations/hostKey.js';
import {
  HostAssignmentArgsError,
  isAssignmentHostId,
  isHostSetupSource,
  loadHostAssignments,
  loadHostSetupSource,
  lockHostSetup,
  validateHostAssignment,
  type HostAssignmentRow,
  type HostSetupSource,
} from '../../../lib/hostOperations/assignments.js';
import { recordingRefusal } from './resolvers.hostOperation.js';

const appNotFound = (appRef: string) => taskError('APP_NOT_FOUND', 'App not found.', { appRef });
const badInput = (message: string) => taskError('BAD_USER_INPUT', message);
const notPermitted = () =>
  taskError('HOST_ASSIGNMENT_NOT_PERMITTED', 'Only whoever manages the App says which workers its hosts run.');

type AssignInput = {
  appRef: string; hostId: string; worker: string; workdir: string; family: string; model?: string | null;
  effort?: string | null; accountProfile?: string | null; replace?: boolean | null;
};

/**
 * A setup write: no App key; the caller participates in the App (else APP_NOT_FOUND, like every task door); then,
 * inside the write's transaction under the App's anchors, the caller manages the App (else
 * HOST_ASSIGNMENT_NOT_PERMITTED). `body` runs after that gate, before any write of its own.
 */
async function asSetupManager<T>(
  ctx: Context, appRef: string, instruction: ActInstruction | null | undefined,
  body: (tx: Prisma.TransactionClient, txCtx: Context, app: TaskApp, actor: TaskActor) => Promise<T>,
  /** `exclusive` for the one write that updates the anchored App row itself (a shared hold cannot be upgraded). */
  lockMode: 'shared' | 'exclusive' = 'shared',
): Promise<{ app: TaskApp; result: T }> {
  if (appKeyCaller(ctx)) throw notPermitted();
  const participated = await resolveParticipatedApp(ctx, appRef);
  const actor = withInstruction(participated.actor, instruction);
  requireWritable(ctx, participated.app);
  const result = await inTaskWriteTx(ctx, participated.app, actor, () => appNotFound(appRef), async (tx, txCtx, freshApp) => {
    if (!(await actorManagesApp(txCtx, freshApp, actor, actor.instructed))) throw notPermitted();
    return body(tx, txCtx, freshApp, actor);
  }, { lockMode });
  return { app: participated.app, result };
}

/** The person a setup write is made by: the request's user (a worker on instruction acts on its holder's right). */
function writer(ctx: Context): string {
  if (!ctx.userId) throw notPermitted();
  return ctx.userId;
}

const record = (tx: Prisma.TransactionClient, appId: string, actor: TaskActor, act: ManagerAct, workerId?: string) =>
  recordInstructedManagerAct(tx, appId, actor, act, workerId ? { workerId } : {});

export const hostAssignmentMutations = {
  /**
   * #4222 — assign a worker to a host of its App: the workdir it runs in there, and its launcher profile (#4230:
   * family, and optionally model, effort and accountProfile). Refusals, in order: BAD_HOST_ASSIGNMENT_ARGS (the
   * workdir or host id) or BAD_LAUNCHER_PROFILE (a profile field), both the caller's own input; HOST_ASSIGNMENT_NOT_PERMITTED,
   * WORKER_NOT_FOUND, WORKER_RETIRED, HOST_ASSIGNMENT_EXISTS (unless `replace`). Nothing is written on a refusal.
   */
  assignHostWorker: async (_: unknown, { input, instruction }: { input: AssignInput; instruction?: ActInstruction | null }, ctx: Context) => {
    if (!input) throw badInput('input is required.');
    // An App key first: it learns nothing about what a well-formed assignment is.
    if (appKeyCaller(ctx)) throw notPermitted();
    let v: ReturnType<typeof validateHostAssignment>;
    try {
      v = validateHostAssignment(input);
    } catch (e) {
      if (e instanceof HostAssignmentArgsError) throw taskError(e.code, e.message);
      throw e;
    }
    const { app, result } = await asSetupManager(ctx, input.appRef, instruction, async (tx, txCtx, freshApp, actor) => {
      const workerNotFound = () => taskError('WORKER_NOT_FOUND', 'Worker not found.', { worker: input.worker });
      const workerId = await resolveTaskWorkerId(txCtx, freshApp.id, input.worker);
      if (!workerId) throw workerNotFound();
      // The worker under a lock: a retire either committed first (refused here) or waits for this write.
      const [target] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null }[]>`
        SELECT app_id AS "appId", retired_at AS "retiredAt" FROM workers WHERE id = ${workerId} FOR SHARE`;
      if (!target || target.appId !== freshApp.id) throw workerNotFound();
      if (target.retiredAt) throw taskError('WORKER_RETIRED', 'This worker is retired.', { workerId });
      // The host-setup lock, after the worker row, the last lock this write takes.
      await lockHostSetup(tx, freshApp.id, 'exclusive');
      const key = { appId_workerId_hostId: { appId: freshApp.id, workerId, hostId: v.hostId } };
      const existing = await tx.hostWorkerAssignment.findUnique({ where: key, select: { id: true } });
      if (existing && !input.replace) {
        throw taskError('HOST_ASSIGNMENT_EXISTS', 'This worker is already assigned to that host. Pass replace to change the assignment.', { workerId, hostId: v.hostId });
      }
      const row = existing
        ? await tx.hostWorkerAssignment.update({ where: key, data: { workdir: v.workdir, family: v.family, model: v.model, effort: v.effort, accountProfile: v.accountProfile, updatedAt: new Date() } })
        : await tx.hostWorkerAssignment.create({
          data: { id: generateId(), appId: freshApp.id, hostId: v.hostId, workerId, workdir: v.workdir, family: v.family, model: v.model, effort: v.effort,
            accountProfile: v.accountProfile, createdByUserId: writer(ctx) },
        });
      await record(tx, freshApp.id, actor, 'host-setup.assign', workerId);
      return row;
    });
    // Under a server-held setup an assignment can make a worker launchable, so a queued task may now match.
    await matchAfterChange(ctx.db, app.id);
    return result;
  },

  /** #4222 — remove a worker's assignment to a host. True when one was removed; false when there was none. */
  unassignHostWorker: async (
    _: unknown,
    { input, instruction }: { input: { appRef: string; hostId: string; worker: string }; instruction?: ActInstruction | null },
    ctx: Context,
  ) => {
    if (!input) throw badInput('input is required.');
    if (appKeyCaller(ctx)) throw notPermitted();
    const hostId = typeof input.hostId === 'string' ? input.hostId.trim() : '';
    if (!isAssignmentHostId(hostId)) throw taskError('BAD_HOST_ASSIGNMENT_ARGS', 'hostId is a host token.');
    const { result } = await asSetupManager(ctx, input.appRef, instruction, async (tx, txCtx, freshApp, actor) => {
      // A retired worker's assignment is removable too, so the ref resolves without a retirement check.
      const workerId = await resolveTaskWorkerId(txCtx, freshApp.id, input.worker);
      if (!workerId) return false;
      await lockHostSetup(tx, freshApp.id, 'exclusive');
      const { count } = await tx.hostWorkerAssignment.deleteMany({ where: { appId: freshApp.id, workerId, hostId } });
      if (count > 0) await record(tx, freshApp.id, actor, 'host-setup.unassign', workerId);
      return count > 0;
    });
    return result;
  },

  /**
   * #4222 — the App's switch: HOST (the default; a host states what it runs) or SERVER (the platform's assignments;
   * a registration is checked against them). Whoever manages the App. Takes effect at the next registration and the
   * next start decision; what a host already registered stays until its next refresh.
   */
  setHostSetupSource: async (
    _: unknown,
    a: { appRef: string; source: string; instruction?: ActInstruction | null },
    ctx: Context,
  ) => {
    if (appKeyCaller(ctx)) throw notPermitted();
    const source = typeof a.source === 'string' ? a.source.toLowerCase() : '';
    if (!isHostSetupSource(source)) throw badInput('source is HOST or SERVER.');
    const { app } = await asSetupManager(ctx, a.appRef, a.instruction, async (tx, _txCtx, freshApp, actor) => {
      await lockHostSetup(tx, freshApp.id, 'exclusive');
      const changed = await tx.$executeRaw`
        UPDATE apps SET host_setup_source = ${source} WHERE id = ${freshApp.id} AND host_setup_source <> ${source}`;
      if (changed > 0) await record(tx, freshApp.id, actor, 'host-setup.source');
    }, 'exclusive');
    // The switch changes which workers are launchable, so a queued task may now match.
    await matchAfterChange(ctx.db, app.id);
    return source.toUpperCase();
  },
};

type SetupView = { source: Uppercase<HostSetupSource>; assignments: HostAssignmentRow[] };

export const hostAssignmentQueries = {
  /**
   * #4222 — what the platform says the App's hosts run: the switch, and the assignments in effect (a retired
   * worker's are left out). See the file header for who reads what.
   */
  hostSetup: (_: unknown, a: { appRef: string; hostId?: string | null }, ctx: Context) =>
    recordingRefusal(ctx, 'read', null, async () => {
      const filter = a.hostId == null ? undefined : a.hostId.trim();
      const view = await withReadableApp(ctx, a.appRef, async (c, app): Promise<SetupView> => {
        let hostId = filter;
        let none = false;
        const key = appKeyCaller(c);
        if (key && (await keyEverHeldHostOperate(c.db, key.appKeyId))) {
          const own = await keyHostId(c.db, key);
          // A revoked host scope never opens the App-wide read (#1894): refused whatever it passes.
          if (!own) throw taskError('FORBIDDEN', "A host key reads only its own host's setup.");
          // Another host's rows answer exactly like a host that has none.
          none = hostId !== undefined && hostId !== own;
          hostId = own;
        } else if (hostId !== undefined && !isAssignmentHostId(hostId)) {
          throw badInput('hostId is a host token.');
        }
        const source = await loadHostSetupSource(c.db, app.id);
        const assignments = none ? [] : await loadHostAssignments(c.db, app.id, hostId);
        return { source: source.toUpperCase() as Uppercase<HostSetupSource>, assignments };
      });
      // cor:agt:070:07: a host key's read is a use too, recorded apart from the read.
      const key = appKeyCaller(ctx);
      if (key) await recordHostKeyUseApart(ctx.db, key, 'read', { count: view.assignments.length });
      return view;
    }),
};

export const hostAssignmentFieldResolvers = {
  HostWorkerAssignment: {
    worker: (r: HostAssignmentRow, _a: unknown, ctx: Context) => ctx.db.worker.findUnique({ where: { id: r.workerId } }),
  },
};
