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

/** Why the read refused: its own transaction budget ran out, or it never got a connection. */
export type TeamReadBusyReason = 'TRANSACTION_BUDGET' | 'POOL_WAIT';

/**
 * The team read (roster, composition, utilization) did not finish within its
 * budget, or the pool stayed busy past `maxWait`. The read held nothing when
 * it refused; the same request is safe to send again — `retryable` states it
 * is SAFE to retry (the read is read-only and holds nothing), not that a
 * retry will succeed: when the app's read is deterministically slow the retry
 * refuses identically, while a pool-wait refusal usually succeeds once the
 * pool drains.
 *
 * The original driver error is preserved on `.cause` — NOT on `.originalError`,
 * which formatError's unwrapper treats as Apollo's wrapper ("the original is on
 * .originalError"); parking the driver error there would unwrap the refusal back
 * to the foreign Prisma error and un-map it. `.cause` is never inspected by the
 * pipeline and never crossed to the client (formatError maps only the extensions
 * below), so tx-timeout, `maxWait` expiry and pool starvation stay
 * distinguishable in logs and Sentry after the typed conversion. The
 * best-effort `reason` extension names the arm: Prisma reuses P2028 for both
 * the expired transaction budget ("Transaction already closed") and the
 * expired `maxWait` ("Unable to start a transaction"), so the P2028 split
 * rides on that message prefix — the code is the contract, `reason` is
 * informational.
 */
export class TeamReadBusyError extends GraphQLError {
  constructor(original: unknown) {
    const reason = busyReason(original);
    super(
      'The team read could not complete within its read budget or pool wait; the store is busy. The read held nothing; the same request is safe to retry.',
      {
        extensions: {
          code: 'TEAM_READ_BUSY',
          retryable: true,
          // The bound that fired, per arm: the transaction budget for TRANSACTION_BUDGET, the
          // pool wait for POOL_WAIT. Sending the 5 s budget on a 2 s pool wait misnamed the bound (#4467).
          ...(reason === 'POOL_WAIT' ? { maxWaitMs: TEAM_READ_TX_MAX_WAIT_MS } : { budgetMs: TEAM_READ_TX_TIMEOUT_MS }),
          reason,
        },
      },
    );
    this.cause = original;
  }
}

/**
 * Which arm of "the store was busy" fired: P2024 is always the pool; P2028
 * splits on Prisma's own message prefix ("Unable to start" is the `maxWait`
 * arm — the query engine's real text is "Unable to start a transaction in the
 * given time."; a Prisma upgrade that rewords it would silently reclassify pool
 * waits, so resolvers.teamReadBudget4455.test.ts pins the installed engine's
 * strings and fails the upgrade instead; "Transaction already closed" is the transaction budget). Anything
 * else converting here still names the budget arm — the safest reading, since
 * the transaction is the thing the caller asked to be bounded.
 */
export function busyReason(error: unknown): TeamReadBusyReason {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2024') return 'POOL_WAIT';
    if (error.code === 'P2028' && /unable to start/i.test(error.message)) return 'POOL_WAIT';
  }
  return 'TRANSACTION_BUDGET';
}

/**
 * Whether `error` is a busy-exhaustion the bounded read converts: Prisma
 * raises P2028 for both an expired interactive-transaction timeout
 * ("Transaction already closed") and an expired `maxWait` ("Unable to start a
 * transaction"), and P2024 when the connection pool itself times out. All
 * three mean "the store was too busy for the bounded read" and none is a
 * fault in the read. The wrapper sees every error raised inside its own
 * $transaction callback and by the $transaction call itself — including a
 * pool-wait a nested loader hit on the ambient `ctx.db` — so a P2028/P2024
 * surfacing here is a busy store, though not necessarily THIS read's own
 * budget; `.cause` keeps the true cause inspectable.
 */
export function isPrismaBusyExhaustion(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2028' || error.code === 'P2024');
}
