/**
 * #4471 — a busy store during request authentication, typed and retryable.
 *
 * The API-key arms of `resolveAuthContextInner` (src/middleware/auth.ts) read
 * the store (a `findUnique` by key hash) before any resolver runs, so a pool
 * wait there — Prisma P2024 ('Timed out fetching a new connection from the
 * connection pool'), or the P2028 'Unable to start a transaction' class —
 * rejected the Apollo context builder and reached the client as an untyped
 * INTERNAL_SERVER_ERROR context failure: 176 of the roster incident's failures
 * stayed untyped exactly this way (Brooks's #4460 QA, shape 2b; #4380), and
 * #4455's TEAM_READ_BUSY could not cover them because no resolver had run yet.
 *
 * This module is that condition's typed form, the same convention as #4455's
 * TEAM_READ_BUSY: a stable `code`, `retryable: true` (the check wrote nothing;
 * the same request is safe to send again), a best-effort `reason` naming the
 * arm — and NO driver text, host or connection detail on the wire. The code is
 * the contract (conventions:the-error-code-is-the-contract-the-prose-is-not);
 * `reason` is informational. The original driver error rides on `.cause` —
 * never on `.originalError`, which formatError's unwrapper treats as Apollo's
 * wrapper — so pool-wait and start-wait stay distinguishable in the log after
 * the typed conversion, without the detail crossing to the client.
 *
 * cor:aut:010:05 S5: a check that could not complete is the internal error,
 * NEVER a refusal — a busy store during the API-key check must not surface as
 * a refused credential. Like TEAM_READ_BUSY, this is an availability signal,
 * not a caller fault, so it stays REPORTED in Sentry (the #4380 incident was
 * found by counting these).
 *
 * `busyReason`/`isPrismaBusyExhaustion` are #4455's shared Prisma busy
 * classifier, imported from their first home rather than duplicated; a third
 * consumer would justify extracting them to a Prisma-generic module.
 */
import { GraphQLError } from 'graphql';
import { busyReason } from '../agentTasks/teamReadBudget.js';

/** The typed, retryable code for 'request authentication could not complete: the store was busy'. */
export const AUTH_STORE_BUSY_CODE = 'AUTH_STORE_BUSY';

/**
 * Request authentication could not complete: the store was too busy to answer
 * the credential lookup. The request wrote nothing and authenticated nobody,
 * so the same request is safe to send again — `retryable` states it is SAFE to
 * retry, not that a retry will succeed: while the pool is drained the retry
 * refuses identically, and it clears once the pool drains.
 */
export class AuthStoreBusyError extends GraphQLError {
  constructor(original: unknown) {
    super(
      'Authentication could not complete: the store was busy. Nothing was written; the same request is safe to retry.',
      {
        extensions: {
          code: AUTH_STORE_BUSY_CODE,
          retryable: true,
          reason: busyReason(original),
          // An availability signal, not a fault: 503 says "retry later" to every
          // client, GraphQL-parsing or not (the CLI maps it to its Unavailable
          // class). Only the pool-wait arm is reachable on the auth paths — they
          // run no interactive transaction — so a P2028 budget-shape would still
          // convert with the classifier's safe default arm.
          http: { status: 503 },
        },
      },
    );
    this.cause = original;
  }
}
