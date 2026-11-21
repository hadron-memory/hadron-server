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
 * does): the grants are the whole of this issue. Each departure records its cause (#4180): see {@link lapseCauses}.
 */
import { Prisma as P, type PrismaClient } from '../../generated/prisma/index.js';
import { lockAppInstallations, resolveAppInstallation } from '../appInstallations.js';
import { ALREADY_ENDED, endAgentGrantsAtApps, type AgentDepartureReason } from './departure.js';
import { GRANT_DB_NOW } from './live.js';

/**
 * #4180 (Bruce's ruling on #4706 x #4696, option B): the cause each departed pair records, read from the evidence of the lapse in the
 * sweep's own transaction, after the installation locks, on the database clock. One statement, in this order:
 *   * ORG_DELETED: the App's organization or the agent's own one is soft-deleted (either ends a derived installation; it outranks a
 *     lapsed licence in the same pair, since the organization's deletion takes its licences with it);
 *   * AGENT_LICENSE_REVOKED: the App's organization's licence to the agent (agent_org_grants) is revoked (the act outranks the clock);
 *   * AGENT_LICENSE_EXPIRED: that licence is past its expiry;
 *   * otherwise AGENT_UNINSTALLED, the plain loss of the installation: the pair has no installation and none of the lapse evidence
 *     above (for example a licence never activated, or an installation witness removed by a path with no door of its own). Disclosed
 *     on #4706's fix PR as the one fallback.
 * The recorded cause still yields to what already happened to the holder (an agent already deleted records AGENT_DELETED), through
 * the one fit in {@link endAgentGrantsAtApps}.
 */
async function lapseCauses(
  tx: P.TransactionClient,
  pairs: ReadonlyArray<{ appId: string; agentId: string }>,
): Promise<Array<{ appId: string; agentId: string; reason: AgentDepartureReason }>> {
  if (pairs.length === 0) return [];
  const rows: Array<{ app_id: string; agent_id: string; reason: AgentDepartureReason }> = await tx.$queryRaw(P.sql`
    SELECT p.app_id, p.agent_id,
      CASE WHEN o.deleted_at IS NOT NULL OR ao.deleted_at IS NOT NULL THEN 'ORG_DELETED'
           WHEN g.revoked_at IS NOT NULL THEN 'AGENT_LICENSE_REVOKED'
           WHEN g.expires_at IS NOT NULL AND g.expires_at <= ${GRANT_DB_NOW} THEN 'AGENT_LICENSE_EXPIRED'
           ELSE 'AGENT_UNINSTALLED' END AS reason
    FROM unnest(${pairs.map((p) => p.appId)}::text[], ${pairs.map((p) => p.agentId)}::text[]) AS p(app_id, agent_id)
    LEFT JOIN apps a ON a.id = p.app_id
    LEFT JOIN organizations o ON o.id = a.organization_id
    LEFT JOIN agents ag ON ag.id = p.agent_id
    LEFT JOIN organizations ao ON ao.id = ag.organization_id
    LEFT JOIN agent_org_grants g ON g.org_id = a.organization_id AND g.agent_id = p.agent_id`);
  const byPair = new Map(rows.map((r) => [`${r.app_id}\u0000${r.agent_id}`, r.reason]));
  return pairs.map((p) => ({ ...p, reason: byPair.get(`${p.appId}\u0000${p.agentId}`) ?? 'AGENT_UNINSTALLED' }));
}


export type LapseSweepCursor = { appId: string; agentId: string };

export interface LapseSweepOutcome {
  pairsJudged: number;
  pairsDeparted: number;
  grantsEnded: number;
  /** Where the next run resumes (the last pair judged), or null when this run reached the end of the candidates and the next starts over. */
  cursor: LapseSweepCursor | null;
}

/** Small pages keep each transaction's installation and grant locks short: the doors wait on the same locks (#4178 BLIND). 80 x 50 = 4000 pairs per run. */
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
      return { gone, ended: await endAgentGrantsAtApps(tx, await lapseCauses(tx, gone)) };
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
