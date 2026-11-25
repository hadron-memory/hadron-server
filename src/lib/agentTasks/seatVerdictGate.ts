/**
 * #5036: a task that is a PR review seat is not finished with no verdict recorded at the head it was bound to.
 * Held in the team's system memory (hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:pr-finishing,
 * "Finishing a review seat"), not in the platform corpus (Holger, team chat #148458).
 *
 * Judged at the seat's ASSIGNED head (a seat never moves head), not the build task's current frozen head, so a seat on
 * an old head still finishes after a re-freeze. Exempt, finishing unchanged: a seat never bound (no `review.seat.assigned`
 * event), a seat whose slot was superseded by a later seat, and a task finished with outcome `failed` or `cancelled`.
 * Events are read within the task's OWN App (#4202). Throws before any write; the caller holds the task row.
 */
import type { Prisma } from '../../generated/prisma/index.js';
import { GraphQLError } from 'graphql';

/** Outcomes that end a seat without a verdict (the seat could not review). Compared lower-cased. */
export const SEAT_NO_VERDICT_OUTCOMES: ReadonlySet<string> = new Set(['failed', 'cancelled']);

export async function refuseSeatFinishWithoutVerdict(
  tx: Prisma.TransactionClient,
  task: { id: string; appId: string },
  outcome: string,
): Promise<void> {
  if (SEAT_NO_VERDICT_OUTCOMES.has(outcome.toLowerCase())) return;
  const assigned = await tx.agentTeamEvent.findFirst({
    where: { appId: task.appId, taskId: task.id, type: 'review.seat.assigned' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { payload: true },
  });
  if (!assigned) return;
  const payload = assigned.payload && typeof assigned.payload === 'object' && !Array.isArray(assigned.payload)
    ? assigned.payload as Record<string, unknown> : {};
  const head = payload.head;
  if (typeof head !== 'string') return;
  const superseded = await tx.agentTeamEvent.findFirst({
    where: { appId: task.appId, type: 'review.seat.assigned', payload: { path: ['supersedes'], equals: task.id } },
    select: { id: true },
  });
  if (superseded) return;
  const verdict = await tx.agentTeamEvent.findFirst({
    where: { appId: task.appId, taskId: task.id, type: 'review.verdict', payload: { path: ['head'], equals: head } },
    select: { id: true },
  });
  if (verdict) return;
  throw new GraphQLError(
    `This review seat has no verdict recorded at its assigned head ${head}, so it cannot be finished yet (it would read FINISHED with no verdict and not count). `
    + `Record it first: hadron team pr verdict <seat> --head ${head} --verdict <APPROVE|CHANGES_REQUESTED|FAIL|...>, then finish. `
    + 'A seat that could not review finishes with outcome failed or cancelled. Rule: team memory coordination:pr-finishing, "Finishing a review seat".',
    { extensions: { code: 'SEAT_VERDICT_REQUIRED', taskId: task.id, head, slot: typeof payload.slot === 'string' ? payload.slot : null } },
  );
}
