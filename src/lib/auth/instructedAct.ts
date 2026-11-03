import { currentActor } from '../requestActor.js';
import { isRefusedPrincipal } from './requestPrincipal.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';

export type ActInstruction = { kind: 'TEAM_CHAT_MESSAGE' | 'TASK' | 'LIVE_CHAT'; ref: string };
export type ActAdmission =
  | { kind: 'person'; userId: string }
  | { kind: 'instructed-worker'; userId: string; workerId: string; agentId: string; instruction: ActInstruction };
export const INSTRUCTION_REF_MAX = 512;
type ReadInstruction = (ctx: Context, appId: string, instruction: ActInstruction) => Promise<boolean>;

/**
 * #3307 / cor:dmo:050:12: an instruction is a recorded claim, not a grant. The request user must hold the
 * persisted, hand-started worker session in this App, and the door must still admit that holder. Pass txCtx,
 * never the pooled request client. ReadReference must use the referenced entity's existing caller read gate.
 */
export async function requireInstructedAct(
  ctx: Context,
  appId: string,
  claim: ActInstruction | null | undefined,
  allowsHolder: () => Promise<boolean>,
  readReference: ReadInstruction,
  refuse: () => Error,
): Promise<ActAdmission> {
  if (isRefusedPrincipal(ctx) || ctx.appKeyId) throw refuse();
  const actor = currentActor();
  const session = ctx.sessionId ? await ctx.db.session.findUnique({
    where: { id: ctx.sessionId },
    select: { userId: true, appId: true, workerId: true, agentId: true, launchOperationId: true, endedAt: true },
  }) : null;
  // A caller cannot erase or substitute the actor authenticated by the transport with a different session row.
  if (ctx.sessionId && (!session || session.userId !== ctx.userId || session.endedAt)) throw refuse();
  if (session?.launchOperationId) throw refuse();
  const workerId = session?.workerId ?? actor.workerId;
  if (actor.workerId && actor.workerId !== session?.workerId) throw refuse();
  if (actor.agentId && !workerId) throw refuse();

  let instruction: ActInstruction | undefined;
  if (claim != null) {
    if (typeof claim.ref !== 'string' || !claim.ref
      || (claim.kind === 'LIVE_CHAT' && claim.ref.length > INSTRUCTION_REF_MAX)
      || !['TEAM_CHAT_MESSAGE', 'TASK', 'LIVE_CHAT'].includes(claim.kind)) throw refuse();
    instruction = { kind: claim.kind, ref: claim.ref };
    if (claim.kind === 'LIVE_CHAT') {
      // Opaque client address only, never pasted prose; the server does not judge what the holder meant.
      if (/[\s\u0000-\u001f\u007f]/u.test(claim.ref)) throw refuse();
    } else if (!(await readReference(ctx, appId, instruction))) throw refuse();
  }
  if (!workerId) {
    if (!(await allowsHolder())) throw refuse();
    return { kind: 'person', userId: ctx.userId! };
  }
  if (!session?.workerId || session.appId !== appId || !instruction) throw refuse();
  const worker = await ctx.db.worker.findUnique({
    where: { id: workerId }, select: { appId: true, heldByUserId: true, retiredAt: true },
  });
  if (!worker || worker.appId !== appId || worker.retiredAt || worker.heldByUserId !== ctx.userId) throw refuse();
  if (!(await allowsHolder())) throw refuse();
  return {
    kind: 'instructed-worker', userId: ctx.userId!, workerId, agentId: session.agentId!, instruction,
  };
}
