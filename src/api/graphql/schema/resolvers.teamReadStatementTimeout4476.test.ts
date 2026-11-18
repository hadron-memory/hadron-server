/**
 * #4476 — the team read's budget must bite ON the statement: transaction-local
 * `statement_timeout` + `transaction_timeout` (PG17+) inside `withRosterAppRead`,
 * so Postgres itself cancels at the budget instead of waiting for the statement
 * to return.
 *
 * #4455's transaction `timeout` does not cancel a statement already running in Postgres — the
 * expiry only lands when the statement returns. Prod's roster statements ran 20–175 s (p50 66 s,
 * the prod journal at #118308) inside a 5 s budget, holding a pool connection after every client
 * had given up. With both GUCs set from the same budget constant, Postgres cancels the running
 * statement (SQLSTATE 57014, query_canceled) and the wrapper classifies it as the same typed
 * retryable TEAM_READ_BUSY refusal, reason TRANSACTION_BUDGET.
 *
 * Red on main (3810250e1): every cancel pin below got its refusal only when the blocked
 * statement finally returned (~9–14 s in), not at the budget.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { TEAM_READ_TX_TIMEOUT_MS, TeamReadBusyError, isPrismaBusyExhaustion, busyReason } from '../../../lib/agentTasks/teamReadBudget.js';
import { Prisma } from '../../../generated/prisma/index.js';

// No mocks: these pins run the real transaction, the real SET LOCALs and the real Postgres cancel.

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let mia: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'StmtBudget', urn: `stmtbudget-${n}.example` } });
  mia = await db.user.create({ data: { githubId: 650_000 + n, githubUsername: `sb-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: mia.id, role: 'ADMIN' } });
  await M.createAgent({}, { orgId: org.id, name: 'SB Agent' }, ctx(mia.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'SB', urn: `stmtbudget-${n}.example:sb` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
});

/** Every threshold derives from the one constant the wrapper uses — drift in either place fails a pin. */
const BUDGET_MS = TEAM_READ_TX_TIMEOUT_MS; // 5 s
/** A statement the budget must cancel runs this long: "refused at the budget" vs "refused when the
 *  statement finally returned" are (SLEEP - BUDGET) apart — wide enough to assert without being
 *  flaky about pool scheduling. */
const SLEEP_S = Math.ceil(BUDGET_MS * 1.8 / 1000); // 9 s
/** Green needs Postgres' cancel (~BUDGET_MS) + slack; main refuses at SLEEP_S+. */
const REFUSED_BY = BUDGET_MS * 1.5; // 7.5 s
/** The lock holder needs its own budget ABOVE the read's: under Prisma's default 5 s interactive
 *  timeout the holder expires mid-sleep, its rollback releases the lock at ~5 s, and the blocked
 *  read then completes inside its own budget (the racy pass main's red run exposed). */
const HOLDER_TX_TIMEOUT_MS = BUDGET_MS * 3;

/** The two budget-arm cause shapes the wrapper can surface: the tx-expiry P2028 (Prisma's own
 *  rollback of an expired transaction supersedes the cancelled statement's error — with both GUCs
 *  and the interactive timeout on the same constant, this usually wins), or the cancel itself
 *  (P2010/57014 for a raw statement, an UnknownRequestError rendering 57014 for a model one).
 *  Which one Prisma lets escape is internal to it; the refusal's `reason` is the contract. */
const expectBudgetArmCause = (err: TeamReadBusyError) => {
  const cause = err.cause as unknown;
  if (cause instanceof Prisma.PrismaClientKnownRequestError) {
    expect(
      cause.code === 'P2028' || (cause.code === 'P2010' && ['57014', '25P04'].includes(String((cause.meta as { code?: unknown } | undefined)?.code))),
      `cause was P2028-shape? no: ${cause.code}/${JSON.stringify(cause.meta)}`,
    ).toBe(true);
    return;
  }
  expect(cause).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
  expect((cause as Prisma.PrismaClientUnknownRequestError).message).toMatch(/PostgresError \{ code: "(57014|25P04)"/);
};

describe('#4476 red — the budget bites on the statement, per statement kind (binding condition 1)', () => {
  it('raw statement kind: a long pg_sleep inside the read is cancelled AT the budget, typed TEAM_READ_BUSY/TRANSACTION_BUDGET', async () => {
    const t0 = Date.now();
    const refusal: { resolved?: string; thrown?: unknown } = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      // $executeRaw, not $queryRaw: pg_sleep returns void, which $queryRaw refuses to deserialize (P2010).
      await readCtx.db.$executeRaw`SELECT pg_sleep(${SLEEP_S})`;
      return 'the sleep completed — nothing cancelled it';
    }).then(
      (v) => ({ resolved: v as string }),
      (e) => ({ thrown: e }),
    );
    const elapsed = Date.now() - t0;
    // On main the refusal only arrives when pg_sleep RETURNS (Prisma's tx expiry lands then): ~9 s.
    expect(elapsed, `refusal after ${elapsed} ms — the statement itself must be cancelled at the ${BUDGET_MS} ms budget`).toBeLessThan(REFUSED_BY);
    expect(refusal.resolved).toBeUndefined();
    const err = refusal.thrown as TeamReadBusyError;
    expect(err).toBeInstanceOf(TeamReadBusyError);
    expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
    expectBudgetArmCause(err);
    // The typed refusal carries no driver text on the wire (condition 2) — not the SQLSTATE, not
    // the cancel message.
    expect(JSON.stringify(err.extensions)).not.toContain('57014');
    expect(JSON.stringify(err.extensions)).not.toContain('25P04');
    expect(err.message).not.toContain('canceling statement');
    expect(err.message).not.toContain('transaction timeout');
    // The connection is released: a follow-up query on the pool answers immediately.
    const t1 = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t1).toBeLessThan(1_000);
  }, 25_000);

  it('Prisma findMany kind: a statement blocked on another session\'s table lock is cancelled AT the budget, same typed refusal', async () => {
    // Hold ACCESS EXCLUSIVE on a table the wrapper's own preamble does not touch (the User model's
    // mapped "users" table), so the FIRST blocked statement is the projection's own findMany —
    // a Prisma-issued statement, not a raw one (binding condition 1 asks for both kinds).
    let holderDone = false;
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
        await new Promise((r) => setTimeout(r, SLEEP_S * 1000));
      },
      { timeout: HOLDER_TX_TIMEOUT_MS },
    ).finally(() => { holderDone = true; });
    try {
      // Let the lock land before the read starts, or the read's own snapshot may win the race.
      await new Promise((r) => setTimeout(r, 300));
      const t0 = Date.now();
      const refusal: { resolved?: string; thrown?: unknown } = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
        await readCtx.db.user.findMany({ take: 1, select: { id: true } });
        return 'the findMany completed — nothing cancelled it';
      }).then(
        (v) => ({ resolved: v as string }),
        (e) => ({ thrown: e }),
      );
      const elapsed = Date.now() - t0;
      expect(elapsed, `refusal after ${elapsed} ms — the blocked findMany must be cancelled at the ${BUDGET_MS} ms budget`).toBeLessThan(REFUSED_BY);
      expect(refusal.resolved).toBeUndefined();
      const err = refusal.thrown as TeamReadBusyError;
      expect(err).toBeInstanceOf(TeamReadBusyError);
      expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
      expect(JSON.stringify(err.extensions)).not.toContain('57014');
      expect(JSON.stringify(err.extensions)).not.toContain('25P04');
      expectBudgetArmCause(err); // P2-2: the surfaced cause IS one of the classified cancel shapes
    } finally {
      await holder.catch(() => {}); // release the lock for the next test even if a pin failed first
      expect(holderDone).toBe(true);
    }
  }, 25_000);

  it('BLIND P2-1: a FAST statement near the expiry followed by a blocked one still refuses AT the budget (transaction_timeout closes the 2x window)', async () => {
    // statement_timeout alone bounds each statement SEPARATELY: a statement starting at ~the
    // expiry could run a full budget of its own (worst case ~2x). transaction_timeout cancels the
    // whole read at BUDGET_MS from the transaction's start — this pin refuses that mutant: with
    // statement_timeout only, the refusal lands at ~4.9 s + 5 s, past REFUSED_BY.
    const fastJustUnder = Math.floor(BUDGET_MS * 0.98 / 1000); // 4 s: completes inside its own budget
    const t0 = Date.now();
    const refusal: { resolved?: string; thrown?: unknown } = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      await readCtx.db.$executeRaw`SELECT pg_sleep(${fastJustUnder})`; // finishes at ~0.98xBUDGET
      await readCtx.db.$executeRaw`SELECT pg_sleep(${SLEEP_S})`; // would run to ~0.98xBUDGET + 9 s
      return 'both sleeps completed — nothing cancelled them';
    }).then(
      (v) => ({ resolved: v as string }),
      (e) => ({ thrown: e }),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed, `refusal after ${elapsed} ms — the read as a whole must be cancelled at ${BUDGET_MS} ms, not at ~2x`).toBeLessThan(REFUSED_BY);
    expect(refusal.resolved).toBeUndefined();
    const err = refusal.thrown as TeamReadBusyError;
    expect(err).toBeInstanceOf(TeamReadBusyError);
    expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
    expectBudgetArmCause(err);
  }, 25_000);
});

describe('#4476 — SET LOCAL scoping (acceptance 2)', () => {
  it('neither GUC reaches the pooled connections: after a cancelled read the pool still answers the defaults', async () => {
    const before = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
    const beforeTx = (await db.$queryRawUnsafe('SHOW transaction_timeout')) as { transaction_timeout: string }[];
    // A read that hits the cancel — both GUCs must leave the pool's defaults alone afterwards.
    await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      await readCtx.db.$executeRaw`SELECT pg_sleep(${SLEEP_S})`;
    }).catch(() => { /* the refusal itself is pinned above */ });
    const after = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
    const afterTx = (await db.$queryRawUnsafe('SHOW transaction_timeout')) as { transaction_timeout: string }[];
    expect(after[0]!.statement_timeout).toBe(before[0]!.statement_timeout);
    expect(afterTx[0]!.transaction_timeout).toBe(beforeTx[0]!.transaction_timeout);
    // The pool serves many connections; sample it so a session-level leak on ANY connection is
    // likely to surface (set_config with is_local is transaction-scoped by construction — this
    // pin catches an implementation that accidentally used the session-scoped form).
    for (let i = 0; i < 4; i++) {
      const s = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
      const t = (await db.$queryRawUnsafe('SHOW transaction_timeout')) as { transaction_timeout: string }[];
      expect(s[0]!.statement_timeout).toBe(before[0]!.statement_timeout);
      expect(t[0]!.transaction_timeout).toBe(beforeTx[0]!.transaction_timeout);
    }
  }, 25_000);
});

describe('#4476 — nothing changes when no statement is slow (acceptance 3)', () => {
  it('a fast projection inside the wrapper still resolves its value', async () => {
    const got = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      const users = await readCtx.db.user.findMany({ take: 1, select: { id: true } });
      return users.length >= 1 ? 'projected' : 'empty';
    });
    expect(got).toBe('projected');
  });
});

describe('#4476 unit — the 57014 classifier (binding condition 1: structured codes, not prose; other codes stay untyped)', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed.', { code, clientVersion: 'test', ...(meta ? { meta } : {}) });
  const unknown = (message: string) =>
    new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });
  // The engine's rendering of a cancelled MODEL statement, captured from the real query engine
  // (probed live at the fix head; the integration pin below re-proves it against the engine).
  const cancelledModelRender = (code: string) =>
    `Invalid \`prisma.user.findMany()\` invocation:\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "canceling statement due to statement timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`;

  it('a P2010 carrying either cancel SQLSTATE converts, with reason TRANSACTION_BUDGET', () => {
    // 57014: statement_timeout's query_canceled. 25P04: transaction_timeout's FATAL termination.
    for (const sqlState of ['57014', '25P04']) {
      const cancelled = known('P2010', { code: sqlState });
      expect(isPrismaBusyExhaustion(cancelled), sqlState).toBe(true);
      expect(busyReason(cancelled), sqlState).toBe('TRANSACTION_BUDGET');
    }
  });

  it('P2-2: a cancelled MODEL statement (UnknownRequestError rendering a cancel code) converts, with reason TRANSACTION_BUDGET', () => {
    for (const sqlState of ['57014', '25P04']) {
      const cancelled = unknown(cancelledModelRender(sqlState));
      expect(isPrismaBusyExhaustion(cancelled), sqlState).toBe(true);
      expect(busyReason(cancelled), sqlState).toBe('TRANSACTION_BUDGET');
    }
  });

  it('a P2010 carrying a DIFFERENT SQLSTATE stays untyped (the classifier must not read prose)', () => {
    const otherSqlState = known('P2010', { code: '42601' });
    expect(isPrismaBusyExhaustion(otherSqlState)).toBe(false);
    const noMeta = known('P2010');
    expect(isPrismaBusyExhaustion(noMeta)).toBe(false);
    // Driver TEXT alone never converts: a P2010 whose message says 57014 but whose meta says otherwise.
    const proseOnly = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: 57014. Message: canceling statement due to statement timeout',
      { code: 'P2010', clientVersion: 'test', meta: { code: '42601' } },
    );
    expect(isPrismaBusyExhaustion(proseOnly)).toBe(false);
  });

  it('P2-2: an UnknownRequestError rendering any OTHER code stays untyped — prose never converts', () => {
    expect(isPrismaBusyExhaustion(unknown(cancelledModelRender('42601')))).toBe(false);
    // A generic unknown error whose prose merely mentions 57014 in the wrong shape.
    expect(isPrismaBusyExhaustion(unknown('something failed with 57014 somewhere'))).toBe(false);
    expect(isPrismaBusyExhaustion(unknown('Totally unrelated engine fault'))).toBe(false);
  });

  it('P2-2, real engine: a live-cancelled findMany (statement_timeout under a longer tx budget) is classified by the real error object', { timeout: 20_000 }, async () => {
    // Reproduces the production shape directly: the cancel fires while the transaction is still
    // alive, so Prisma's own expired-tx P2028 cannot supersede it — the error that escapes IS the
    // cancelled model statement, and the classifier must catch it whatever Prisma's rendering.
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
        await new Promise((r) => setTimeout(r, SLEEP_S * 1000));
      },
      { timeout: HOLDER_TX_TIMEOUT_MS },
    );
    try {
      await new Promise((r) => setTimeout(r, 300));
      let caught: unknown;
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = 1500`);
          return tx.user.findMany({ take: 1, select: { id: true } });
        },
        { timeout: HOLDER_TX_TIMEOUT_MS },
      ).catch((e) => { caught = e; });
      expect(caught, 'the findMany must have failed').toBeDefined();
      expect(isPrismaBusyExhaustion(caught)).toBe(true);
      expect(busyReason(caught)).toBe('TRANSACTION_BUDGET');
    } finally {
      await holder.catch(() => {});
    }
  });
});
