/**
 * #2299 — the pure half of searching a chat's history (cor:agt:020:04, "Searching a chat's history"): the contract's
 * numbers, the query and page-size rules, and the cursor. No database here, so the one place the numbers live is also
 * the one place a test can pin them.
 *
 * The numbers are Proposed contract values (Patrick, hadron-server#2299, adopted by the gate), anchored to what the
 * platform already ships: the MCP chat read's own page (20, cap 50) and a bounded scan. They are tunable, so they are
 * constants in ONE file, quoted by the SDL and the MCP tool, never re-typed.
 */

import { createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';

/** The query's length, in Unicode code points of the text exactly as given (no trimming). */
export const TEAM_CHAT_SEARCH_QUERY_MIN = 2;
export const TEAM_CHAT_SEARCH_QUERY_MAX = 200;
/** The most messages one call scans, newest first. */
export const TEAM_CHAT_SEARCH_SCAN_CAP = 1000;
/** Matches per page: the default, and the cap a larger request is clamped to (never refused). */
export const TEAM_CHAT_SEARCH_PAGE_DEFAULT = 20;
export const TEAM_CHAT_SEARCH_PAGE_MAX = 50;

/**
 * Refuse a query outside the bounds, BEFORE any message is read and before the read gate: the bounds are fixed, so the
 * refusal is the same for every caller and discloses nothing about the channel.
 */
export function assertSearchQuery(query: unknown): asserts query is string {
  const length = typeof query === 'string' ? Array.from(query).length : -1;
  if (length < TEAM_CHAT_SEARCH_QUERY_MIN || length > TEAM_CHAT_SEARCH_QUERY_MAX) {
    throw new GraphQLError(
      `The search query must be ${TEAM_CHAT_SEARCH_QUERY_MIN} to ${TEAM_CHAT_SEARCH_QUERY_MAX} characters, counted as typed.`,
      { extensions: { code: 'TEAM_CHAT_SEARCH_QUERY_LENGTH', min: TEAM_CHAT_SEARCH_QUERY_MIN, max: TEAM_CHAT_SEARCH_QUERY_MAX } },
    );
  }
}

/** A page of 1 to the cap: absent is the default, a larger request is clamped, below 1 is refused. */
export function searchPageSize(limit: number | null | undefined): number {
  if (limit == null) return TEAM_CHAT_SEARCH_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new GraphQLError('limit must be at least 1.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return Math.min(limit, TEAM_CHAT_SEARCH_PAGE_MAX);
}

/** The principal a cursor is bound to: a person, an App key, or an App-scoped context, never a client id. */
export function searchCallerKey(ctx: { userId?: string | null; apiKeyId?: string | null; appId?: string | null }): string {
  if (ctx.userId) return `u:${ctx.userId}`;
  if (ctx.apiKeyId) return `k:${ctx.apiKeyId}`;
  if (ctx.appId) return `a:${ctx.appId}`;
  return 'anon';
}

/** What a cursor is bound to. Length-prefixed, so no field can be moved into its neighbour. */
export function searchBinding(query: string, channelId: string, incarnation: number, callerKey: string): string {
  const parts = [query.toLowerCase(), channelId, String(incarnation), callerKey];
  return createHash('sha256').update(parts.map((p) => `${p.length}:${p}`).join('|')).digest('hex').slice(0, 32);
}

const cursorInvalid = (): GraphQLError =>
  new GraphQLError('The search cursor is not valid for this search.', { extensions: { code: 'TEAM_CHAT_SEARCH_CURSOR_INVALID' } });

/** The cursor holds a binding and ONE seq: the next call's exclusive upper bound. Never a message, never text. */
export function encodeSearchCursor(binding: string, beforeSeq: number): string {
  return Buffer.from(JSON.stringify({ b: binding, s: beforeSeq })).toString('base64url');
}

/**
 * The seq a cursor resumes below, or the one refusal for every way a cursor can be wrong (garbage, empty, another
 * query, channel, incarnation or caller), so a refusal never says which.
 */
export function decodeSearchCursor(cursor: string, binding: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { b?: unknown; s?: unknown };
    if (parsed.b === binding && typeof parsed.s === 'number' && Number.isInteger(parsed.s) && parsed.s >= 1) return parsed.s;
  } catch {
    // fall through to the one refusal
  }
  throw cursorInvalid();
}
