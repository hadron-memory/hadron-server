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
 *
 * #4476: the budget now bites ON the statement. The wrapper sets
 * transaction-local `statement_timeout` (the per-statement cap, at the
 * budget) AND `transaction_timeout` (PG17+, the whole-read backstop at the
 * budget plus TEAM_READ_TX_BACKSTOP_MARGIN_MS; guarded on the GUC existing,
 * so PG16 CI lanes keep the statement bound only), so Postgres itself cancels
 * a runaway statement instead of letting it run to completion inside an
 * already-expired transaction (prod's roster statements ran 20–175 s inside
 * the 5 s budget). A cancel raises SQLSTATE 57014 (statement_timeout's
 * query_canceled) or 25P04 (transaction_timeout's FATAL termination) in two
 * Prisma shapes — P2010 with the SQLSTATE on `meta.code` for a raw statement,
 * or an UnknownRequestError whose only discriminator is the engine's rendered
 * `PostgresError { code: … }` for a model statement — and all of them convert
 * through the classifier below.
 */
import { GraphQLError } from 'graphql';
import { Prisma } from '../../generated/prisma/index.js';
import { isPrismaPoolWaitFault } from '../authStoreBusy.js';

/** The interactive team-read transaction's total budget (ms). #4455: 5 s; every client's own timeout is longer. */
export const TEAM_READ_TX_TIMEOUT_MS = 5_000;
/**
 * How far past the budget the PG17+ `transaction_timeout` backstop sits (ms). The real split,
 * top to bottom (#4482 BLIND delta review item H):
 *   - a runaway statement that STARTED early enough (within the margin of the read's start)
 *     is cancelled by its own statement cap first — 57014, non-fatal, the pooled connection
 *     survives;
 *   - a statement that started later would outrun the backstop under its own cap, so the
 *     backstop ends the read — 25P04, FATAL, the connection is killed. That kill is the churn
 *     the margin exists to make rare: every read whose runaway statement starts past the
 *     margin still pays it;
 *   - time idled BETWEEN statements is bounded by Prisma's own interactive timer at the same
 *     budget (P2028, #4455) before the backstop's margin expires.
 * The margin buys no safety (the statement cap alone already bounds every statement); it buys
 * kept connections for the reads whose runaway statement starts early enough that the
 * non-fatal cancel can win the race.
 */
export const TEAM_READ_TX_BACKSTOP_MARGIN_MS = 1_000;
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
  // #4471 BLIND P3: the pool-wait arms are decided by the ONE shared classifier
  // (isPrismaPoolWaitFault in lib/authStoreBusy.ts), so they cannot drift between the bounded
  // read and the credential check. Anything else converting here still names the budget arm —
  // the safest reading, since the transaction is the thing the caller asked to be bounded.
  if (isPrismaPoolWaitFault(error)) return 'POOL_WAIT';
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
export function isPrismaBusyExhaustion(error: unknown): error is Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P2028' || error.code === 'P2024' || isRawStatementCancel(error);
  }
  // A cancelled MODEL statement (findMany and friends) is the other cancel shape: Prisma 6.x
  // surfaces it as an UnknownRequestError with NO structured fields — the SQLSTATE exists only in
  // the engine's machine-rendered Debug of the Postgres error (probed live, #4482 BLIND P2-2).
  return error instanceof Prisma.PrismaClientUnknownRequestError && isModelStatementCancel(error);
}

/** #4476: the driver's own SQLSTATEs for a cancel at the read's budget: 57014 is
 *  statement_timeout's query_canceled; 25P04 is transaction_timeout's FATAL connection
 *  termination (it does not just cancel the statement — it ends the connection), as Prisma
 *  carries them. */
const CANCEL_SQLSTATES = ['57014', '25P04'];

/** #4476: a cancelled RAW statement is P2010 carrying the SQLSTATE structured on `meta.code`.
 *  Matched on that structured code only — a P2010 wrapping any other database code is a real
 *  failure and stays untyped, and driver message prose is never read. */
function isRawStatementCancel(error: Prisma.PrismaClientKnownRequestError): boolean {
  return error.code === 'P2010' && CANCEL_SQLSTATES.includes(String((error.meta as { code?: unknown } | undefined)?.code));
}

/** #4476: a cancelled MODEL statement's only discriminator in Prisma 6.x is the engine's
 *  Rust-Debug rendering of the Postgres error (`PostgresError { code: "57014", … }`) — a
 *  machine-rendered field, not natural-language prose, and there is no structured alternative
 *  (the error carries only clientVersion and name). The match is pinned to those exact rendered
 *  codes; any other rendered code stays untyped, and the rendered shape itself is re-proved
 *  against the real engine by the pin in resolvers.teamReadStatementTimeout4476.test.ts. */
const CANCELLED_MODEL_STATEMENT_RENDER = /PostgresError \{ code: "(57014|25P04)"/;

function isModelStatementCancel(error: Prisma.PrismaClientUnknownRequestError): boolean {
  return CANCELLED_MODEL_STATEMENT_RENDER.test(error.message);
}
