/**
 * #4471 — a busy store during the API-key credential check, typed and retryable (cor:agt:040:12).
 *
 * The App-key and user-API-key paths resolve their credential by one hash lookup
 * (`appKey.findUnique` / `userApiKey.findUnique`). When the store is too busy to answer it —
 * the pool timed out (P2024) or a transaction could not start within `maxWait` (P2028's
 * "Unable to start" arm) — the lookup rejects, and before #4471 that rejection propagated raw:
 * through the Apollo context builder it reached clients as an untyped INTERNAL_SERVER_ERROR,
 * and through the plain HTTP routes as the generic #1789 envelope.
 *
 * The typed conversion reuses the MEANING of `unavailable` (cor:aut:010:05, #3532): a credential
 * was presented and the check could not complete — that is never a verdict. A pool blip must not
 * read as "bad key": the check wrote nothing (the lookup is a read; the `lastUsedAt` stamp fires
 * only after a successful resolve), and the same request is safe to send again, so the request-
 * level error is typed RETRYABLE rather than let the request proceed as anonymous and pick up an
 * UNAUTHENTICATED refusal that misnames the fault (S5: a check that cannot complete is the
 * internal error, never refused).
 *
 * Scope, deliberately narrow — the mapping point is `resolveAuthContextInner`'s two API-key
 * resolvers only (`src/middleware/auth.ts`):
 *   - the JWT path keeps its own ruled catch (#3532, rulings 0192–0194): a fault there marks the
 *     context `unavailable` and the request proceeds; changing that is a behavior change beyond
 *     this issue;
 *   - a statement cancel during the lookup (P2010/57014/25P04, #4476's shapes) is a bounded-read
 *     concept and stays untyped here: no credential lookup runs under a caller-chosen budget;
 *   - every other fault (a P2028 that is not the "Unable to start" arm included) is a real fault
 *     and keeps today's generic handling.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';

/** Fixed prose, so no driver text can ride the message onto the wire. */
export const AUTH_STORE_BUSY_MESSAGE =
  'The credential check could not complete: the store was too busy to answer it. No verdict was reached; nothing was written. The same request is safe to retry.';

/** The store stayed busy past its pool wait while checking a presented API key. */
export class AuthStoreBusyError extends GraphQLError {
  constructor(original: unknown) {
    super(AUTH_STORE_BUSY_MESSAGE, {
      extensions: {
        code: 'AUTH_STORE_BUSY',
        // SAFE to retry (the check held nothing), not "a retry will succeed" — the same
        // convention TEAM_READ_BUSY states (#4460/#4455).
        retryable: true,
        // Both classified arms are pool-acquisition waits, so one reason. There is no auth-side
        // bound to name: teamReadBudget's maxWaitMs/budgetMs name ITS bounds (#4467); the
        // credential check runs on the pool's own defaults.
        reason: 'POOL_WAIT',
        // The context-builder surface (#1303's mechanism): 503, not Apollo's context-failure 500.
        http: { status: 503 },
      },
    });
    // The driver error stays inspectable server-side only. On `.cause`, exactly as
    // TeamReadBusyError parks it — never on `.originalError`, which formatError's unwrapper
    // treats as Apollo's wrapper and would unwrap back to the foreign Prisma error.
    this.cause = original;
  }
}

/**
 * THE Prisma pool-wait classifier (#4471 BLIND P3): P2024 is always the pool; P2028 splits on
 * Prisma's own message prefix ("Unable to start a transaction in the given time." is the
 * `maxWait` arm) — with the engine's strings pinned against the installed Prisma in
 * resolvers.teamReadStatementTimeout4476.test.ts. TWO consumers call this one predicate — this
 * conversion here, and the bounded team read's `busyReason` (#4467, lib/agentTasks/teamReadBudget.ts)
 * — so the arms cannot drift between the credential check and the bounded read. Anything else is
 * not classified: see the file header.
 */
export function isPrismaPoolWaitFault(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2024' || (error.code === 'P2028' && /unable to start/i.test(error.message)))
  );
}

/**
 * Type guard for the render branches and tests: the TYPED error of this module. Deliberately
 * distinct in name from `isPrismaPoolWaitFault` above (BLIND P3) — that one names the RAW Prisma
 * fault before conversion, this one the converted GraphQLError after.
 */
export function isAuthStoreBusyError(error: unknown): error is AuthStoreBusyError {
  return error instanceof AuthStoreBusyError;
}

// The plain-HTTP render of this fault (`respondAuthStoreBusy`) lives in internalFault.ts, beside
// the generic envelope it carves out of: it logs the fault under the request id — the driver
// error parked on `.cause` reaches only that log — and answers 503 retryable. See there.
