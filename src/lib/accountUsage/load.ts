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

/** #3842 — what one selector's read found, and whether the server could finish checking for another history of the label. */
export type AccountCensus = { snaps: UsageSnapshot[]; incomplete: boolean };
/**
 * #3842 — the most rows the probe for another identity reads per selector (V55: rows, not pages; the number may change, the
 * answer may not). A probe that reaches it with rows still unread cannot finish, and the read is `incomplete`.
 */
export const PROBE_ROW_BUDGET = 100_000;

/**
 * The snapshots per selector, as before. It DROPS `incomplete`: the only caller is the account list (`list.ts`), which reads
 * fully qualified selectors that have nothing to probe and so are never incomplete. A projection MUST use
 * {@link loadAccountUsageCensus}. Use {@link loadAccountUsageCensus} when the caller must know the census was cut short. */
export async function loadAccountUsageHistory(db: Context['db'], appId: string, now: Date, accounts: readonly AccountSelector[], maxRows: number = MAX_SNAPSHOT_ROWS, probeBudget: number = PROBE_ROW_BUDGET): Promise<UsageSnapshot[][]> {
  return (await loadAccountUsageCensus(db, appId, now, accounts, maxRows, probeBudget)).map((c) => c.snaps);
}

export async function loadAccountUsageCensus(
  db: Context['db'], appId: string, now: Date, accounts: readonly AccountSelector[], maxRows: number = MAX_SNAPSHOT_ROWS, probeBudget: number = PROBE_ROW_BUDGET,
): Promise<AccountCensus[]> {
  const memoryIds = await resolveAppTeamSpaceMemoryIds(db, appId);
  // One result per selector, in order: two selectors with one label but different identities stay apart.
  const result: AccountCensus[] = accounts.map(() => ({ snaps: [], incomplete: false }));
  if (memoryIds.length === 0) return result;
  // One bounded read per requested account (label, plus host and family when named), so unrelated accounts and other identities can never crowd its history out of the cap.
  for (const [i, sel] of accounts.entries()) {
    const wanted = sel.label;
    const identity = [
      ...(sel.host != null ? [{ properties: { path: ['host'], equals: sel.host } }] : []),
      ...(sel.family != null ? [{ properties: { path: ['family'], equals: sel.family } }] : []),
    ];
    const where = {
      memoryId: { in: memoryIds },
      objectType: ACCOUNT_USAGE_COLLECTION,
      deletedAt: null,
      AND: [{ properties: { path: ['label'], equals: wanted } }, ...identity],
      createdAt: { gte: new Date(now.getTime() - HISTORY_DAYS * 24 * 3_600_000) },
    };
    // `id` is the unique tiebreaker the cursor paging below relies on: rows written in one instant still have one total order.
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const usable = (properties: unknown): UsageSnapshot | null => {
      const snap = parseUsageSnapshot(properties, now);
      return snap && snap.label === wanted
        && (sel.host == null || snap.host === sel.host) && (sel.family == null || snap.family === sel.family) ? snap : null;
    };
    const rows = await db.node.findMany({ where, select: { id: true, properties: true }, orderBy, take: maxRows });
    const snaps = rows.map((r) => usable(r.properties)).filter((x): x is UsageSnapshot => x !== null);
    // The cap can hide another identity of an under-qualified selector (same label, other host or family) behind a busy one,
    // and with it the ambiguity refusal. When the cap was hit, continue the scan, cursor-paged and bounded by `probeBudget`
    // rows, over every row NOT of the first valid identity seen (a malformed row neither seeds nor consumes the probe: only a
    // valid snapshot counts, so the scan continues past invalid rows). Three ends (#3842, V55): a second valid identity is found
    // (the ambiguity refusal then applies), the rows are exhausted (complete), or the budget is spent with rows unread, which is
    // `incomplete`: the server could not finish checking, so the caller answers UNKNOWN / HISTORY_INCOMPLETE, never a definitive
    // answer from one identity. A qualified selector (host and family named) has nothing to probe and is never incomplete.
    // V15: nothing here authorizes; anyone who can write the usage memory can skew an advisory number.
    let incomplete = false;
    if (rows.length >= maxRows && (sel.host == null || sel.family == null)) {
      const seen = snaps[0];
      const scan = seen
        ? { ...where, NOT: [{ AND: [{ properties: { path: ['host'], equals: seen.host ?? '' } }, { properties: { path: ['family'], equals: seen.family ?? '' } }] }] }
        : where;
      // With no valid row yet the first page was all malformed: the scan continues after it, so those rows are not read twice.
      let cursor: string | null = null;
      let read = 0;
      let found = false;
      for (;;) {
        const take = Math.min(maxRows, probeBudget - read);
        if (take <= 0) { incomplete = true; break; }
        // One row of lookahead says whether anything is left once this page is judged (its properties are fetched and unused: an
        // advisory read, bounded by the budget, accepted over a second query).
        const page: { id: string; properties: unknown }[] = await db.node.findMany({
          where: scan, select: { id: true, properties: true }, orderBy, take: take + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : seen ? {} : { cursor: { id: rows.at(-1)!.id }, skip: 1 }),
        });
        const judged = page.slice(0, take);
        read += judged.length;
        for (const r of judged) {
          const snap = usable(r.properties);
          if (!snap) continue;
          snaps.push(snap);
          const first = snaps[0]!;
          if (snap.host !== first.host || snap.family !== first.family) found = true;
        }
        if (found) break;
        if (page.length <= take) break; // rows exhausted: complete
        cursor = judged.at(-1)!.id;
      }
    }
    result[i] = { snaps, incomplete };
  }
  return result;
}
