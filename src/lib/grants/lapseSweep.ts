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
 * row untouched, a revoke is final; no resolver or operation sets an organization's `deletedAt` back to null; checked by grep at
 * `origin/main` 5dbfa8282). An out-of-band restore (raw SQL, a support tool) that lands between a lapse and the next sweep would have its
 * grants ended anyway, and the stamp is permanent: that is the cost of the gap and the reason a future door must call the sweep first. A future door that does must call {@link sweepLapsedAgentGrants} (or judge its pairs with
 * `endGrantsOfAgentsNoLongerInstalled`) BEFORE its own write. This sweeper also does not remove register rows (#4172's uninstall door
 * does): the grants are the whole of this issue. The cause code of a lapse waits on #4180 (recorded reasons).
 */
import { Prisma as P, type PrismaClient } from '../../generated/prisma/index.js';
import { lockAppInstallations, resolveAppInstallation } from '../appInstallations.js';
import { ALREADY_ENDED, endAgentGrantsAtApps } from './departure.js';


export interface LapseSweepOutcome { pairsJudged: number; pairsDeparted: number; grantsEnded: number }

/** Small pages keep each transaction's installation and grant locks short: the doors wait on the same locks (#4178 BLIND). 80 x 50 = 4000 pairs per run. */
const DEFAULT_BATCH = 50;
const DEFAULT_MAX_PAGES = 80;

/**
 * One run, in keyset pages over the distinct (App, agent) pairs that hold a not-yet-ended agent grant in a live App, so a pair that
 * is still installed (the common case) is judged once per run and never starves one behind it. Each page is ONE transaction:
 * installation locks per App in id order, then one sorted grant lock phase last.
 */
export async function sweepLapsedAgentGrants(
  db: PrismaClient,
  opts: { batchSize?: number; maxPages?: number } = {},
): Promise<LapseSweepOutcome> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const out: LapseSweepOutcome = { pairsJudged: 0, pairsDeparted: 0, grantsEnded: 0 };
  let cursor: { appId: string; agentId: string } | null = null;
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
    if (pairs.length === 0) break;
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
      return { gone, ended: await endAgentGrantsAtApps(tx, gone) };
    }, { timeout: 60_000 });
    out.pairsJudged += pairs.length;
    out.pairsDeparted += departed.gone.length;
    out.grantsEnded += departed.ended;
    const last = pairs[pairs.length - 1];
    cursor = { appId: last.app_id, agentId: last.agent_id };
    if (pairs.length < batchSize) break;
  }
  return out;
}
