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
/** A bound on one read of one account: 14 days at the collector's 15-minute interval is 1344 records per account. */
export const MAX_SNAPSHOT_ROWS = 20_000;

/** An account to read: its label, and the host and family when the caller names them (an account is all three, cor:agt:140:01). */
export type AccountSelector = { label: string; host?: string | null; family?: string | null };

export async function loadAccountUsageHistory(db: Context['db'], appId: string, now: Date, accounts: readonly AccountSelector[], maxRows: number = MAX_SNAPSHOT_ROWS): Promise<UsageSnapshot[][]> {
  const memoryIds = await resolveAppTeamSpaceMemoryIds(db, appId);
  // One list per selector, in order: two selectors with one label but different identities stay apart.
  const result: UsageSnapshot[][] = accounts.map(() => []);
  if (memoryIds.length === 0) return result;
  // One bounded read per requested account (label, plus host and family when named), so unrelated accounts and other identities can never crowd its history out of the cap.
  for (const [i, sel] of accounts.entries()) {
    const wanted = sel.label;
    const identity = [
      ...(sel.host != null ? [{ properties: { path: ['host'], equals: sel.host } }] : []),
      ...(sel.family != null ? [{ properties: { path: ['family'], equals: sel.family } }] : []),
    ];
    const rows = await db.node.findMany({
      where: {
        memoryId: { in: memoryIds },
        objectType: ACCOUNT_USAGE_COLLECTION,
        deletedAt: null,
        AND: [{ properties: { path: ['label'], equals: wanted } }, ...identity],
        createdAt: { gte: new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000) },
      },
      select: { properties: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: maxRows,
    });
    // The cap can hide another identity of an under-qualified selector (same label, other host or family) behind a busy one,
    // and with it the ambiguity refusal. When the cap was hit, probe once for a row of any other identity and keep it.
    if (rows.length >= maxRows && (sel.host == null || sel.family == null)) {
      const seen = parseUsageSnapshot(rows[0]!.properties, now);
      if (seen) {
        const other = await db.node.findFirst({
          where: {
            memoryId: { in: memoryIds },
            objectType: ACCOUNT_USAGE_COLLECTION,
            deletedAt: null,
            AND: [{ properties: { path: ['label'], equals: wanted } }, ...identity],
            NOT: [{ AND: [{ properties: { path: ['host'], equals: seen.host ?? '' } }, { properties: { path: ['family'], equals: seen.family ?? '' } }] }],
            createdAt: { gte: new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000) },
          },
          select: { properties: true },
        });
        if (other) rows.push(other);
      }
    }
    for (const row of rows) {
      const snap = parseUsageSnapshot(row.properties, now);
      if (!snap || snap.label !== wanted
        || (sel.host != null && snap.host !== sel.host) || (sel.family != null && snap.family !== sel.family)) continue;
      result[i]!.push(snap);
    }
  }
  return result;
}
