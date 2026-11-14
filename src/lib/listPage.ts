/** Offset cursors for mutable live lists (#4123); scoped to the owner and filter, not a snapshot reservation. */
import { GraphQLError } from 'graphql';
export interface ListPageArgs { first?: number | null; after?: string | null }
export interface ListPage<T> { items: T[]; hasMore: boolean; nextCursor: string | null }
const invalid = () => new GraphQLError('Invalid page cursor or size.', { extensions: { code: 'BAD_USER_INPUT' } });
export function listPageArgs(args: ListPageArgs, scope: string): { take: number; offset: number } {
  const first = args.first ?? 20;
  if (!Number.isSafeInteger(first)) throw invalid();
  const take = Math.min(100, Math.max(1, first));
  if (args.after == null) return { take, offset: 0 };
  try {
    if (args.after.length > 2048) throw invalid();
    const cursor = JSON.parse(Buffer.from(args.after, 'base64url').toString('utf8'));
    if (cursor.scope !== scope || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 2_147_483_547) throw invalid();
    return { take, offset: cursor.offset };
  } catch { throw invalid(); }
}
/** Pass at most take+1 rows, or an already materialized bounded-owner live list. */
export function listPage<T>(rows: readonly T[], take: number, offset: number, scope: string): ListPage<T> {
  const items = rows.slice(0, take), hasMore = rows.length > take;
  return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ scope, offset: offset + items.length })).toString('base64url') : null };
}
