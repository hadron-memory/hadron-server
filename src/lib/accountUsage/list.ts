/**
 * #3853 — the usage accounts an App has history for (cor:agt:140:05; Vera V64, V65). Pair with the read gate
 * (`withReadableApp`): this answers "which accounts", never "may the caller see them".
 *
 * An account is a label, a host and a family (cor:agt:140:01). It is listed only if `accountUsageProjection` would find
 * history for it: valid snapshots in the memories the team App owns (V9, `resolveAppTeamSpaceMemoryIds`) over the projection's
 * horizon, which is on WRITE time (`createdAt`), as in `loadAccountUsageHistory`.
 *
 * Distinct identities are found in SQL and the bound is applied to IDENTITIES, never to rows: a row cap would let one busy
 * account crowd a quiet one out (hadron-server:findings:row-cap-before-distinct-identity-misses-ambiguity). The SQL preconditions
 * only narrow; validity and "newest" come from `loadAccountUsageHistory` and `newestSnapshot`, the projection's own definitions,
 * so SQL and JS disagreeing can only DROP an entry, never list one the projection would refuse.
 *
 * A row written between the identity query and the history read can only add a newer snapshot to a listed account:
 * acceptable for an advisory list (V15).
 */
import { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolveAppTeamSpaceMemoryIds } from '../../api/graphql/schema/resolvers.helpers.js';
import { HISTORY_DAYS, loadAccountUsageHistory } from './load.js';
import { ACCOUNT_USAGE_COLLECTION, newestSnapshot } from './projection.js';

/** At most this many accounts per answer (V65; the bound is tunable, the flag is contract). */
export const MAX_LISTED_ACCOUNTS = 50;
/**
 * At most this many candidate identities are examined looking for listable ones (LOCAL P2-F1, #3853): the bound of 50 counts
 * accounts the projection would find history for, never candidates the validity step later drops, so a flood of invalid
 * identities cannot hide a valid one. The search itself is bounded; running out of it reports the list incomplete.
 */
export const MAX_EXAMINED_IDENTITIES = 200;
const VALIDATE_CHUNK = 50;

export type ListedUsageAccount = {
  account: string; host: string; family: string; newestSnapshotAt: Date; workers: string[]; workersConfigured: boolean;
};

export async function listUsageAccounts(
  db: Context['db'], appId: string, now: Date, maxAccounts: number = MAX_LISTED_ACCOUNTS, maxExamined: number = MAX_EXAMINED_IDENTITIES,
): Promise<{ asOf: Date; accounts: ListedUsageAccount[]; complete: boolean }> {
  const empty = { asOf: now, accounts: [] as ListedUsageAccount[], complete: true };
  const memoryIds = await resolveAppTeamSpaceMemoryIds(db, appId);
  if (memoryIds.length === 0) return empty;
  const horizon = new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000);
  // Most recently written identities first; one extra row says whether candidates remain beyond the search bound.
  const found = await db.$queryRaw<Array<{ label: string; host: string; family: string }>>(Prisma.sql`
    SELECT properties->>'label' AS label, properties->>'host' AS host, properties->>'family' AS family
    FROM nodes
    WHERE memory_id IN (${Prisma.join(memoryIds)})
      AND object_type = ${ACCOUNT_USAGE_COLLECTION}
      AND deleted_at IS NULL
      AND created_at >= ${horizon}
      AND properties->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof(properties->'label') = 'string' AND properties->>'label' <> ''
      AND jsonb_typeof(properties->'host') = 'string' AND properties->>'host' <> ''
      AND jsonb_typeof(properties->'family') = 'string' AND properties->>'family' <> ''
    GROUP BY 1, 2, 3
    ORDER BY max(created_at) DESC, 1, 2, 3
    LIMIT ${maxExamined + 1}`);
  const searchCut = found.length > maxExamined;
  const candidates = found.slice(0, maxExamined);
  // Validate in recency order, in chunks, until one more than the bound is listable (that one says "more exist") or the
  // candidates run out. Validity and newest come from the projection's own definitions (`loadAccountUsageHistory`).
  const listable: ListedUsageAccount[] = [];
  for (let at = 0; at < candidates.length && listable.length <= maxAccounts; at += VALIDATE_CHUNK) {
    const chunk = candidates.slice(at, at + VALIDATE_CHUNK);
    const histories = await loadAccountUsageHistory(db, appId, now, chunk);
    for (const [i, c] of chunk.entries()) {
      const latest = newestSnapshot(histories[i] ?? []);
      // No valid snapshot: the projection would answer NO_HISTORY, so the account is not listed and takes no slot.
      if (!latest || latest.host === null || latest.family === null) continue;
      listable.push({
        account: c.label, host: latest.host, family: latest.family, newestSnapshotAt: latest.observedAt,
        workers: latest.workers, workersConfigured: latest.workersConfigured,
      });
    }
  }
  const kept = listable.slice(0, maxAccounts);
  // Complete only if nothing listable was left out: no extra listable account, and the search did not stop short.
  const complete = listable.length <= maxAccounts && !searchCut;
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => cmp(a.account, b.account) || cmp(a.host, b.host) || cmp(a.family, b.family));
  return { asOf: now, accounts: kept, complete };
}
