/** #4098: deterministic assertions on the commit-safe forward feed; negative interleaving pins deliberately do NOT use this. */
import { vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/index.js';

/**
 * #4316 item 3: a file whose tests wait on the horizon sets its own 30 s timeout by calling this, replacing the
 * import side effect this module used to have (a top-level `vi.setConfig` on every importer). xmin is
 * cluster-wide: another transaction can briefly delay an otherwise committed fixture, so waiting can legitimately
 * outgrow the default 5 s.
 */
export function useTeamEventHorizonTimeout(): void {
  vi.setConfig({ testTimeout: 30_000 });
}
export async function settleTeamEventHorizon(db: Pick<PrismaClient, '$queryRaw'>): Promise<void> {
  const [{ x }] = await db.$queryRaw<Array<{ x: string }>>`SELECT pg_current_xact_id()::text AS x`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ done }] = await db.$queryRaw<Array<{ done: boolean }>>`
      SELECT pg_snapshot_xmin(pg_current_snapshot()) > ${x}::xid8 AS done`;
    if (done) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('team event horizon: an older transaction stayed open for 10 seconds');
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
