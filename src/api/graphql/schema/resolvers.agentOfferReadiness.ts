/**
 * #2246 (S2, cor:dmo:050:19) — `Agent.offerReadiness`: whether another organisation could subscribe to,
 * install and clone this Agent as it stands, with each reason it could not.
 *
 * Manager-only (cor:dmo:050:13): null for every other caller, readers of a PUBLIC Agent included, so a
 * reason can never describe a linked memory to someone who cannot read it. The blockers are the S1
 * predicate's (`cloneBlockers`), evaluated for an outsider organisation with no relation to the Agent
 * and WITHOUT the same-org manager exemption; S2 adds no blocker logic and no licensing rule of its own.
 * Which subjects the manager is told the name of is decided by that same predicate, for the manager.
 *
 * The result is scalar-only: a reason carries the code, the count of every blocked subject, and up to
 * {@link OFFER_SUBJECT_CAP} names the manager may read. No Agent, Memory or id is reachable through it,
 * so no nested field resolver can assume an outer gate that is not there. `position` is never exposed.
 */
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { generateId } from '../../../lib/id.js';
import { cloneBlockers, manages, type CloneBlocker } from '../../../lib/agentClone/blockers.js';
import type { Context } from './resolvers.helpers.js';

export const OFFER_SUBJECT_CAP = 20;

export type OfferReason = {
  code: CloneBlocker['code'];
  count: number;
  subjects: Array<{ name: string }>;
  omittedByCap: number;
  hiddenByAccess: number;
};

/** One blocker as the field shows it: listed + omittedByCap + hiddenByAccess === count. */
export function projectBlocker(b: CloneBlocker): OfferReason {
  const named = b.subjects.flatMap((s) => (s.name === undefined ? [] : [{ name: s.name }]));
  const subjects = named.slice(0, OFFER_SUBJECT_CAP);
  return {
    code: b.code,
    count: b.count,
    subjects,
    omittedByCap: named.length - subjects.length,
    hiddenByAccess: b.count - named.length,
  };
}

/** A principal with no membership, grant, share or ownership anywhere: the outsider organisation of 050:19. */
export const outsiderReader = (ctx: Context): Context => ({ db: ctx.db, userId: generateId(), roles: ['READER'] }) as Context;

export async function resolveOfferReadiness(
  parent: { id: string; organizationId?: string | null; ownerUserId?: string | null },
  _args: unknown,
  ctx: Context,
) {
  // A slim parent row may omit the owner columns the gate reads; an absent column is never "no owner".
  const row = parent.organizationId !== undefined && parent.ownerUserId !== undefined
    ? { organizationId: parent.organizationId, ownerUserId: parent.ownerUserId }
    : await ctx.db.agent.findUnique({ where: { id: parent.id }, select: { organizationId: true, ownerUserId: true } });
  if (!row || !(await manages(ctx, row))) return null;
  try {
    const blockers = await cloneBlockers(ctx.db, parent.id, { kind: 'outsider', ctx, reader: outsiderReader(ctx) });
    return { ready: blockers.length === 0, reasons: blockers.map(projectBlocker) };
  } catch (e) {
    // Gone between the parent read and this one: concealed, like every Agent read of an absent Agent.
    if (e instanceof AgentNotFoundError) return null;
    throw e;
  }
}

export const agentOfferReadinessFieldResolvers = {
  Agent: { offerReadiness: resolveOfferReadiness },
};
