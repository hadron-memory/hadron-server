/**
 * #3820 — the usage history the projection reads: the `account-usage` objects (nodes with `objectType` 'account-usage')
 * in the memories that ARE the App's team space, and nowhere else (V9: a memory the team App owns). Pair with the roster's
 * read gate: this answers "what history", never "may the caller see it".
 */
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { resolveAppTeamSpaceMemoryIds } from '../../api/graphql/schema/resolvers.helpers.js';
import { ACCOUNT_USAGE_COLLECTION, parseUsageSnapshot, type UsageSnapshot } from './projection.js';

/** Fourteen days of history is more than the weekly shape needs (it asks for a week plus the cycle in flight). */
export const HISTORY_DAYS = 14;
/** A bound on one read: 14 days at the collector's 15-minute interval is 1344 records per account. */
export const MAX_SNAPSHOT_ROWS = 20_000;

export async function loadAccountUsageHistory(db: Context['db'], appId: string, now: Date): Promise<Map<string, UsageSnapshot[]>> {
  const memoryIds = await resolveAppTeamSpaceMemoryIds(db, appId);
  const byLabel = new Map<string, UsageSnapshot[]>();
  if (memoryIds.length === 0) return byLabel;
  const rows = await db.node.findMany({
    where: {
      memoryId: { in: memoryIds },
      objectType: ACCOUNT_USAGE_COLLECTION,
      deletedAt: null,
      createdAt: { gte: new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000) },
    },
    select: { properties: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_SNAPSHOT_ROWS,
  });
  for (const row of rows) {
    const snap = parseUsageSnapshot(row.properties, now);
    if (!snap) continue;
    const list = byLabel.get(snap.label);
    if (list) list.push(snap); else byLabel.set(snap.label, [snap]);
  }
  return byLabel;
}
