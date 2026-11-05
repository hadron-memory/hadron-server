/**
 * #3483 / cor:agt:010:01 r40, cor:dmo:050:12 r39, cor:agt:080:24 r13: who may create a headless trigger.
 *
 * A person's own create is its own approval and unchanged. A WORKER-bound caller (a bound session, an ambiguous or
 * refused binding, or a session row naming a worker: the one test requireAdopterContext uses) needs either a person's
 * one-time {@link SchedulePermission} for exactly this worker, App and entry node, or the standing grant
 * `automations.schedule`. An instruction claim admits nothing here (ruling 0096: the server cannot verify it).
 *
 * Two steps, so no refusal follows an irreversible write: {@link admitTrigger} judges and writes nothing;
 * {@link spendAdmission} re-judges inside the create's own transaction and, for a permission, spends it with one
 * guarded UPDATE (the row lock serializes concurrent creates; the database clock decides expiry).
 * Every refusal is the one {@link scheduleAdmissionRefused}, whatever the cause.
 */
import { GraphQLError } from 'graphql';
import { boundWorkerId } from '../bootPrompt.js';
import { currentActorAmbiguity } from '../requestActor.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

export type TriggerAdmission =
  | { kind: 'person' }
  | { kind: 'permission'; workerId: string; permissionId: string }
  | { kind: 'grant'; workerId: string; grantId: string };

export const SCHEDULE_GRANT = 'automations.schedule';
export const SCHEDULE_PERMISSION_MINUTES = 10;

export const scheduleAdmissionRefused = () => new GraphQLError(
  'A worker needs a person\'s one-time permission or the automations.schedule grant to create or change a headless trigger.',
  { extensions: { code: 'FORBIDDEN' } });

/** The one worker-shape test (shared with requireAdopterContext): never a client flag. */
export async function workerShapedCaller(ctx: Context): Promise<boolean> {
  if (boundWorkerId() || currentActorAmbiguity() !== null || ctx.sessionBindingRefused) return true;
  return !!ctx.sessionId && !!await ctx.db.session.findFirst({ where: { id: ctx.sessionId, workerId: { not: null } }, select: { id: true } });
}

/** The bound worker's id, read from the request's published actor and the session row, which must agree. */
async function callerWorker(ctx: Context): Promise<{ id: string; launched: boolean } | null> {
  if (currentActorAmbiguity() !== null || ctx.sessionBindingRefused) return null;
  const actor = boundWorkerId() ?? null;
  const session = ctx.sessionId
    ? await ctx.db.session.findFirst({ where: { id: ctx.sessionId }, select: { userId: true, workerId: true, appId: true, endedAt: true, launchOperationId: true } })
    : null;
  if (ctx.sessionId && (!session || session.userId !== ctx.userId || session.endedAt)) return null;
  const id = session?.workerId ?? actor;
  if (!id || (actor && session?.workerId && actor !== session.workerId)) return null;
  return { id, launched: !!session?.launchOperationId };
}

type Tx = Pick<Context['db'], '$queryRaw'>;

async function liveHeldWorker(ctx: Context, appId: string, workerId: string): Promise<boolean> {
  const w = await ctx.db.worker.findUnique({ where: { id: workerId }, select: { appId: true, heldByUserId: true, retiredAt: true } });
  return !!w && w.appId === appId && !w.retiredAt && w.heldByUserId === ctx.userId;
}

/** Judge without writing. A person is admitted; a worker needs a live permission for this entry node, or the grant. */
export async function admitTrigger(
  ctx: Context, appId: string, entryNodeUrn: string,
): Promise<TriggerAdmission> {
  if (!await workerShapedCaller(ctx)) return { kind: 'person' };
  const caller = await callerWorker(ctx);
  const workerId = caller?.id;
  if (!ctx.userId || !workerId || !await liveHeldWorker(ctx, appId, workerId)) throw scheduleAdmissionRefused();
  // A host-launched (headless) session is never admitted by a permission a person gave for an interactive worker.
  if (!caller.launched) {
    const rows = await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM schedule_permissions
      WHERE app_id = ${appId} AND worker_id = ${workerId} AND entry_node_urn = ${entryNodeUrn}
        AND consumed_at IS NULL AND expires_at > now() ORDER BY given_at, id`;
    // Mint refuses a second live permission, so at most one exists; if a race ever made two, none is guessed.
    if (rows.length === 1) return { kind: 'permission', workerId, permissionId: rows[0]!.id };
  }
  const grants = await ctx.db.appGrant.findMany({ where: { appId, granteeWorkerId: workerId, name: SCHEDULE_GRANT, revokedAt: null }, select: { id: true } });
  if (grants.length === 1) return { kind: 'grant', workerId, grantId: grants[0]!.id };
  throw scheduleAdmissionRefused();
}

/** Typed form for the preview: the admission or null, never an error for a missing permission. */
export async function previewAdmission(
  ctx: Context, appId: string, entryNodeUrn: string,
): Promise<TriggerAdmission | null> {
  try {
    return await admitTrigger(ctx, appId, entryNodeUrn);
  } catch (e) {
    if (e instanceof GraphQLError && e.message === scheduleAdmissionRefused().message) return null;
    throw e;
  }
}

/**
 * Inside the create's transaction: re-judge and spend. A permission is spent by one guarded UPDATE naming the
 * trigger it admits; a grant is read FOR SHARE so a concurrent revoke cannot interleave. Zero rows is the refusal,
 * and the surrounding rollback leaves the permission unspent.
 */
export async function spendAdmission(
  tx: Tx, admission: TriggerAdmission, appId: string, entryNodeUrn: string,
  trigger: { kind: 'SCHEDULE' | 'WEBHOOK'; id: string }, holderUserId: string | undefined,
): Promise<void> {
  if (admission.kind === 'person') return;
  // The worker is still this holder's, live and in this App; retiring or releasing it waits on this lock.
  const held = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM workers
    WHERE id = ${admission.workerId} AND app_id = ${appId} AND held_by_user_id = ${holderUserId ?? null} AND retired_at IS NULL FOR SHARE`;
  if (held.length !== 1) throw scheduleAdmissionRefused();
  if (admission.kind === 'permission') {
    // Take the permission row's lock BEFORE the wall-clock judgement: an UPDATE that waits on a lock-only holder
    // is not re-evaluated afterwards, so the expiry must be read after the lock is ours.
    await tx.$queryRaw`SELECT id FROM schedule_permissions WHERE id = ${admission.permissionId} FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`UPDATE schedule_permissions
      SET consumed_at = clock_timestamp(), consumed_kind = ${trigger.kind}, consumed_id = ${trigger.id}
      WHERE id = ${admission.permissionId} AND app_id = ${appId} AND worker_id = ${admission.workerId}
        AND entry_node_urn = ${entryNodeUrn} AND consumed_at IS NULL AND expires_at > clock_timestamp()
      RETURNING id`;
    if (rows.length !== 1) throw scheduleAdmissionRefused();
    return;
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM app_grants
    WHERE id = ${admission.grantId} AND app_id = ${appId} AND grantee_worker_id = ${admission.workerId}
      AND name = ${SCHEDULE_GRANT} AND revoked_at IS NULL FOR SHARE`;
  if (rows.length !== 1) throw scheduleAdmissionRefused();
}

/** The columns a worker-bound admission records on the trigger row. */
export function admissionColumns(a: TriggerAdmission) {
  return a.kind === 'person'
    ? { createdByWorkerId: null, admittedPermissionId: null, admittedGrantId: null }
    : { createdByWorkerId: a.workerId, admittedPermissionId: a.kind === 'permission' ? a.permissionId : null, admittedGrantId: a.kind === 'grant' ? a.grantId : null };
}
