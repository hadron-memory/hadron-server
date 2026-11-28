/** #4098: deterministic assertions on the commit-safe forward feed; negative interleaving pins deliberately do NOT use this. */
import { vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/index.js';

/**
 * #4316 item 3: a file whose tests wait on the horizon sets its own 60 s timeout by calling this, replacing the
 * import side effect this module used to have (a top-level `vi.setConfig` on every importer). xmin is
 * cluster-wide: another transaction can briefly delay an otherwise committed fixture, so waiting can legitimately
 * outgrow the default 5 s. 60 s covers a settle's 20 s budget twice (#5165).
 */
export function useTeamEventHorizonTimeout(): void {
  vi.setConfig({ testTimeout: 60_000 });
}
/** Wait budget for one settle. The horizon is instance-wide (cor:agt:050:11), so another file's open transaction can hold it. */
export const TEAM_EVENT_HORIZON_WAIT_MS = 20_000;
const POLL_MS = 50;
/**
 * #5165: on a timeout, name the holders (test output only, never a product log line). Rows come from
 * pg_stat_activity for the whole instance, because the horizon is the oldest open transaction on the instance.
 */
async function describeHorizonHolders(db: Pick<PrismaClient, '$queryRaw'>): Promise<string> {
  try {
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>`
      SELECT pid, datname, state, wait_event_type, wait_event,
             backend_xid::text AS backend_xid, backend_xmin::text AS backend_xmin,
             to_char(now() - xact_start, 'HH24:MI:SS.MS') AS xact_age,
             left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
        FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND xact_start IS NOT NULL
         AND (backend_xid IS NOT NULL OR backend_xmin IS NOT NULL)
       ORDER BY xact_start ASC LIMIT 10`;
    return rows.length ? JSON.stringify(rows) : 'none visible in pg_stat_activity';
  } catch (error) {
    return `holder lookup failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
export async function settleTeamEventHorizon(
  db: Pick<PrismaClient, '$queryRaw'>,
  options: { budgetMs?: number } = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? TEAM_EVENT_HORIZON_WAIT_MS;
  const [{ x }] = await db.$queryRaw<Array<{ x: string }>>`SELECT pg_current_xact_id()::text AS x`;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const [{ done }] = await db.$queryRaw<Array<{ done: boolean }>>`
      SELECT pg_snapshot_xmin(pg_current_snapshot()) > ${x}::xid8 AS done`;
    if (done) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `team event horizon: an older transaction stayed open for ${Math.round(budgetMs / 1000)} seconds; holders: ${await describeHorizonHolders(db)}`,
  );
}
/** Preserve the real resolvers/gates; only wait before positive forward-read fixture assertions. */
export function settledTeamEventQueries<T extends Record<string, any>>(queries: T, db: Pick<PrismaClient, '$queryRaw'>): T {
  const wrapped = { ...queries };
  for (const name of ['agentTeamEvents', 'agentTeamEventsPage']) {
    const read = queries[name];
    if (typeof read !== 'function') continue;
    (wrapped as Record<string, any>)[name] = async (...args: any[]) => {
      if (args[1]?.newestFirst !== true) await settleTeamEventHorizon(db);
      return read(...args);
    };
  }
  return wrapped;
}
