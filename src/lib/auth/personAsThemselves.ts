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

/**
 * #3277 (S3a of #2483): the PERSON-ONLY acts that rulings 0098 A and 0099 A (Holger, 2026-11-03) add to
 * hrn:node:hadronmemory.com:specs:cor:dmo:050:12. A worker session is refused them with or without its holder's
 * instruction, so no instructed-worker check (S1) may ever admit one:
 *  - `app-key.mint`, `app-key.rotate`: both return the raw secret, which would land in a model transcript (0098).
 *    Listing and revoking keys are NOT on the list (allowed on an instruction once S1 lands; S3b).
 *  - `grant.give`: giving a grant, any grant door; a worker never gives a grant to itself (0099). Revoking one is not
 *    on the list either (S3b).
 * The rule's older person-only acts (adoption, passkeys, impersonation, account merge) have their own doors on
 * {@link requirePersonAsThemselves} and are not repeated here. CLOSED: a new door joins by naming one of these acts.
 */
export const PERSON_ONLY_ACTS = ['app-key.mint', 'app-key.rotate', 'grant.give'] as const;
export type PersonOnlyAct = (typeof PERSON_ONLY_ACTS)[number];

/**
 * The one gate for a {@link PERSON_ONLY_ACTS} door: {@link requirePersonAsThemselves}, with the door's own refusal.
 * The door's manager check runs after it. `act` names which entry of the closed list the door is.
 */
export async function requirePersonOnlyAct(ctx: PersonGateContext, act: PersonOnlyAct, refuse: () => Error): Promise<string> {
  void act;
  return requirePersonAsThemselves(ctx, refuse);
}
