/**
 * #2177 — `Agent.extendedBy`: the Agents that DIRECTLY extend this one, read as the caller reads
 * `agent(ref:)`. Visibility is applied before the page is cut, so a page, its `hasMore` and its
 * continuation can never be shaped by an Agent the caller cannot read, and there is no total.
 *
 * Two audiences, one answer. For an ordinary caller the `Query.agent` gate is a SQL predicate
 * (`directReadableAgentFilter`), so the page is one keyset query. A pure App key and a platform
 * admin cannot be expressed in SQL (#1787), so their candidates are read in the same order and each
 * passes `readableNestedAgent`; the scan is bounded, and the continuation advances over every
 * scanned row so a long run of hidden Agents ends in an empty page with `hasMore: true`, never a
 * leak and never a stall. An empty page with `hasMore: true` means "scan incomplete", not "no
 * readable extenders".
 */
import { GraphQLError } from 'graphql';
import type { Context } from './resolvers.helpers.js';
import { isPlatformAdmin } from './resolvers.helpers.js';
import { directReadableAgentFilter, readableNestedAgent } from './resolvers.types.js';
import {
  extendedByAudience, InvalidExtendedByCursorError, openExtendedByCursor, sealExtendedByCursor,
} from '../../../lib/agentExtendedByCursor.js';

export const EXTENDED_BY_DEFAULT_FIRST = 20;
export const EXTENDED_BY_MAX_FIRST = 50;
/** Candidates examined per page on the checked path. */
export const EXTENDED_BY_SCAN_CAP = 500;
const SCAN_BATCH = 100;

const badInput = (message: string) => new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

type Row = { id: string; name: string; deletedAt: Date | null; visibility: string; organizationId: string | null; ownerUserId: string | null };

/** The keyset predicate after (name, id), in the same collation `orderBy` uses. */
const after = (p: { name: string; id: string }) => ({
  OR: [{ name: { gt: p.name } }, { name: p.name, id: { gt: p.id } }],
});

export async function resolveExtendedBy(
  parent: { id: string },
  args: { first?: number | null; after?: string | null },
  ctx: Context,
) {
  const first = args.first ?? EXTENDED_BY_DEFAULT_FIRST;
  if (!Number.isInteger(first) || first < 1 || first > EXTENDED_BY_MAX_FIRST) {
    throw badInput(`first must be between 1 and ${EXTENDED_BY_MAX_FIRST}`);
  }
  const checkedPath = (!!ctx.appId && !ctx.userId && !ctx.impersonation) || (!ctx.impersonation && isPlatformAdmin(ctx));
  const binding = {
    base: parent.id,
    aud: extendedByAudience({
      userId: ctx.userId, appId: ctx.appId, admin: isPlatformAdmin(ctx), impersonationOrgId: ctx.impersonation?.orgId,
    }),
  };

  let position: { name: string; id: string } | null = null;
  if (args.after != null) {
    let id: string;
    try {
      id = openExtendedByCursor(args.after, binding);
    } catch (e) {
      if (e instanceof InvalidExtendedByCursorError) throw badInput('invalid cursor');
      throw e;
    }
    // The position row is the one the token named; it must still be a child of THIS parent.
    const row = await ctx.db.agent.findFirst({ where: { id, extendsAgentId: parent.id }, select: { id: true, name: true } });
    if (!row) throw badInput('invalid cursor');
    position = row;
  }

  const base = { extendsAgentId: parent.id, ...(position ? after(position) : {}) };
  const seal = (id: string) => sealExtendedByCursor(id, binding);

  if (!checkedPath) {
    const readable = await directReadableAgentFilter(ctx);
    const rows = await ctx.db.agent.findMany({
      where: { AND: [base, readable] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: first + 1,
    });
    const items = rows.slice(0, first);
    const hasMore = rows.length > first;
    return { items, hasMore, endCursor: hasMore && items.length > 0 ? seal(items[items.length - 1].id) : null };
  }

  const items: Row[] = [];
  let scanned = 0;
  let last: { name: string; id: string } | null = position;
  let exhausted = false;
  let stopped = false;
  while (items.length < first && scanned < EXTENDED_BY_SCAN_CAP && !exhausted && !stopped) {
    const take = Math.min(SCAN_BATCH, EXTENDED_BY_SCAN_CAP - scanned);
    const batch = await ctx.db.agent.findMany({
      where: { extendsAgentId: parent.id, deletedAt: null, ...(last ? after(last) : {}) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
    });
    if (batch.length < take) exhausted = true;
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      scanned += 1;
      last = { name: row.name, id: row.id };
      if (await readableNestedAgent(ctx, row as unknown as Row)) items.push(row as unknown as Row);
      if (items.length === first) {
        // Stopped mid-batch: whatever follows in this batch is unscanned, so there may be more.
        if (i < batch.length - 1) exhausted = false;
        stopped = true;
        break;
      }
    }
  }
  const hasMore = !exhausted;
  return { items, hasMore, endCursor: hasMore && last ? seal(last.id) : null };
}

export const agentExtendedByFieldResolvers = {
  Agent: { extendedBy: resolveExtendedBy },
};
