/**
 * #4179 clause 1 (cor:acl:140:03, Holger R2): the grants of agents that lost their last installation in an App BEFORE #4172
 * shipped were never stamped, and nothing revisits them. This is the one-off backfill that ends them. The AFTER DELETE trigger on
 * agent_imports (prisma/grant-invariants.sql) covers a hard-deleted importing parent from now on.
 *
 * What it ends: an AGENT-held grant of a LIVE agent that has no effective installation (hadron_agent_installed_in_app, #4172's
 * judgement) in the grant's own, still existing App, and that has not already ended (revoked, departed, expired, spent or past
 * its action's limits: the first end stands, one shared fragment with the departure doors). Lock first, judge second, in batches
 * by id, on the database clock, so a grant that expired or an install that committed while the run waited is judged after the lock.
 *
 * THE LIMITS, stated because the FIT forbids guessing a cause or a time from other state:
 *  - The FIT asks for the first end at the departure's own moment when a record shows it. For an agent in an App the record does
 *    not exist: an uninstall, a removed import edge and a hard-deleted parent are hard row deletes that leave no timestamp, and a
 *    dated licence revocation or an App's `uninstalledAt` cannot exclude a later removal of the physical row. So EVERY stamp here
 *    carries the backfill's own time. The dry run reports how many candidates sit behind a dated licence revocation, for review.
 *  - An agent reinstalled since its departure has an effective installation now, and nothing records which of its grants predate
 *    the reinstall, so those rows are not stamped (the FIT's "an agent reinstalled since still had its old grants ended" needs a
 *    record this schema does not keep). They are named in the report as `skippedInstalled` only as a count of agent-held live
 *    grants whose agent is installed, never as a finding about any one of them.
 *  - Once #4180 lands, backfilled rows carry its "reason not recorded" value (a follow-up on that issue, not built here).
 * Running it in production needs its own register grant (CLAUDE.md, "Production database"); this file only ships the tool.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { ALREADY_ENDED } from './departure.js';
import { GRANT_DB_NOW } from './live.js';

export interface StrandedBackfillOptions { apply: boolean; batchSize?: number }
export interface StrandedBackfillReport {
  applied: boolean;
  /** Agent-held, unended grants of a live agent with no effective installation in the grant's App, as judged now. */
  candidates: number;
  /** Rows stamped (always 0 on a dry run). */
  stamped: number;
  /** Candidates whose (App, agent) has a dated licence revocation: reported for review, never used as the moment. */
  behindDatedLicenceRevocation: number;
  /** Agent-held, unended grants whose agent IS installed: left alone, cannot be told from a post-reinstall grant. */
  skippedInstalled: number;
}

const STRANDED = Prisma.sql`grants.agent_id IS NOT NULL AND grants.holder_departed_at IS NULL AND grants.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
  AND EXISTS (SELECT 1 FROM agents g WHERE g.id = grants.agent_id AND g.deleted_at IS NULL)
  AND NOT hadron_agent_installed_in_app(grants.app_id, grants.agent_id)`;

export async function backfillStrandedAgentGrants(db: PrismaClient, opts: StrandedBackfillOptions): Promise<StrandedBackfillReport> {
  const batch = Math.min(Math.max(Math.trunc(opts.batchSize ?? 500), 1), 5000);
  const [counts] = await db.$queryRaw<Array<{ candidates: bigint; revoked: bigint; installed: bigint }>>(Prisma.sql`
    SELECT count(*) FILTER (WHERE ${STRANDED} AND NOT ${ALREADY_ENDED}) AS candidates,
           count(*) FILTER (WHERE ${STRANDED} AND NOT ${ALREADY_ENDED} AND EXISTS (
             SELECT 1 FROM apps ap JOIN agent_org_grants l ON l.org_id = ap.organization_id AND l.agent_id = grants.agent_id
              WHERE ap.id = grants.app_id AND l.revoked_at IS NOT NULL)) AS revoked,
           count(*) FILTER (WHERE grants.agent_id IS NOT NULL AND grants.holder_departed_at IS NULL AND grants.revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM apps a WHERE a.id = grants.app_id)
             AND EXISTS (SELECT 1 FROM agents g WHERE g.id = grants.agent_id AND g.deleted_at IS NULL)
             AND hadron_agent_installed_in_app(grants.app_id, grants.agent_id) AND NOT ${ALREADY_ENDED}) AS installed
      FROM grants`);
  const report: StrandedBackfillReport = {
    applied: opts.apply, candidates: Number(counts!.candidates), stamped: 0,
    behindDatedLicenceRevocation: Number(counts!.revoked), skippedInstalled: Number(counts!.installed),
  };
  if (!opts.apply) return report;
  let after = '';
  for (;;) {
    const done = await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM grants WHERE id > ${after} AND ${STRANDED} AND NOT ${ALREADY_ENDED} ORDER BY id LIMIT ${batch} FOR UPDATE`);
      if (locked.length === 0) return null;
      const ids = locked.map((r) => r.id);
      const n = await tx.$executeRaw(Prisma.sql`
        UPDATE grants SET holder_departed_at = ${GRANT_DB_NOW}, updated_at = ${GRANT_DB_NOW}
         WHERE id = ANY(${ids}::text[]) AND ${STRANDED} AND NOT ${ALREADY_ENDED}`);
      return { last: ids[ids.length - 1]!, n };
    }, { timeout: 60_000 });
    if (!done) break;
    report.stamped += done.n;
    after = done.last;
  }
  return report;
}
