/** #4123 / cor:api:120:05: authenticated row-value cursors alongside explicit offset paging. */
import { GraphQLError } from 'graphql';
import { decryptBytesAad, encryptBytesAad } from './tokenCrypto.js';

export interface ListPageArgs { first?: number | null; after?: string | null; offset?: number | null }
export interface ListPage<T> { items: T[]; total: number; hasMore: boolean; nextCursor: string | null }
export interface ListPosition { id: string; createdAt?: string }
type ListOrder = 'id-asc' | 'createdAt-desc-id-desc';
export interface ListWindow { take: number; offset: number; after: ListPosition | null; scope: string; order: ListOrder }
const MAX_CURSOR_LENGTH = 16_384;
const invalid = () => new GraphQLError('Invalid page cursor or size.', { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * The cap and default of a `listPageArgs` list (cor:api:120:04): a stated `first` over the cap is served as the cap, never
 * refused. One definition, shared by the resolvers' clamp below and by complexity admission, so the rows admission charges
 * for are the rows the resolver reads and the two cannot drift (#4390).
 */
export const LIST_PAGE_DEFAULT = 20;
export const LIST_PAGE_CAP = 100;
/** How many rows a stated `first` reads: the same clamp `validateListPageInput` applies (an unusable value is refused there, before any read). */
export function listPageTake(first: number | null | undefined): number {
  return Math.min(LIST_PAGE_CAP, Math.max(1, first ?? LIST_PAGE_DEFAULT));
}

/** Validate the mutually exclusive selectors before any authorization/list lookup (rule point 4). */
export function validateListPageInput(args: ListPageArgs): { take: number; offset: number } {
  if (args.after != null && args.offset != null) throw invalid();
  const first = args.first ?? LIST_PAGE_DEFAULT, offset = args.offset ?? 0;
  if (!Number.isSafeInteger(first) || !Number.isInteger(offset) || offset < 0 || offset > 2_147_483_647) throw invalid();
  return { take: listPageTake(first), offset };
}
const aad = (scope: string, order: ListOrder) => `hadron:list-page:v1:${JSON.stringify([scope, order])}`;

/** The same refusal covers malformed, edited, cross-list, wrong-order and wrong-filter cursors. No anchor lookup. */
export function listPageArgs(args: ListPageArgs, scope: string, order: ListOrder = 'id-asc'): ListWindow {
  const { take, offset } = validateListPageInput(args);
  if (args.after == null) return { take, offset, after: null, scope, order };
  try {
    const token = args.after;
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw invalid();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw invalid();
    const cursor = JSON.parse(decryptBytesAad(bytes.toString('base64'), aad(scope, order)).toString('utf8'));
    const last = cursor.last;
    if (cursor.v !== 1 || typeof last?.id !== 'string' || last.id.length === 0) throw invalid();
    if (order === 'createdAt-desc-id-desc') {
      if (typeof last.createdAt !== 'string' || new Date(last.createdAt).toISOString() !== last.createdAt) throw invalid();
    } else if (last.createdAt !== undefined) throw invalid();
    return { take, offset: 0, after: last, scope, order };
  } catch { throw invalid(); }
}

/** Rows are already in total order and limited to take+1; total is the full freshly admitted/filter-matching set. */
export function listPage<T>(rows: readonly T[], window: ListWindow, total: number, key: (row: T) => ListPosition): ListPage<T> {
  const items = rows.slice(0, window.take), hasMore = rows.length > window.take;
  let nextCursor: string | null = null;
  if (hasMore) {
    const payload = Buffer.from(JSON.stringify({ v: 1, last: key(items[items.length - 1]) }));
    nextCursor = Buffer.from(encryptBytesAad(payload, aad(window.scope, window.order)), 'base64').toString('base64url');
    if (nextCursor.length > MAX_CURSOR_LENGTH) throw new Error('List cursor exceeds supported size.');
  }
  return { items, total, hasMore, nextCursor };
}

/** Materialized provider lists use the same row boundary; deleted anchors never need to be found again. */
export function idListRows<T>(rows: readonly T[], window: ListWindow, key: (row: T) => string): { rows: T[]; total: number } {
  const ordered = [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const remaining = window.after ? ordered.filter(row => key(row) > window.after!.id) : ordered.slice(window.offset);
  return { rows: remaining.slice(0, window.take + 1), total: ordered.length };
}
export function idListPage<T>(rows: readonly T[], window: ListWindow, key: (row: T) => string): ListPage<T> {
  const result = idListRows(rows, window, key);
  return listPage(result.rows, window, result.total, row => ({ id: key(row) }));
}
