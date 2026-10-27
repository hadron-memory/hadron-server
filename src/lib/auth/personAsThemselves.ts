import { boundWorkerId } from '../bootPrompt.js';
import { currentActorAmbiguity } from '../requestActor.js';
import { isRunPrincipal } from './runPrincipal.js';

/** The slice of the GraphQL Context the person gate reads. */
export interface PersonGateContext {
  userId?: string;
  impersonation?: unknown;
  clientId?: string | null;
  sessionId?: string;
  sessionBindingRefused?: unknown;
  db: { session: { findFirst(args: { where: { id: string; workerId: { not: null } }; select: { id: true } }): Promise<unknown> } };
}

/**
 * A signed-in PERSON acting as themselves, and nothing else (cor:agt:010:01's door shape, as the adoption doors
 * decide it): no user, an impersonation, a run principal and a worker-bound session are all refused with `refuse()`.
 * A worker-bound session is read from the request's published actor AND from the session row, never from a client
 * flag; an ambiguous MCP actor (several live worker bindings, none named) and a refused session binding are worker
 * shapes too. Returns the person's user id.
 */
export async function requirePersonAsThemselves(ctx: PersonGateContext, refuse: () => Error): Promise<string> {
  if (!ctx.userId || ctx.impersonation || isRunPrincipal(ctx)) throw refuse();
  if (boundWorkerId() || currentActorAmbiguity() !== null || ctx.sessionBindingRefused) throw refuse();
  if (ctx.sessionId && await ctx.db.session.findFirst({ where: { id: ctx.sessionId, workerId: { not: null } }, select: { id: true } })) throw refuse();
  return ctx.userId;
}
