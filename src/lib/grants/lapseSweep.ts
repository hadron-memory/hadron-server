/**
 * #4178 (Holger R2, epic #1975; cor:acl:140:03 holder-gone row, :06): an agent left with no effective installation in an App, BY ANY
 * CAUSE, has gone for its grants there. #4172 ended them at every WRITE door that removes an installation witness. Two causes have no
 * write door of their own, and this sweeper ends them: a LAPSED LICENCE (the org's AgentOrgGrant behind a derived install expired or
 * was revoked) and a soft-DELETED ORGANIZATION. Both are a read-time change in `resolveAppInstallation`, so nothing ran.
 *
 * It STAMPS (`holder_departed_at`), as every other departure does: the state is read from the recorded fact (#4173), never computed
 * from the installation at read time. It judges with the SAME predicate as the doors, `resolveAppInstallation`, under the same
 * installation locks (`lockAppInstallations`, App FOR SHARE then rows in id order), and ends with the SAME writer
 * ({@link endAgentGrantsAtApps}: grant rows locked last, in id order; first end stands; the database clock reads the expiry after the
 * lock). It never stamps while an installation exists again, and the stamp is never cleared (re-licensing or restoring the org
 * revives nothing, the database guard refuses it).
 *
 * STAMP TIME and CADENCE (the engineering choices #4178's gate leaves to the PR): the stamp is the time the sweep runs (the database
 * clock), NOT the time the licence expired. The state derivation (state.ts) already compares a grant's own end against the stamp
 * (`end <= stamp` reads EXPIRED), so a grant that expired between the lapse and the sweep still reads whichever came first: one
 * choice, one comparison, in both places. The sweep runs every five minutes (jobs/sweepGrantLapse.ts). Until it stamps, a lapsed
 * agent's grant still derives ACTIVE and `isGrantLive` says it allows; that lag is at most one cadence, and nothing is exposed in it,
 * because the reach check (`isAgentInstalledAndLicensed`, cor:acl:140:06) already refuses use to an agent with no installation. The lag bound is one interval after a lapse, plus the 90 s first pass after a boot, and a run judges at most 4000 pairs: a larger backlog finishes over the next runs.
 *
 * NOT covered, disclosed: (c) an App's own soft delete (its grants go with the App) and `uninstalledAt` (#4167) are out of scope and
 * excluded from the candidates; a lapse CURED between two sweeps (a licence renewed, an org restored) is not caught here, because
 * main has no write door that moves a licence's expiry forward or restores an organization (`ensureAgentOrgGrant` leaves an existing
 * row untouched, a revoke is final; no resolver or operation sets an organization's `deletedAt` back to null; checked by grep of the resolvers and operations on 2026-11-21, `origin/main` at the #4179 merge). An out-of-band restore (raw SQL, a support tool) that lands between a lapse and the next sweep would have its
 * grants ended anyway, and the stamp is permanent: that is the cost of the gap and the reason a future door must call the sweep first. A future door that does must call {@link sweepLapsedAgentGrants} (or judge its pairs with
 * `endGrantsOfAgentsNoLongerInstalled`) BEFORE its own write. This sweeper also does not remove register rows (#4172's uninstall door
 * does): the grants are the whole of this issue. The cause code of a lapse waits on #4180 (recorded reasons).
 */
import { Prisma as P, type PrismaClient } from '../../generated/prisma/index.js';
import { lockAppInstallations, resolveAppInstallation } from '../appInstallations.js';
import { ALREADY_ENDED, endAgentGrantsAtApps, type AgentDepartureReason } from './departure.js';


export type LapseSweepCursor = { appId: string; agentId: string };

export interface LapseSweepOutcome {
  pairsJudged: number;
  pairsDeparted: number;
  grantsEnded: number;
  /** Where the next run resumes (the last pair judged), or null when this run reached the end of the candidates and the next starts over. */
  cursor: LapseSweepCursor | null;
}

/** Small pages keep each transaction's installation and grant locks short: the doors wait on the same locks (#4178 BLIND). 80 x 50 = 4000 pairs per run. */
/**
 * #4180 (cause codes): the cause the sweep records. Both lapses it catches (a licence that expired or was revoked behind a derived
 * install, an organization soft-deleted under one) end the installation the org's licence gave, so the closest of the six agent
 * causes is AGENT_LICENSE_REVOKED ("the organization's licence to the agent ... ended its installation"). The sweep does not tell the
 * two lapses apart: no cause names a soft-deleted organization (AGENT_IMPORTER_DELETED is an importing agent's hard delete), and a
 * finer code is #4180's owner's to add. The database fits the code to the holder (hadron_fit_departure_cause), so an agent that is
 * already deleted still records AGENT_DELETED.
 */
export const LAPSE_SWEEP_REASON: AgentDepartureReason = 'AGENT_LICENSE_REVOKED';

const DEFAULT_BATCH = 50;
const DEFAULT_MAX_PAGES = 80;

/**
 * One run, in keyset pages (from `opts.after`, else the start) over the distinct (App, agent) pairs that hold a not-yet-ended agent grant in a live App, so a pair that
 * is still installed (the common case) is judged once per run and never starves one behind it. Each page is ONE transaction:
 * installation locks per App in id order, then one sorted grant lock phase last.
 */
export async function sweepLapsedAgentGrants(
  db: PrismaClient,
  opts: {
    batchSize?: number;
    maxPages?: number;
    after?: LapseSweepCursor | null;
    /**
     * Called after EVERY committed page with the resume point (null at the end), so a caller keeps its cursor even when a later page
     * throws. It must not throw: it runs inside the sweep, after the page has committed, and a throw would abort the run.
     */
    onPage?: (cursor: LapseSweepCursor | null) => void;
  } = {},
): Promise<LapseSweepOutcome> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const out: LapseSweepOutcome = { pairsJudged: 0, pairsDeparted: 0, grantsEnded: 0, cursor: null };
  let cursor: LapseSweepCursor | null = opts.after ?? null;
  for (let page = 0; page < maxPages; page++) {
    const after: P.Sql = cursor ? P.sql`AND (grants.app_id, grants.agent_id) > (${cursor.appId}, ${cursor.agentId})` : P.empty;
    // A grant that has already ended (expired, spent, past its action's limits) is not a candidate: it keeps its first end, and
    // leaving it in would re-select the same pair every run.
    const pairs: Array<{ app_id: string; agent_id: string }> = await db.$queryRaw(P.sql`
      SELECT DISTINCT grants.app_id, grants.agent_id FROM grants
      WHERE grants.agent_id IS NOT NULL AND grants.holder_departed_at IS NULL AND grants.revoked_at IS NULL
        AND NOT ${ALREADY_ENDED}
        AND EXISTS (SELECT 1 FROM apps ap WHERE ap.id = grants.app_id AND ap.deleted_at IS NULL AND ap.uninstalled_at IS NULL)
        ${after}
      ORDER BY grants.app_id, grants.agent_id LIMIT ${batchSize}`);
    if (pairs.length === 0) { out.cursor = null; opts.onPage?.(null); break; }
    const byApp = new Map<string, string[]>();
    for (const p of pairs) byApp.set(p.app_id, [...(byApp.get(p.app_id) ?? []), p.agent_id]);
    const departed = await db.$transaction(async (tx) => {
      const gone: Array<{ appId: string; agentId: string }> = [];
      for (const [appId, agentIds] of byApp) {
        await lockAppInstallations(tx, appId, agentIds);
        for (const agentId of agentIds) {
          if (!(await resolveAppInstallation(tx, appId, agentId))) gone.push({ appId, agentId });
        }
      }
      return { gone, ended: await endAgentGrantsAtApps(tx, gone.map((p) => ({ ...p, reason: LAPSE_SWEEP_REASON }))) };
    }, { timeout: 60_000 });
    out.pairsJudged += pairs.length;
    out.pairsDeparted += departed.gone.length;
    out.grantsEnded += departed.ended;
    const last = pairs[pairs.length - 1];
    cursor = { appId: last.app_id, agentId: last.agent_id };
    // Resume point for the NEXT run: a run that stops at its page cap leaves the cursor where it stopped, so a healthy prefix longer
    // than one run's reach cannot starve the pairs behind it; a run that reaches the end leaves null and the next one starts over.
    out.cursor = pairs.length < batchSize ? null : cursor;
    opts.onPage?.(out.cursor);
    if (pairs.length < batchSize) break;
  }
  return out;
}
