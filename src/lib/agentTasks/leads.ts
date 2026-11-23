/**
 * The ONE definition of a lead (cor:agt:020:12, the reporting line; rulings 0270 and 0271, #4375).
 *
 * A lead is a worker that at least one worker reports to: it is not retired, and at least one other worker of the
 * same App, also not retired, has its `reportsToWorkerId` set to it. No role name takes part; `role` is free text
 * the platform does not read here.
 *
 * Everything that needs "who is a lead" imports this file, so a later change to what a lead is lands in one place:
 * the cadence alarm (src/lib/agentTasks/leadCadence.ts) today, and the report-based cadence rule (#4937) and
 * #4921 slice B after it. Do not re-derive it from `reportsToWorkerId` elsewhere.
 *
 * Two forms of the same rule:
 * - {@link computeLeadIds} is the rule itself, over a roster snapshot already in hand (a pass that has read the
 *   workers once and judges many of them).
 * - {@link leadWorkerIds} and {@link isLeadWorker} read the App's roster through `db` and apply it, for a caller
 *   with no snapshot. They read through whatever client they are given, so a caller inside a transaction sees the
 *   transaction's rows.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

/** What the rule reads of a worker. */
export interface LeadRosterRow {
  id: string;
  reportsToWorkerId: string | null;
  retiredAt: Date | null;
}

type Db = Pick<PrismaClient, 'worker'>;

/**
 * The leads of a roster: the non-retired workers that at least one non-retired worker reports to. A worker that
 * reports to itself does not make itself a lead (a reporting line is between two workers). `rows` is one App's
 * roster; a row whose `reportsToWorkerId` names a worker outside it makes nobody a lead.
 */
export function computeLeadIds(rows: readonly LeadRosterRow[]): Set<string> {
  const live = new Map(rows.filter((w) => !w.retiredAt).map((w) => [w.id, w] as const));
  const leads = new Set<string>();
  for (const w of live.values()) {
    const to = w.reportsToWorkerId;
    if (to && to !== w.id && live.has(to)) leads.add(to);
  }
  return leads;
}

/** The leads of one App, read through `db`. */
export async function leadWorkerIds(db: Db, appId: string): Promise<Set<string>> {
  const rows = await db.worker.findMany({
    where: { appId, retiredAt: null },
    select: { id: true, reportsToWorkerId: true, retiredAt: true },
  });
  return computeLeadIds(rows);
}

/** Is this worker a lead of its App right now? False for a retired worker, or one of another App. */
export async function isLeadWorker(db: Db, appId: string, workerId: string): Promise<boolean> {
  return (await leadWorkerIds(db, appId)).has(workerId);
}
