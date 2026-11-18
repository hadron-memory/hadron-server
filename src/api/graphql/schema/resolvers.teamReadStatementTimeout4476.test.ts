/**
 * #4476 — the team read's budget must bite ON the statement: `SET LOCAL statement_timeout` inside
 * `withRosterAppRead`, so Postgres itself cancels an in-flight statement at the budget.
 *
 * #4455's transaction `timeout` does not cancel a statement already running in Postgres — the expiry only
 * lands when the statement returns. Prod's roster statements ran 20–175 s (p50 66 s, Hugo's alpha journal,
 * #118308) inside a 5 s budget, holding a pool connection after every client had given up. With
 * `statement_timeout` set from the same budget constant, Postgres cancels at the budget (SQLSTATE 57014,
 * query_canceled) and the wrapper classifies it as the same typed retryable TEAM_READ_BUSY refusal,
 * reason TRANSACTION_BUDGET.
 *
 * Red on main (3810250e1): both per-statement-kind pins (Xanthos's binding condition 1 — a raw statement
 * and a Prisma findMany, because the surfaced Prisma code differs by kind) get their refusal only when the
 * blocked statement finally returns, ~9 s in these pins, not at the 5 s budget.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { TeamReadBusyError, isPrismaBusyExhaustion, busyReason } from '../../../lib/agentTasks/teamReadBudget.js';
import { Prisma } from '../../../generated/prisma/index.js';

// No mocks: these pins run the real transaction, the real SET LOCAL and the real Postgres cancel.

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

/** The budget is 5 s (TEAM_READ_TX_TIMEOUT_MS). A statement the budget must cancel runs 9 s here, so
 *  "the refusal arrived at the budget" and "the refusal arrived when the statement finally returned"
 *  are 4 s apart — wide enough to assert without being flaky about pool scheduling. */
const BUDGET_MS = 5_000;
const CANCELLED_BY = 7_500; // green needs Postgres' cancel (~5 s) + slack; main is ~9 s+

describe('#4476 red — the budget bites on the statement, per statement kind (binding condition 1)', () => {
  it('raw statement kind: a 9 s pg_sleep inside the read is cancelled AT the budget, typed TEAM_READ_BUSY/TRANSACTION_BUDGET', async () => {
    const t0 = Date.now();
    const refusal: { resolved?: string; thrown?: unknown } = await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      // $executeRaw, not $queryRaw: pg_sleep returns void, which $queryRaw refuses to deserialize (P2010).
      await readCtx.db.$executeRaw`SELECT pg_sleep(9)`;
      return 'the sleep completed — nothing cancelled it';
    }).then(
      (v) => ({ resolved: v as string }),
      (e) => ({ thrown: e }),
    );
    const elapsed = Date.now() - t0;
    // On main the refusal only arrives when pg_sleep(9) RETURNS (Prisma's tx expiry lands then): ~9 s.
    expect(elapsed, `refusal after ${elapsed} ms — the statement itself must be cancelled at the ${BUDGET_MS} ms budget`).toBeLessThan(CANCELLED_BY);
    expect(refusal.resolved).toBeUndefined();
    const err = refusal.thrown as TeamReadBusyError;
    expect(err).toBeInstanceOf(TeamReadBusyError);
    expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
    // The cancel is the budget arm either way it surfaces: the cancelled raw statement is a P2010
    // carrying SQLSTATE 57014 (Brooks's live shape, #118325 — the classifier's P2010/57014 arm,
    // unit-pinned below), but with statement_timeout and the interactive-tx budget on the SAME
    // constant, Prisma's own expired-transaction rollback (P2028, "Transaction already closed")
    // races it and can supersede it as the rejection. Which error wins is Prisma-internal; the
    // refusal's `reason` above is the contract, and the wire stays driver-text-free (condition 2).
    expect(err.cause).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const causeCode = (err.cause as Prisma.PrismaClientKnownRequestError).code;
    const causeSqlState = (err.cause as Prisma.PrismaClientKnownRequestError).meta;
    expect(
      causeCode === 'P2028' || (causeCode === 'P2010' && (causeSqlState as { code?: unknown } | undefined)?.code === '57014'),
      `cause was ${causeCode}/${JSON.stringify(causeSqlState)} — neither budget-arm shape`,
    ).toBe(true);
    expect(JSON.stringify(err.extensions)).not.toContain('57014');
    expect(err.message).not.toContain('canceling statement');
    // The connection is released: a follow-up query on the pool answers immediately.
    const t1 = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t1).toBeLessThan(1_000);
  }, 25_000);

  it('Prisma findMany kind: a statement blocked on another session\'s table lock is cancelled AT the budget, same typed refusal', async () => {
    // Hold ACCESS EXCLUSIVE on a table the wrapper's own preamble does not touch (the User model's
    // mapped "users" table), so the FIRST blocked statement is the projection's own findMany —
    // a Prisma-issued statement, not a raw one.
    const releaseLockAfter = 9_000;
    // The holder needs its own budget ABOVE the read's: under Prisma's default 5 s interactive
    // timeout the holder expires mid-sleep, its rollback releases the lock at ~5 s, and the
    // blocked read then completes inside its own budget — the racy pass main's red run exposed.
    const holder = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
        await new Promise((r) => setTimeout(r, releaseLockAfter));
      },
      { timeout: 15_000 },
    );
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
    expect(elapsed, `refusal after ${elapsed} ms — the blocked findMany must be cancelled at the ${BUDGET_MS} ms budget`).toBeLessThan(CANCELLED_BY);
    expect(refusal.resolved).toBeUndefined();
    const err = refusal.thrown as TeamReadBusyError;
    expect(err).toBeInstanceOf(TeamReadBusyError);
    expect(err.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET' });
    expect(JSON.stringify(err.extensions)).not.toContain('57014');
    await holder; // release the lock before the next test
  }, 25_000);
});

describe('#4476 — SET LOCAL scoping (acceptance 2)', () => {
  it('the statement_timeout never reaches the pooled connection: after the read, the pool still answers the default', async () => {
    const before = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
    // A read that hits the cancel, then a read that completes — both must leave the pool's default alone.
    await withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
      await readCtx.db.$executeRaw`SELECT pg_sleep(9)`;
    }).catch(() => { /* the refusal itself is pinned above */ });
    const after = (await db.$queryRawUnsafe('SHOW statement_timeout')) as { statement_timeout: string }[];
    expect(after[0]!.statement_timeout).toBe(before[0]!.statement_timeout);
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

describe('#4476 unit — the 57014 classifier (binding condition 1: meta/code, not driver text; non-57014 P2010 stays untyped)', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed.', { code, clientVersion: 'test', ...(meta ? { meta } : {}) });

  it('a P2010 carrying SQLSTATE 57014 converts, with reason TRANSACTION_BUDGET', () => {
    // The shape Prisma surfaces for a cancelled raw statement: code P2010 with the driver's SQLSTATE on meta.
    const cancelled = known('P2010', { code: '57014' });
    expect(isPrismaBusyExhaustion(cancelled)).toBe(true);
    expect(busyReason(cancelled)).toBe('TRANSACTION_BUDGET');
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
});
