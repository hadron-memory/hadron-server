import { currentActor } from '../requestActor.js';
import { isRefusedPrincipal } from './requestPrincipal.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

export type ActInstruction = { kind: 'TEAM_CHAT_MESSAGE' | 'TASK' | 'LIVE_CHAT'; ref: string };
export type ActAdmission =
  | { kind: 'person'; userId: string }
  | { kind: 'instructed-worker'; userId: string; workerId: string; agentId: string | null; instruction: ActInstruction };
/** #3308: only staffing/member doors opt into this own-worker grant arm. */
export type HeadlessActGrant = { name: 'workers.staff' | 'app.members'; lock?: boolean };
export type StaffActAdmission = ActAdmission | {
  kind: 'granted-worker'; userId: string; workerId: string; agentId: string | null; grantId: string;
};
export const INSTRUCTION_REF_MAX = 512;
type ReadInstruction = (ctx: Context, appId: string, instruction: ActInstruction) => Promise<boolean>;

/**
 * #3307 / cor:dmo:050:12: an instruction is a recorded claim, not a grant. The request user must hold the
 * persisted, hand-started worker session in this App, and the door must still admit that holder. Pass txCtx,
 * never the pooled request client. ReadReference must use the referenced entity's existing caller read gate.
 * Ruling 0096 accepts self-citation: authorship, recency, reuse and what the holder meant are not verified.
 * A present claim is validated even for a person (though never recorded for them); a named session must
 * still exist, belong to that person and not be ended. An invalid binding never becomes a person here.
 */
export function requireInstructedAct(
  ctx: Context, appId: string, claim: ActInstruction | null | undefined,
  allowsHolder: () => Promise<boolean>, readReference: ReadInstruction, refuse: () => Error,
): Promise<ActAdmission>;
export function requireInstructedAct(
  ctx: Context, appId: string, claim: ActInstruction | null | undefined,
  allowsHolder: () => Promise<boolean>, readReference: ReadInstruction, refuse: () => Error,
  grant: HeadlessActGrant,
): Promise<StaffActAdmission>;
export async function requireInstructedAct(
  ctx: Context,
  appId: string,
  claim: ActInstruction | null | undefined,
  allowsHolder: () => Promise<boolean>,
  readReference: ReadInstruction,
  refuse: () => Error,
  grant?: HeadlessActGrant,
): Promise<StaffActAdmission> {
  if (isRefusedPrincipal(ctx) || ctx.appKeyId) throw refuse();
  const actor = currentActor();
  const session = ctx.sessionId ? await ctx.db.session.findUnique({
    where: { id: ctx.sessionId },
    select: { userId: true, appId: true, workerId: true, agentId: true, launchOperationId: true, endedAt: true },
  }) : null;
  // A caller cannot erase or substitute the actor authenticated by the transport with a different session row.
  if (ctx.sessionId && (!session || session.userId !== ctx.userId || session.endedAt)) throw refuse();
  // Even a malformed read projection must never turn a launched worker into a person.
  // PostgreSQL chk_sessions_launch independently requires worker_id on persisted launched sessions.
  if (session?.launchOperationId && (!grant || !session.workerId)) throw refuse();
  const workerId = session?.workerId ?? actor.workerId;
  if (actor.workerId && actor.workerId !== session?.workerId) throw refuse();
  if (actor.agentId && !workerId) throw refuse();

  let instruction: ActInstruction | undefined;
  // A launched session is always headless; its claim cannot select the instructed arm.
  if (claim != null && !session?.launchOperationId) {
    if (typeof claim.ref !== 'string' || !claim.ref || /[\uD800-\uDFFF]/u.test(claim.ref)
      || (claim.kind === 'LIVE_CHAT' && claim.ref.length > INSTRUCTION_REF_MAX)
      || !['TEAM_CHAT_MESSAGE', 'TASK', 'LIVE_CHAT'].includes(claim.kind)) throw refuse();
    instruction = { kind: claim.kind, ref: claim.ref };
    if (claim.kind === 'LIVE_CHAT') {
      // Opaque client address only, never pasted prose; its origin is a claim the holder answers for.
      if (/[\s\u0000-\u001f\u007f]/u.test(claim.ref)) throw refuse();
    } else if (!(await readReference(ctx, appId, instruction))) throw refuse();
  }
  if (!workerId) {
    if (!(await allowsHolder())) throw refuse();
    return { kind: 'person', userId: ctx.userId! };
  }
  if (!session?.workerId || session.appId !== appId || (!instruction && !grant)) throw refuse();
  const worker = await ctx.db.worker.findUnique({
    where: { id: workerId }, select: { appId: true, heldByUserId: true, retiredAt: true },
  });
  if (!worker || worker.appId !== appId || worker.retiredAt || worker.heldByUserId !== ctx.userId) throw refuse();
  if (!instruction) {
    if (!grant) throw refuse();
    // Final callers request the row lock only AFTER their canonical Worker locks. Grant revocation uses
    // Worker -> grant too; no stale request cache or another worker's grant can authorize this transaction.
    const rows = grant.lock
      ? await ctx.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM app_grants
          WHERE app_id = ${appId} AND grantee_worker_id = ${workerId} AND name = ${grant.name}
            AND revoked_at IS NULL FOR SHARE`
      : await ctx.db.appGrant.findMany({ where: { appId, granteeWorkerId: workerId, name: grant.name, revokedAt: null }, select: { id: true } });
    if (rows.length !== 1 || !(await allowsHolder())) throw refuse();
    return { kind: 'granted-worker', userId: ctx.userId!, workerId, agentId: session.agentId, grantId: rows[0]!.id };
  }
  if (!(await allowsHolder())) throw refuse();
  return {
    kind: 'instructed-worker', userId: ctx.userId!, workerId, agentId: session.agentId, instruction,
  };
}

/** A final admission must retain the principal whose worker/session rows the act locked (#3307/#3308). */
export function sameActPrincipal(expected: StaffActAdmission, actual: StaffActAdmission): boolean {
  return expected.kind === actual.kind && expected.userId === actual.userId
    && (expected.kind === 'person' || (actual.kind !== 'person'
      && expected.workerId === actual.workerId && expected.agentId === actual.agentId));
}
