import type { Context } from './resolvers.helpers.js';
import { requireInstructedAct, type ActAdmission, type ActInstruction } from '../../../lib/auth/instructedAct.js';
import { managesApp, lockAppManagerMemberships } from '../../../lib/auth/appManagement.js';
import { lockWorkersForAssignment } from '../../../lib/agentTasks/workerLock.js';
import { appendCredentialInstructionEvent, type CredentialAct } from '../../../lib/agentTasks/events.js';
import { withAuthorizedTx } from './authorizedTx.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { currentActor, currentActorAmbiguity } from '../../../lib/requestActor.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { resolveTaskRef, mayReadAppTasks } from './resolvers.agentTask.js';
import { readableInstructionMessageApp } from './resolvers.teamChat.js';

/** #3307: reuse the actual task/channel read gates on the transaction's caller, then narrow to this App. */
export async function readActInstruction(ctx: Context, appId: string, instruction: ActInstruction): Promise<boolean> {
  if (instruction.kind === 'TASK') {
    if (!/^hrn:agenttask:/i.test(instruction.ref)) return false;
    const taskId = await resolveTaskRef(ctx, instruction.ref);
    // The instruction gate needs the App identity, never the task's description, properties or result.
    const task = taskId ? await ctx.db.agentTask.findUnique({ where: { id: taskId }, select: { appId: true } }) : null;
    if (!task || !(await mayReadAppTasks(ctx, task.appId))) return false;
    return task.appId === appId;
  }
  if (instruction.kind === 'TEAM_CHAT_MESSAGE') {
    return (await readableInstructionMessageApp(ctx, instruction.ref)) === appId;
  }
  return false;
}

/**
 * Xanthos ruling (#71252, 2026-11-03): #3311 keeps main's behavior for a user-backed App RUN at the key, scope and App-grant
 * revoke doors and the key list: it is admitted when the user it carries manages the App, as `requireAppKeyManager` and
 * `actorManagesApp` admitted it before. Only a plain run: no session, no worker, no impersonation, no ambiguity, no
 * refused binding, no App key. (The write-grant doors refused a run before and still do.)
 */
export function isLegacyRunPrincipal(ctx: Context): boolean {
  return isRunPrincipal(ctx) && !!ctx.userId && !ctx.impersonation && !ctx.appKeyId && !ctx.sessionId
    && !ctx.sessionBindingRefused && currentActorAmbiguity() === null && !currentActor().workerId;
}

/** `requireInstructedAct`, except that a plain run is judged as main judged it (see {@link isLegacyRunPrincipal}). */
export async function requireInstructedActKeepingRuns(
  ctx: Context,
  appId: string,
  claim: ActInstruction | null | undefined,
  allowsHolder: () => Promise<boolean>,
  readReference: (ctx: Context, appId: string, instruction: ActInstruction) => Promise<boolean>,
  refuse: () => Error,
): Promise<ActAdmission> {
  if (!isLegacyRunPrincipal(ctx)) return requireInstructedAct(ctx, appId, claim, allowsHolder, readReference, refuse);
  if (!(await allowsHolder())) throw refuse();
  return { kind: 'person', userId: ctx.userId! };
}

/**
 * #3307, shared by #3311: one holder/instruction gate on the live transaction. The door's own manager predicate runs
 * on the holder (`managesApp`), never on a worker grant or a claimed role. `refuse` is the door's own refusal, so a
 * refused worker gets exactly what the holder as a person would get.
 */
export async function admitAppManagement(
  ctx: Context,
  scope: { id: string; organizationId: string | null; ownerUserId: string | null },
  refuse: () => Error,
  instruction?: ActInstruction | null,
  expected?: ActAdmission,
  keepRuns = false,
): Promise<ActAdmission> {
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: scope.id } });
  // The authority/membership lock set belongs to this ownership scope; a transfer must be retried with new anchors.
  if (app.organizationId !== scope.organizationId || app.ownerUserId !== scope.ownerUserId) throw refuse();
  const admission = await (keepRuns ? requireInstructedActKeepingRuns : requireInstructedAct)(ctx, app.id, instruction, () => managesApp(ctx, app), readActInstruction, refuse);
  // The lock set came from the first admission. Never adopt a different principal after those locks were taken.
  if (expected && (expected.kind !== admission.kind || expected.userId !== admission.userId
    || (expected.kind === 'instructed-worker' && admission.kind === 'instructed-worker' && (expected.workerId !== admission.workerId || expected.agentId !== admission.agentId)))) throw refuse();
  return admission;
}

/** Lock actor and subject in canonical assignment/row order; a hold release cannot pass the final check. */
export async function lockInstructedActRows(tx: Prisma.TransactionClient, ids: string[], sessionId?: string) {
  await tx.$queryRaw`SELECT id FROM workers WHERE id = ANY(${[...new Set(ids)].sort()}::text[]) ORDER BY id FOR UPDATE`;
  if (sessionId) await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId} FOR SHARE`;
}

/**
 * Fence the caller's session row through commit (a session-end writer waits), for a door whose worker lock comes from
 * the surrounding write transaction. The instructed judgement that follows reads the session after this lock.
 */
export async function lockCallerSession(tx: Prisma.TransactionClient, sessionId?: string | null) {
  if (sessionId) await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId} FOR SHARE`;
}

/** True when the request is a worker's: bound by the transport, or through the persisted session it names. */
export async function callerIsWorkerSession(ctx: Context): Promise<boolean> {
  if (currentActor().workerId) return true;
  if (!ctx.sessionId) return false;
  const session = await ctx.db.session.findUnique({ where: { id: ctx.sessionId }, select: { workerId: true } });
  return Boolean(session?.workerId);
}

/**
 * #3311 / ruling 0111 (A): admit a LIST call of an App's credentials. A person as themselves, or their held worker on a
 * validated instruction, judged on the holder; the App's manager predicate decides. An admitted INSTRUCTED call writes
 * exactly one team event, ids only, in its own transaction under the App's anchors and the act's locks, before the
 * rows are read; a refused call, and a direct person, write none. Returns the holder to scope the rows to.
 */
export async function admitCredentialList(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
  refuse: () => Error,
  instruction: ActInstruction | null | undefined,
  act: CredentialAct,
  keepRuns = false,
): Promise<ActAdmission> {
  return admitInstructedRead(ctx, app, refuse, instruction, (tx, admission) => appendCredentialInstructionEvent(tx, { appId: app.id, admission, act }), keepRuns);
}

/**
 * #3321: {@link admitCredentialList}'s admission for any manager-scope read; `record` writes the door's one record in
 * the admitted call's own transaction, after the final judgement on the locked worker and session.
 */
export async function admitInstructedRead(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
  refuse: () => Error,
  instruction: ActInstruction | null | undefined,
  record: (tx: Prisma.TransactionClient, admission: ActAdmission) => Promise<void>,
  keepRuns = false,
): Promise<ActAdmission> {
  let admission = await admitAppManagement(ctx, app, refuse, instruction, undefined, keepRuns);
  if (admission.kind !== 'instructed-worker') return admission;
  await withAuthorizedTx(
    ctx,
    [
      { kind: 'app', id: app.id },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ],
    async (txCtx) => { admission = await admitAppManagement(txCtx, app, refuse, instruction, admission, keepRuns); },
    async (tx, txCtx) => {
      // The last lock the act takes: the holder's worker and session rows, then the final judgement on them.
      await lockInstructedActRows(tx, [(admission as { workerId: string }).workerId], ctx.sessionId);
      admission = await admitAppManagement(txCtx, app, refuse, instruction, admission, keepRuns);
      await record(tx, admission);
    },
    {
      afterLock: async (tx) => {
        await lockWorkersForAssignment(tx, [(admission as { workerId: string }).workerId]);
        await lockAppManagerMemberships(tx, (admission as { userId: string }).userId, app);
      },
    },
  );
  return admission;
}
