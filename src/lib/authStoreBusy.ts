/**
 * #4471 — a busy store during the API-key credential check, typed and retryable (cor:aut:010:05 S5).
 * #4504 — the unreachable arm (P1001) joins it, as a sibling reason under the same code.
 *
 * The App-key and user-API-key paths resolve their credential by one hash lookup
 * (`appKey.findUnique` / `userApiKey.findUnique`). When the store is too busy to answer it —
 * the pool timed out (P2024) or a transaction could not start within `maxWait` (P2028's
 * "Unable to start" arm) — or cannot be reached at all (P1001, in both shapes the engine
 * raises it: a NEW connection that cannot establish on a fresh client, and a LIVE server's
 * warm pool losing the database mid-flight — #4504's QA round caught the second as a
 * per-query P1001 KnownRequestError; #4496's QA saw 6–12 of 150 paused-DB requests per case
 * land here as a generic 500) — the lookup rejects, and before #4471/#4504 that rejection
 * propagated raw:
 * through the Apollo context builder it reached clients as an untyped INTERNAL_SERVER_ERROR,
 * and through the plain HTTP routes as the generic #1789 envelope.
 *
 * The typed conversion reuses the MEANING of `unavailable` (cor:aut:010:05, #3532): a credential
 * was presented and the check could not complete — that is never a verdict. A store blip must not
 * read as "bad key", and the same request is safe to send again, so the request-level error is
 * typed RETRYABLE rather than let the request proceed as anonymous and pick up an
 * UNAUTHENTICATED refusal that misnames the fault (S5: a check that cannot complete is the
 * internal error, never refused).
 *
 * "Nothing was written", precisely (#4504, Bradley's P3): the hash lookup is the ONLY awaited
 * store operation inside either resolver, and the `lastUsedAt` stamp is fire-and-forget — it is
 * never awaited and its rejection is swallowed (`.catch(() => {})`), so it can neither produce
 * this fault nor follow it. The claim on the wire therefore holds for every reachable path: the
 * conversion can only originate from the lookup itself, where no write has been attempted. The
 * boundary to watch: if a later AWAITED read is ever added after the stamp, a busy fault there
 * would convert with the stamp already fired — revisit this prose then (pinned in
 * middleware/auth.test.ts: the stamp's own rejection is swallowed, never surfacing as this fault).
 *
 * Scope, deliberately narrow — the mapping point is `resolveAuthContextInner`'s two API-key
 * resolvers only (`src/middleware/auth.ts`):
 *   - the JWT path keeps its own ruled catch (#3532, rulings 0192–0194): a fault there marks the
 *     context `unavailable` and the request proceeds; changing that is a behavior change beyond
 *     this issue;
 *   - a statement cancel during the lookup (P2010/57014/25P04, #4476's shapes) is a bounded-read
 *     concept and stays untyped here: no credential lookup runs under a caller-chosen budget;
 *   - every other fault (a P2028 that is not the "Unable to start" arm, a known-request or
 *     initialization error that is not P1001 included) is a real fault and keeps today's
 *     generic handling.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';

/**
 * Fixed prose, so no driver text can ride the message onto the wire. One sentence skeleton, two
 * cause clauses: the caller keys on the CODE, the prose names the shape for the human reading it.
 */
export const AUTH_STORE_BUSY_MESSAGE =
  'The credential check could not complete: the store was too busy to answer it. No verdict was reached; nothing was written. The same request is safe to retry.';

/** #4504: the sibling arm — same skeleton, the store was not busy but absent. */
export const AUTH_STORE_UNREACHABLE_MESSAGE =
  'The credential check could not complete: the store could not be reached. No verdict was reached; nothing was written. The same request is safe to retry.';

/** Which shape of "the credential check could not complete" fired — the reason, not the code. */
export type AuthStoreBusyReason = 'POOL_WAIT' | 'STORE_UNREACHABLE';

/**
 * THE public reason (#4519, #4591): both boundaries, GraphQL and plain HTTP, read the thrown
 * error's `reason` through this and nothing else. Total: `instanceof` proves the class, not that
 * a subclass or a late mutation kept the value, so anything that is not exactly
 * STORE_UNREACHABLE (absent and non-string values included) is POOL_WAIT. Either answer is the
 * same retryable 503; no value passes through.
 */
export function normalizeAuthStoreBusyReason(reason: unknown): AuthStoreBusyReason {
  return reason === 'STORE_UNREACHABLE' ? 'STORE_UNREACHABLE' : 'POOL_WAIT';
}

/**
 * The fixed prose for a reason — the ONE lookup every end renders from (#4519, BLIND P3-4): the
 * constructor's message, the plain-HTTP boundary's body and the GraphQL error. Total on purpose: anything that is
 * not STORE_UNREACHABLE answers the busy prose, so no message content — the driver's text, a
 * tampered `.message`, a subclass's own prose — can reach the wire; "no driver text rides the
 * message" is enforced by the render point, not by constructor convention alone.
 */
export function authStoreBusyMessage(reason: unknown): string {
  return normalizeAuthStoreBusyReason(reason) === 'STORE_UNREACHABLE' ? AUTH_STORE_UNREACHABLE_MESSAGE : AUTH_STORE_BUSY_MESSAGE;
}

/**
 * The credential check could not complete because the store would not answer — busy past its
 * pool wait, or unreachable outright. ONE code and ONE class for both shapes (the carve-out in
 * internalFault.ts, the formatError mapping and the Sentry column all key on the class), the
 * `reason` extension and the fixed prose carry the shape. #4504's gate blessed exactly this:
 * "the same typed retryable 503 (AUTH_STORE_BUSY, or a sibling reason such as
 * STORE_UNREACHABLE)".
 */
export class AuthStoreBusyError extends GraphQLError {
  // #4519 (BLIND P3-3): `reason` is REQUIRED — there is no meaningful default for "which shape
  // fired" (the single production construction site derives it via authStoreBusyReason), and a
  // silent POOL_WAIT default would mistype an unreachable store as merely busy.
  constructor(original: unknown, reason: AuthStoreBusyReason) {
    super(authStoreBusyMessage(reason), {
      extensions: {
        code: 'AUTH_STORE_BUSY',
        // SAFE to retry (the check held nothing), not "a retry will succeed" — the same
        // convention TEAM_READ_BUSY states (#4460/#4455).
        retryable: true,
        // The classified shapes, one reason each: a pool-acquisition wait, or a store that no
        // new connection could reach. There is no auth-side bound to name: teamReadBudget's
        // maxWaitMs/budgetMs name ITS bounds (#4467); the credential check runs on the pool's
        // own defaults.
        reason,
        // The status must ride the error itself: Apollo 4 resolves the HTTP status of a context
        // failure from the thrown error's `extensions.http` BEFORE formatError runs, so the
        // boundary cannot set it after the fact — at throw time or not at all (#4504 restated
        // Bradley's correction of the old "#1303's mechanism" wording).
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
 * #4504: THE unreachable-store classifier — P1001, "Can't reach database server at `…`" (the
 * host:port is DRIVER TEXT and must never ride the conversion; the fixed prose above is why it
 * cannot). P1001 arrives in TWO shapes on the installed engine (6.19.2), and BOTH are real —
 * the QA round caught the first-released classifier accepting only the second:
 *
 *   - the WARM-POOL shape (Celine's QA FAIL at 522fe537, fixed here): a LIVE server whose
 *     database goes away (`compose stop db` under a warm pool) answers the NEXT QUERY with a
 *     `PrismaClientKnownRequestError` carrying `code: 'P1001'`, `meta.database_location`, and
 *     the same fixed phrase mid-message behind the client's invocation preamble. This is the
 *     production scenario #4504 exists for — the paused-DB QA of #4496. On this shape the code
 *     IS set (that is what makes it a KnownRequestError), so the discriminator is the code
 *     alone, exactly as `isPrismaPoolWaitFault` reads P2024/P2028 off the same class.
 *   - the NEVER-CONNECTED shape: a FRESH client against a dead endpoint (boot with the DB
 *     down, my real-DB test's 127.0.0.1:1) raises `PrismaClientInitializationError`, whose
 *     per-query `errorCode` is undefined on 6.19.2 — the code exists only in the message, so
 *     the discriminator there is the engine's fixed phrase, matched UNANCHORED (the phrase
 *     sits mid-message behind the preamble). The `errorCode` arm is kept for the day the
 *     engine starts attaching it.
 *
 * Pinned both ways: the never-connected shape end-to-end by the REAL unreachable-DB test
 * (api/graphql/authStoreUnreachable4504.test.ts, reddens if a Prisma upgrade rewords the
 * engine phrase), the warm-pool shape by capture-built legs in middleware/auth.test.ts — the
 * error object is reproduced field-for-field from Celine's stopped-DB log (message including
 * the source frame, code, meta, clientVersion), not invented. P1001 ONLY on either class: the
 * neighboring codes say something else (P1002 the server rejected the authentication, P1008 a
 * connection lost mid-session) and stay untyped faults; and P1001 ∉ {P2024, P2028}, so the
 * two busy classifiers stay disjoint by code.
 */
export function isPrismaStoreUnreachableFault(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientInitializationError {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === 'P1001';
  return (
    error instanceof Prisma.PrismaClientInitializationError &&
    (error.errorCode === 'P1001' || /Can't reach database server/i.test(error.message))
  );
}

/**
 * #4504: the auth path's ONE decision point — which busy/unreachable arm a fault is, or null
 * when it is neither and must keep today's raw propagation. ResolveKeyCredentialLookup's catch
 * is a thin wrapper around this, so the mapped set lives here beside the classifiers it names,
 * not in the middleware. `isPrismaPoolWaitFault` itself stays untouched: teamReadBudget's
 * `busyReason` shares it (#4467), and the bounded read's answer to an unreachable store is its
 * own ruled behavior — not this issue's to change.
 */
export function authStoreBusyReason(error: unknown): AuthStoreBusyReason | null {
  if (isPrismaPoolWaitFault(error)) return 'POOL_WAIT';
  if (isPrismaStoreUnreachableFault(error)) return 'STORE_UNREACHABLE';
  return null;
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
