/**
 * #5020 (Billing A13): the billable account of a unit of AI spend, the owner of the work
 * (hrn:node:hadronmemory.com:specs:cor:dmo:170:05): the owner of the App the work ran in, else the owner of the Agent that
 * did it. The one place that decides it; no caller works the owner out for itself.
 *
 * Never the caller's active organization: a request's active organization says where the caller is standing, not who owns
 * the work. A work with no owner (a platform admin's test of the platform's own configuration) has no billable account,
 * and its unit records neither column and debits nobody.
 */
import type { PrismaClient } from '../../generated/prisma/index.js';
import { ownerOfWork, type OwnerRef } from '../owner.js';

/** A client or a transaction client: the lookup reads through whichever the caller holds. */
type Db = Pick<PrismaClient, 'app' | 'agent'>;

const OWNER_SELECT = { organizationId: true, ownerUserId: true } as const;

/**
 * The owner of the work done in `appId` by `agentId`: the App's owner when there is an App, else the Agent's. Answers null
 * for no owner (neither id, an id that names no row, a row with no owner), never a nullable organization id.
 */
export async function billableAccountFor(
  db: Db,
  work: { appId?: string | null; agentId?: string | null },
): Promise<OwnerRef | null> {
  const app = work.appId ? await db.app.findUnique({ where: { id: work.appId }, select: OWNER_SELECT }) : null;
  // The Agent is read only when there is no App (cor:dmo:170:05 S1: the App's owner first), so it is never consulted for a
  // row the rule does not reach.
  const agent = !app && work.agentId ? await db.agent.findUnique({ where: { id: work.agentId }, select: OWNER_SELECT }) : null;
  return ownerOfWork(app, agent);
}

/**
 * #5023 (blind review F2): the billable account of a headless run, in ONE place. The credit gate (at launch and at each model
 * hop) and the usage record of each hop both call it, so what is checked and what is debited cannot drift apart. Today it is
 * the run's own organization (the owner of the App the run is in, which `launchAppRun`/`mintAppRun` stamp on the run); slice F3a
 * (a person's App) changes this one function to the run's owner.
 */
export function billableAccountOfRun(run: { organizationId: string }): OwnerRef {
  return { organizationId: run.organizationId };
}
