/**
 * #4476 — the team read's budget must bite ON the statement: transaction-local
 * `statement_timeout` + `transaction_timeout` (PG17+) inside `withRosterAppRead`,
 * so Postgres itself cancels at the budget instead of waiting for the statement
 * to return.
 *
 * #4455's transaction `timeout` does not cancel a statement already running in Postgres — the
 * expiry only lands when the statement returns. Prod's roster statements ran 20–175 s (p50 66 s,
 * the prod journal at #118308) inside a 5 s budget, holding a pool connection after every client
 * had given up. With the statement cap at the budget and the transaction backstop (PG17+) a
 * margin past it, Postgres cancels the running statement (SQLSTATE 57014, query_canceled) and the
 * wrapper classifies it as the same typed retryable TEAM_READ_BUSY refusal, reason
 * TRANSACTION_BUDGET.
 *
 * Red on main (3810250e1): every cancel pin below got its refusal only when the blocked
 * statement finally returned (~9–14 s in), not at the budget.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { TEAM_READ_TX_BACKSTOP_MARGIN_MS, TEAM_READ_TX_MAX_WAIT_MS, TEAM_READ_TX_TIMEOUT_MS, TeamReadBusyError, isPrismaBusyExhaustion, busyReason } from '../../../lib/agentTasks/teamReadBudget.js';
import { Prisma } from '../../../generated/prisma/index.js';

// No mocks: these pins run the real transaction, the real SET LOCALs and the real Postgres cancel.

// transaction_timeout is PG17+; CI's test/migration lanes run pgvector:pg16 (LOCAL review P2 on
// #4482), where the GUC does not exist. Probe the engine once: the PG17-only pins below skip where
// the GUC is absent, and the scoping pin asserts the transaction_timeout leg only where it exists.
// current_setting(name, true) is NULL on engines without the parameter instead of erroring — the
// same feature-detect the wrapper's CASE uses.
const [gucProbe] = (await db.$queryRawUnsafe(
  "SELECT current_setting('transaction_timeout', true) IS NOT NULL AS present",
)) as { present: boolean }[];
const HAS_TX_TIMEOUT = gucProbe.present;
// #4482 BLIND F (minimum): the PG17-only pins below skip where the GUC is absent, so on a PG16
// runner their coverage silently vanishes. A lane that EXPECTS PG17 sets TEST_EXPECT_TX_TIMEOUT=1
// (test.yml's PG17 shard lanes since #4487), and then the skip is a
// FAILURE, not a pass — the coverage cannot be lost where it was promised.
if (!HAS_TX_TIMEOUT && process.env.TEST_EXPECT_TX_TIMEOUT === '1') {
  throw new Error('TEST_EXPECT_TX_TIMEOUT=1 but this engine has no transaction_timeout GUC — the PG17 pins would silently skip here');
}

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

  it.skipIf(!HAS_TX_TIMEOUT)('BLIND P2-1: a FAST statement near the expiry followed by a blocked one still refuses within the whole-read bound (transaction_timeout closes the 2x window; PG17-only — skips on engines without the GUC)', async () => {
    // statement_timeout alone bounds each statement SEPARATELY: a statement starting at ~the
    // expiry could run a full budget of its own (worst case ~2x). transaction_timeout cancels the
    // whole read at BUDGET_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS from the transaction's start —
    // this pin refuses that mutant: with statement_timeout only, the refusal lands at
    // ~4.9 s + 5 s. The threshold derives from BUDGET + MARGIN (not the budget alone), so a
    // margin change reddens it for the RIGHT reason rather than incidentally.
    const wholeReadBound = BUDGET_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS;
    const fastJustUnder = Math.floor(BUDGET_MS * 0.98 / 1000); // 4 s: completes inside its own budget
    // #4482 BLIND N: the slack is FIXED, not proportional. Under the old ×1.25 a call-site margin
    // widened to ≥ ~2.2 s still refused inside the bound (5 s + 2.2 s < 7.5 s) — the mutant
    // sailed through, because the bound scaled up with the outcome it was supposed to refuse.
    // Fixed slack keeps the bound put, so a widened margin's later refusal crosses it.
    const SCHEDULING_SLACK_MS = 1_000;
    const refusedWithin = wholeReadBound + SCHEDULING_SLACK_MS;
    // The pin must keep telling its two outcomes apart whichever way the constants drift: the
    // backstop refusal (~wholeReadBound) keeps at least the scheduling slack beneath the bound,
    // and the statement-cap-only refusal (the second statement starting at fastJustUnder and
    // getting a full budget of its own) stays at least as far beyond it. Squeeze either side and
    // this pin stops distinguishing exactly the two things it exists to distinguish.
    const capOnlyRefusalMs = fastJustUnder * 1_000 + BUDGET_MS;
    expect(refusedWithin - wholeReadBound, 'scheduling headroom above the backstop refusal').toBeGreaterThanOrEqual(SCHEDULING_SLACK_MS);
    expect(capOnlyRefusalMs - refusedWithin, 'the statement-cap-only refusal must stay beyond the bound').toBeGreaterThanOrEqual(SCHEDULING_SLACK_MS);
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
    expect(elapsed, `refusal after ${elapsed} ms — the read as a whole must be cancelled within ${wholeReadBound} ms, not at ~2x`).toBeLessThan(refusedWithin);
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
    const beforeTx = HAS_TX_TIMEOUT
      ? ((await db.$queryRawUnsafe('SHOW transaction_timeout')) as { transaction_timeout: string }[])[0]!.transaction_timeout
      : null; // SHOW itself errors on engines without the GUC (pg16 CI lanes)
    // A read that hits the cancel — both GUCs must leave the pool's defaults alone afterwards.
    await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      await readCtx.db.$executeRaw`SELECT pg_sleep(${SLEEP_S})`;
    }).catch(() => { /* the refusal itself is pinned above */ });
    const after = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
    expect(after[0]!.statement_timeout).toBe(before[0]!.statement_timeout);
    // The pool serves many connections; sample it so a session-level leak on ANY connection is
    // likely to surface (set_config with is_local is transaction-scoped by construction — this
    // pin catches an implementation that accidentally used the session-scoped form).
    for (let i = 0; i < 4; i++) {
      const s = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
      expect(s[0]!.statement_timeout).toBe(before[0]!.statement_timeout);
      if (HAS_TX_TIMEOUT) {
        const t = (await db.$queryRawUnsafe('SHOW transaction_timeout')) as { transaction_timeout: string }[];
        expect(t[0]!.transaction_timeout).toBe(beforeTx);
      }
    }
  }, 25_000);
});

describe('#4482 — both paths asserted, not merely survived (LOCAL delta review P2 at f44245d38)', () => {
  it('inside the wrapper\'s transaction, statement_timeout is exactly the budget and transaction_timeout exactly budget+margin', async () => {
    // The delta review found these mutants green at f44245d38: statement_timeout='0' (the backstop
    // alone passed every pin — but the statement cap is the sole bound on PG16 and the non-fatal
    // arm the margin exists to protect) and backstop margin=0 (its purpose unpinned). pg_settings
    // .setting is the internal millisecond value, so the assertion is independent of the engine's
    // display format ('5s' vs '5000ms'). Runs on every engine: the statement leg is unconditional,
    // the backstop leg only where the GUC exists (skipIf is unnecessary — the row is simply absent
    // on no-GUC engines, which is itself pinned by the else arm).
    const got = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      const rows = await readCtx.db.$queryRawUnsafe(
        "SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout', 'transaction_timeout')",
      ) as { name: string; setting: string }[];
      return Object.fromEntries(rows.map((r) => [r.name, r.setting]));
    });
    expect(
      got['statement_timeout'],
      'the statement cap must be exactly the budget — a mutant that disables it (0) or drifts the constant reddens here',
    ).toBe(String(TEAM_READ_TX_TIMEOUT_MS));
    if (HAS_TX_TIMEOUT) {
      expect(
        got['transaction_timeout'],
        'the backstop must sit at budget+margin — the margin is what lets the non-fatal statement cancel win the race it can win',
      ).toBe(String(TEAM_READ_TX_TIMEOUT_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS));
    } else {
      // The guard held: nothing was set on an engine without the GUC (set_config would 42704).
      expect(got['transaction_timeout']).toBeUndefined();
    }
  });

  it('the guard\'s feature-detect shape yields NULL, never 42704, for a GUC absent on EVERY engine (the no-GUC path, runnable without PG16)', async () => {
    // The wrapper guards transaction_timeout behind current_setting(..., true) IS NOT NULL because
    // set_config on a missing parameter errors (42704) on engines without it — pg16 CI lanes. This
    // pin proves the TECHNIQUE on any engine, PG17 included, by asking it about a GUC no engine
    // has: missing_ok returns NULL instead of raising. The production call site itself is executed
    // by every wrapper test above, so a guard regression (dropping missing_ok, or CASE WHEN true
    // unconditionally setting) goes red on CI's pgvector:pg16 lanes — the live no-GUC executor.
    const rows = await db.$queryRawUnsafe(
      "SELECT current_setting('jimmy_no_such_guc_4476', true) AS absent, CASE WHEN current_setting('jimmy_no_such_guc_4476', true) IS NOT NULL THEN 'guarded' ELSE 'unguarded' END AS arms",
    ) as { absent: string | null; arms: string }[];
    expect(rows[0]!.absent, 'missing_ok must yield NULL for an absent parameter, never raise 42704').toBeNull();
    expect(rows[0]!.arms).toBe('unguarded');
  });
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
  // The engine's rendering of a cancelled MODEL statement. The 25P04 arm is CAPTURED VERBATIM
  // from the real query engine at the fix head (the typed-backstop integration pin below
  // reproduces the kill and re-proves the live object; a Prisma upgrade that changes this
  // rendering reddens that pin, not just this fixture — BLIND delta review E). The 57014 arm
  // keeps the statement-cancel text the live findMany pin below classifies for real.
  const cancelledModelRender = (code: string) => {
    const fatal = code === '25P04';
    const message = fatal ? 'terminating connection due to transaction timeout' : 'canceling statement due to statement timeout';
    return `Invalid \`prisma.user.findMany()\` invocation:\n${fatal ? '\n\n' : '\n'}Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${message}", severity: "${fatal ? 'FATAL' : 'ERROR'}", detail: None, column: None, hint: None }), transient: false })`;
  };

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

  it.skipIf(!HAS_TX_TIMEOUT)('BLIND P2 A, real engine: the backstop firing mid-statement raises the REAL P2010/25P04 shape and the classifier converts it (PG17-only; P2028 must not be the pass)', { timeout: 30_000 }, async () => {
    // Reproduces the backstop as the wrapper can produce it: a statement still running when the
    // transaction_timeout expiry lands (the statement cap sits ABOVE the backstop here, so only the
    // backstop can cancel — exactly the ordering inside the wrapper for a statement that starts
    // near the budget). Prisma's interactive timeout is deliberately far longer, so its P2028
    // rollback CANNOT supersede the FATAL: what escapes is the engine's own rendering, asserted
    // below as the real P2010+meta.code 25P04 — probed live, never a hand-built message, and never
    // P2028 (a classifier mutant that only maps P2028 reddens this pin).
    const BACKSTOP_MS = TEAM_READ_TX_TIMEOUT_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS;
    let caught: unknown;
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(TEAM_READ_TX_TIMEOUT_MS * 2)}, true) AS statement_timeout,
                           CASE WHEN current_setting('transaction_timeout', true) IS NOT NULL
                                THEN set_config('transaction_timeout', ${String(BACKSTOP_MS)}, true) END AS transaction_timeout`;
        // Still running when the backstop expires (statement cap would only bite at 2x budget).
        await tx.$executeRawUnsafe(`SELECT pg_sleep(${Math.ceil((TEAM_READ_TX_TIMEOUT_MS * 2) / 1000 * 0.9)})`);
        return 'the sleep completed — the backstop never fired';
      },
      { timeout: BACKSTOP_MS * 4, maxWait: TEAM_READ_TX_MAX_WAIT_MS },
    ).then(
      (v) => { throw new Error(`resolved instead: ${String(v)}`); },
      (e) => { caught = e; },
    );
    const diag = `real error: name=${(caught as object)?.constructor?.name} ${String((caught as Error)?.message).slice(0, 300)}`;
    expect(caught, 'the statement must have been terminated by the backstop').toBeDefined();
    expect(isPrismaBusyExhaustion(caught), `classifier must convert the real backstop shape — ${diag}`).toBe(true);
    expect(busyReason(caught), diag).toBe('TRANSACTION_BUDGET');
    // And the cause is the real cancel shape, not Prisma's own P2028 rollback.
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const cause = caught as Prisma.PrismaClientKnownRequestError;
    expect(cause.code, `P2028 is not the backstop firing — ${diag}`).toBe('P2010');
    expect(String((cause.meta as { code?: unknown }).code), `the real engine carries the 25P04 SQLSTATE on meta — ${diag}`).toBe('25P04');
  });

  it.skipIf(!HAS_TX_TIMEOUT)('BLIND P2 A boundary, real engine: the backstop firing while NO statement is in flight renders "Server has closed the connection." with no structured code — and stays untyped ON PURPOSE', { timeout: 30_000 }, async () => {
    // Probed live (PG17): a transaction that IDLES past transaction_timeout is FATAL-killed with no
    // statement in flight, and the next operation surfaces Prisma's generic connection-closed
    // rendering — no SQLSTATE anywhere (cause undefined). Mapping that prose to the typed refusal
    // is forbidden by this file's own doctrine (structured codes, not prose): the text is
    // indistinguishable from an unrelated connection death, so this pin freezes the boundary —
    // the shape must NOT convert. Inside the wrapper this path is unreachable in practice: idle
    // time is bounded by Prisma's own interactive timeout at the same budget (P2028, #4455-pinned)
    // before the backstop's margin expires; the backstop's classified coverage is the
    // mid-statement kill pinned above. That unreachability rests on Prisma's rollback landing
    // within the margin of its own timer — under event-loop or engine stalls (the incident's
    // conditions) it can be lost, and the failure mode is an UNTYPED error, never a wrong
    // refusal (#4482 BLIND K); the margin's width is the dial, not this boundary.
    const BACKSTOP_MS = TEAM_READ_TX_TIMEOUT_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS;
    let caught: unknown;
    await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(TEAM_READ_TX_TIMEOUT_MS)}, true) AS statement_timeout,
                           CASE WHEN current_setting('transaction_timeout', true) IS NOT NULL
                                THEN set_config('transaction_timeout', ${String(BACKSTOP_MS)}, true) END AS transaction_timeout`;
        // Idle past the backstop with no statement in flight.
        await new Promise((r) => setTimeout(r, BACKSTOP_MS + 1_500));
        await tx.$queryRaw`SELECT 1`; // meets the FATAL-terminated session
        return 'the idle survived — the backstop never fired';
      },
      { timeout: BACKSTOP_MS * 4, maxWait: TEAM_READ_TX_MAX_WAIT_MS },
    ).then(
      (v) => { throw new Error(`resolved instead: ${String(v)}`); },
      (e) => { caught = e; },
    );
    expect(caught, 'the idle must have been terminated by the backstop').toBeDefined();
    // The boundary: no structured code reaches the classifier, so it MUST NOT convert.
    expect(
      isPrismaBusyExhaustion(caught),
      `prose-only connection-closed must never convert — got ${String((caught as Error)?.message).slice(0, 200)}`,
    ).toBe(false);
  });

  it.skipIf(!HAS_TX_TIMEOUT)('BLIND P2 A (narrowed), real engine: a TYPED statement blocked past the backstop is FATAL-killed and the classifier converts the real model-arm shape (live-captured rendering; P2028 must not be the pass)', { timeout: 30_000 }, async () => {
    // Roster reads are mostly typed queries, which the raw-statement 25P04 pin above does not
    // cover. Same construction with a typed victim: the statement cap pushed ABOVE the backstop
    // and Prisma's interactive timer far past it, so the only thing that can end this read is
    // the backstop — firing while a findMany WAITS on another session's table lock.
    const BACKSTOP_MS = TEAM_READ_TX_TIMEOUT_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS;
    let holderDone = false;
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
        await new Promise((r) => setTimeout(r, BACKSTOP_MS + 3_000));
      },
      { timeout: BACKSTOP_MS * 3 },
    ).finally(() => { holderDone = true; });
    let caught: unknown;
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the lock land first
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(TEAM_READ_TX_TIMEOUT_MS * 2)}, true) AS statement_timeout,
                             CASE WHEN current_setting('transaction_timeout', true) IS NOT NULL
                                  THEN set_config('transaction_timeout', ${String(BACKSTOP_MS)}, true) END AS transaction_timeout`;
          // Burns past the budget (inside its own 2x cap) so the typed statement below is still
          // WAITING when the backstop expires.
          await tx.$executeRawUnsafe(`SELECT pg_sleep(${Math.floor(BUDGET_MS / 1000 * 1.1)})`);
          return tx.user.findMany({ take: 1, select: { id: true } });
        },
        { timeout: BACKSTOP_MS * 4, maxWait: TEAM_READ_TX_MAX_WAIT_MS },
      ).then(
        (v) => { throw new Error(`resolved instead: ${JSON.stringify(v?.length ?? null)}`); },
        (e) => { caught = e; },
      );
    } finally {
      await holder.catch(() => {});
      expect(holderDone).toBe(true);
    }
    const diag = `real error: name=${(caught as object)?.constructor?.name} ${String((caught as Error)?.message).slice(0, 400)}`;
    expect(caught, 'the typed statement must have been terminated by the backstop').toBeDefined();
    expect(isPrismaBusyExhaustion(caught), `classifier must convert the real typed backstop shape — ${diag}`).toBe(true);
    expect(busyReason(caught), diag).toBe('TRANSACTION_BUDGET');
    // #4482 BLIND L: name the arm that matched. Only the backstop can fire in this construction
    // (the statement cap sits at 2x, Prisma's interactive timer at 4x) and it fires mid-statement,
    // so the escaped object IS the model arm — Prisma's UnknownRequestError rendering the FATAL
    // 25P04. Freezing the arm is what keeps this pin about TYPED statements: if the construction
    // ever regressed to a raw victim (P2010 + meta) or a re-wrapping, the conversions above would
    // still pass and the arm identity would redden here.
    expect(caught, `the escaped object must be the model arm (UnknownRequestError), not a raw or re-wrapped shape — ${diag}`).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect((caught as Prisma.PrismaClientUnknownRequestError).message, `the model arm renders the FATAL 25P04 — ${diag}`).toMatch(/code: "25P04"/);
    // The pool must not hand the KILLED connection to the next caller: an ordinary query
    // answers immediately afterwards (delta review cannot-judge: dead-connection eviction).
    const t1 = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t1).toBeLessThan(1_000);
  });

  it.skipIf(!HAS_TX_TIMEOUT)('BLIND P2 A (narrowed), real engine: through the WRAPPER with Prisma\'s real 5 s timer, a fast statement then a blocked TYPED one still refuses typed TEAM_READ_BUSY (the 5 s/6 s ordering never escapes untyped)', { timeout: 30_000 }, async () => {
    // The only pin that runs the wrapper itself with every timer at its REAL value: Prisma's
    // interactive timer expires at the budget while the blocked typed statement still waits,
    // then the backstop force-ends the read at budget+margin. Whatever arm wins the race, the
    // wrapper must surface the typed refusal — never the untyped connection-closed prose the
    // boundary pin freezes out below.
    const BACKSTOP_MS = TEAM_READ_TX_TIMEOUT_MS + TEAM_READ_TX_BACKSTOP_MARGIN_MS;
    let holderDone = false;
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
        await new Promise((r) => setTimeout(r, BACKSTOP_MS * 2));
      },
      { timeout: BACKSTOP_MS * 3 },
    ).finally(() => { holderDone = true; });
    try {
      await new Promise((r) => setTimeout(r, 300)); // let the lock land first
      const t0 = Date.now();
      const refusal: { resolved?: string; thrown?: unknown } = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
        await readCtx.db.$executeRawUnsafe(`SELECT pg_sleep(${Math.ceil(BUDGET_MS / 1000 * 0.3)})`); // ~1.5 s: completes well inside every bound
        await readCtx.db.user.findMany({ take: 1, select: { id: true } }); // blocks on the lock
        return 'the blocked findMany completed';
      }).then(
        (v) => ({ resolved: v as string }),
        (e) => ({ thrown: e }),
      );
      const elapsed = Date.now() - t0;
      expect(refusal.resolved).toBeUndefined();
      const err = refusal.thrown as TeamReadBusyError;
      expect(err).toBeInstanceOf(TeamReadBusyError);
      expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
      expect(elapsed, `refusal after ${elapsed} ms — the whole read is bounded by budget+margin (${BACKSTOP_MS} ms), not by the blocked statement's return`).toBeLessThan(BACKSTOP_MS * 1.5);
    } finally {
      await holder.catch(() => {});
      expect(holderDone).toBe(true);
    }
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
