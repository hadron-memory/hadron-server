/**
 * #415 Slice 1: the database time budget for one regex search statement.
 *
 * `findNodes(mode: regex)` runs a caller-supplied POSIX pattern against every
 * text field of every node in scope, so one statement's cost is the caller's
 * to choose. The budget bounds the DATABASE work: it is applied as a
 * transaction-local `statement_timeout` on the same connection as the search,
 * so Postgres itself cancels the statement, and commit, rollback or
 * cancellation all end it with the transaction. It never reaches the pooled
 * connection's session, so no later request inherits it.
 *
 * This is an engineering bound inside the existing regex contract
 * (cor:api:090:01), not product policy: no pattern restriction, refusal code
 * or quota comes with it (those are #415 Slice 2).
 *
 * 5s is generous for a legitimate search (an indexed-scope regex over a large
 * memory set finishes in well under a second) and caps how long one request
 * can hold a pooled connection. `REGEX_SEARCH_TIMEOUT_MS` overrides it, read
 * per call. Only a positive integer is accepted: 0 would mean "no timeout" to
 * Postgres, so a zero, negative or malformed value falls back to the default
 * rather than widening the bound.
 */

export const REGEX_SEARCH_TIMEOUT_DEFAULT_MS = 5_000;

export function regexSearchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGEX_SEARCH_TIMEOUT_MS?.trim();
  if (raw && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return REGEX_SEARCH_TIMEOUT_DEFAULT_MS;
}
