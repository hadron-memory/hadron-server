/**
 * #4455 — the bounded team-read budget, and its typed retryable refusal.
 *
 * `withRosterAppRead` (resolvers.agentTaskMatching.ts) runs the whole roster,
 * composition or utilization read in one interactive RepeatableRead transaction.
 * With the 20 s budget it carried until #4455, each call held one of prod's ~9
 * pool connections for up to 20 s while its serialized statements ran — the
 * P2028 incident's steady holder (#4380: 840 real "Transaction already closed …
 * 20000 ms" errors against 8 pool-wait victims). No client waits that long
 * anyway: the CLI times out at 30 s and the portal at 8 s (portal#2238), so the
 * budget is capped at 5 s, and the pool wait is pinned explicitly at Prisma's
 * own 2 s default so it cannot drift silently. Worst case a caller waits
 * 2 s + 5 s = 7 s and then holds NOTHING — strictly better for every other
 * pool user than one 20 s holder.
 *
 * When the budget runs out, the raw Prisma P2028/P2024 would surface as an
 * INTERNAL_SERVER_ERROR fault (a foreign driver error is never a typed
 * refusal, formatError.ts) — exactly the shape a client cannot safely retry.
 * This module gives that condition its typed form: a `TEAM_READ_BUSY`
 * GraphQLError carrying `retryable: true`, so a client can branch on the code
 * without parsing prose (conventions:the-error-code-is-the-contract-the-prose-is-not).
 * The refusal is an availability signal, not a caller fault, so it stays
 * REPORTED in Sentry — the incident was found by counting these.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';

/** The interactive team-read transaction's total budget (ms). #4455: 5 s; every client's own timeout is longer. */
export const TEAM_READ_TX_TIMEOUT_MS = 5_000;
/** The explicit pool wait before the transaction even starts (ms). Prisma's own default, pinned so it cannot drift. */
export const TEAM_READ_TX_MAX_WAIT_MS = 2_000;

/**
 * The team read (roster, composition, utilization) did not finish within its
 * budget, or the pool stayed busy past `maxWait`. The read held nothing when
 * it refused; the same request is safe to send again.
 */
export class TeamReadBusyError extends GraphQLError {
  constructor() {
    super('The team read could not complete within its read budget; the store is busy. Retry the request.', {
      extensions: { code: 'TEAM_READ_BUSY', retryable: true, budgetMs: TEAM_READ_TX_TIMEOUT_MS },
    });
  }
}

/**
 * Whether `error` is the budget/pool exhaustion of THIS read: Prisma raises
 * P2028 for both an expired interactive-transaction timeout ("Transaction
 * already closed") and an expired `maxWait` ("Unable to start a transaction"),
 * and P2024 when the connection pool itself times out. All three mean "the
 * store was too busy for the bounded read", none is a fault in the read, and
 * only the caller's own $transaction call is wrapped, so a P2028/P2024 seen
 * here is by construction about this read's budget.
 */
export function isPrismaBusyExhaustion(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2028' || error.code === 'P2024');
}
