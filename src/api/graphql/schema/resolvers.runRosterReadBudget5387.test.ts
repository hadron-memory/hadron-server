/**
 * #5387 — a run principal's roster-family reads (every `withRosterAppRead` caller: teamRoster, teamUtilization, team
 * metrics, the alarm views) bound their statements in the database with the person path's budget (#4476 / #4482):
 * transaction-local `statement_timeout` at TEAM_READ_TX_TIMEOUT_MS and, on PG17+, the `transaction_timeout` backstop a
 * margin past it. A cancel answers the person path's typed TEAM_READ_BUSY refusal.
 *
 * Before this `withRosterAppRead` sent a userless run principal to `withReadableApp`'s run arm (`inRunTeamReadTx`:
 * RepeatableRead, Prisma's 20 s interactive timeout, retried on serialization failure) with no statement bound, and a
 * Prisma transaction timeout does not cancel a statement already running.
 *
 * Red on main (399b2d6b): with another session holding `workers`, the run's teamRoster and teamUtilization waited for the
 * holder to let go (SLEEP_S) and then answered; nothing was cancelled.
 *
 * The run arm's gate (`runMayReadTeam`, `loadApp`, the anchors) does not read `workers`, so the first statement the lock
 * blocks is the roster's own. The pin pattern (lock-acquired handshake) is #5351's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { TEAM_READ_TX_TIMEOUT_MS } from '../../../lib/agentTasks/teamReadBudget.js';
import { retryOnSerializationFailure, isSerializationFailure } from '../../../lib/serializableRetry.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import { testRunAgentId } from '../../../test/runAgent.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn(async () => {}) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
beforeAll(() => server.start());
afterAll(() => server.stop());

const BUDGET_MS = TEAM_READ_TX_TIMEOUT_MS; // 5 s, the roster read's budget
/** The holder keeps its lock this long: "cancelled at the budget" and "ran until the holder let go" are (SLEEP - BUDGET) apart. */
const SLEEP_S = Math.ceil(BUDGET_MS * 1.8 / 1000); // 9 s
/** Green needs Postgres's cancel (~BUDGET_MS) plus slack; main answers at SLEEP_S+. A retry of the cancelled read would
 *  wait another full budget behind the same lock, so this bound also refuses a retry. */
const REFUSED_BY = BUDGET_MS * 1.5; // 7.5 s
const HOLDER_TX_TIMEOUT_MS = BUDGET_MS * 4;

let orgId: string, appId: string, manager: string, triggerId: string;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Roster5387', urn: `roster5387-${generateId()}.example` } });
  orgId = org.id;
  manager = (await db.user.create({ data: { handle: `roster5387-${generateId()}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: orgId } })).id;
  const agentId = (await db.agent.create({ data: { name: 'Team Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Builder', slug: 'builder' } });
  await db.agentTask.create({ data: { appId, title: 'Existing task', ownerUserId: manager, status: 'pending' } });
  triggerId = (await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId,
    name: 'Roster automation', cron: '* * * * *', entryNodeUrn: 'hrn:node:roster5387.example:flows:report' } })).id;
  const answer = await server.executeOperation({
    query: 'mutation($app:ID!,$trigger:ID!){setAutomationTeamSnapshotGrant(appRef:$app,triggerKind:"SCHEDULE",triggerId:$trigger){id revokedAt}}',
    variables: { app: appId, trigger: triggerId },
  }, { contextValue: ctx(manager) });
  if (answer.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(answer.body.singleResult.errors).toBeUndefined();
});

async function mintRun(): Promise<AppRun> {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), userId: null,
    triggerKind: 'SCHEDULE', triggerId, entryNodeUrn: 'hrn:node:roster5387.example:flows:report', status: 'RUNNING' } });
}
/**
 * Another session holds ACCESS EXCLUSIVE on `table` for `ms` (default SLEEP_S) while `act` runs. `act` starts only once
 * the holder's LOCK statement has returned, so the lock is held when the read starts (no sleep-based handshake). A holder
 * that fails before locking fails the test with its own error; once `act` has run, its outcome is what the test sees, and
 * a later holder failure is reported only when `act` succeeded.
 */
async function withTableHeld<T>(table: 'workers' | 'agent_tasks', act: () => Promise<T>, ms = SLEEP_S * 1000): Promise<T> {
  let locked!: () => void;
  const lockHeld = new Promise<void>((r) => { locked = r; });
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    locked();
    await new Promise((r) => setTimeout(r, ms));
  }, { timeout: HOLDER_TX_TIMEOUT_MS });
  await Promise.race([lockHeld, holder]); // a holder that fails before locking rejects here
  let result: T;
  try {
    result = await act();
  } catch (e) {
    await holder.catch(() => {}); // let the holder release; act's own error is the one reported
    throw e;
  }
  await holder;
  return result;
}

const Q = resolvers.Query as any;
const callers = {
  teamRoster: async () => Q.teamRoster({}, { appRef: appId }, runContext(db, await mintRun())),
  teamUtilization: async () => Q.teamUtilization({}, { appRef: appId }, runContext(db, await mintRun())),
} as const;
type Caller = keyof typeof callers;

function sqlstateOf(cause: unknown): string | undefined {
  return cause instanceof Prisma.PrismaClientKnownRequestError
    ? String((cause.meta as { code?: unknown } | undefined)?.code)
    : (cause as Error | undefined)?.message.match(/PostgresError \{ code: "(\w+)"/)?.[1];
}

async function expectCancelledAtBudget(caller: Caller) {
  let elapsed = -1;
  const outcome: { resolved?: unknown; thrown?: any } = await withTableHeld('workers', async () => {
    const t0 = Date.now();
    const settled = await callers[caller]().then((v) => ({ resolved: v }), (e) => ({ thrown: e }));
    elapsed = Date.now() - t0;
    return settled;
  });
  // On main the run's read waits for the holder (~9 s) and then answers.
  expect(outcome.resolved, `${caller} completed after ${elapsed} ms; the blocked statement was never cancelled`).toBeUndefined();
  expect(elapsed, `${caller} refused after ${elapsed} ms; the statement must be cancelled at the ${BUDGET_MS} ms budget, once`).toBeLessThan(REFUSED_BY);
  // The person path's typed, retryable refusal, not a raw driver fault.
  expect(outcome.thrown.extensions).toMatchObject({ code: 'TEAM_READ_BUSY', retryable: true, reason: 'TRANSACTION_BUDGET', budgetMs: BUDGET_MS });
  expect(outcome.thrown.message).not.toContain('canceling statement');
  // The statement cap fired (57014, non-fatal), not only the PG17 backstop's FATAL 25P04 a margin later.
  expect(sqlstateOf(outcome.thrown.cause), `cause: ${String(outcome.thrown.cause)}`).toBe('57014');
}

describe('#5387 red: a run principal\'s roster-family read is cancelled at the roster budget', () => {
  it('teamRoster: a roster statement blocked behind another session is cancelled at the budget, typed TEAM_READ_BUSY', async () => {
    await expectCancelledAtBudget('teamRoster');
  }, 30_000);

  it('teamUtilization (another withRosterAppRead caller) is bounded the same way', async () => {
    await expectCancelledAtBudget('teamUtilization');
  }, 30_000);

  it('the connection goes back to the pool without the setting', async () => {
    await expectCancelledAtBudget('teamRoster');
    const settings = await Promise.all(Array.from({ length: 8 }, () =>
      db.$queryRaw<Array<{ statement_timeout: string }>>`SELECT current_setting('statement_timeout') AS statement_timeout`));
    for (const [row] of settings) expect(row!.statement_timeout).toBe('0');
    const t1 = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t1).toBeLessThan(1_000);
  }, 30_000);

  it('the bound is the roster budget, not tighter: a statement blocked for less than the budget completes', async () => {
    const out = await withTableHeld('workers', () => callers.teamRoster(), BUDGET_MS - 2_000) as { workers: unknown[] };
    expect(out.workers).toHaveLength(1);
  }, 30_000);
});

describe('#5387: an unblocked run read is unchanged', () => {
  it('teamRoster answers the roster', async () => {
    const out = await callers.teamRoster() as { workers: Array<{ name?: string; worker?: { name: string } }> };
    expect(out.workers).toHaveLength(1);
  });

  it('a run with no team-snapshot grant is still APP_NOT_FOUND, not a busy refusal', async () => {
    const grant = await db.appAutomationTeamSnapshotGrant.findFirstOrThrow({ where: { appId, revokedAt: null } });
    const revoked = await server.executeOperation({ query: 'mutation($id:ID!){revokeAutomationTeamSnapshotGrant(id:$id){id revokedAt}}', variables: { id: grant.id } },
      { contextValue: ctx(manager) });
    if (revoked.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(revoked.body.singleResult.errors).toBeUndefined();
    const thrown = await callers.teamRoster().then(() => undefined, (e) => e);
    expect(thrown?.extensions?.code).toBe('APP_NOT_FOUND');
  });
});
