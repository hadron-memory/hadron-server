/**
 * #5351 — the run team-snapshot read (`hadron_team_snapshot`, src/lib/runner/tools/teamSnapshotTools.ts) bounds its
 * statements in the database with the roster read's budget (#4476 / #4482): transaction-local `statement_timeout`
 * at TEAM_READ_TX_TIMEOUT_MS and, on PG17+, the `transaction_timeout` backstop a margin past it.
 *
 * Before this the run path went through `inRunTeamReadTx` (RepeatableRead, Prisma's 20 s interactive timeout, retried on
 * serialization failure) and set no statement bound: a Prisma transaction timeout does not cancel a statement already
 * running, so a blocked roster or task statement ran on until it returned.
 *
 * Red on main (0a43cc9d3): with another session holding `workers` or `agent_tasks`, the snapshot waited for the holder to
 * let go (SLEEP_S) and then answered a full snapshot; nothing was cancelled.
 *
 * The gate (`runMayReadTeam`, `loadApp`, the anchors) reads neither `workers` nor `agent_tasks`, so the first statement
 * each lock blocks is the snapshot's own (the roster count, a model statement; the roster or task read).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { resolveRunTools } from '../../../lib/runner/tools/index.js';
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
const WINDOW = { since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z' };

let orgId: string, appId: string, manager: string, triggerId: string;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Snap5351', urn: `snap5351-${generateId()}.example` } });
  orgId = org.id;
  manager = (await db.user.create({ data: { handle: `snap5351-${generateId()}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'Team', urn: `${org.urn}:team`, organizationId: orgId } })).id;
  const agentId = (await db.agent.create({ data: { name: 'Team Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: 'Builder', slug: 'builder' } });
  await db.agentTask.create({ data: { appId, title: 'Existing task', ownerUserId: manager, status: 'pending' } });
  triggerId = (await db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId,
    name: 'Snapshot automation', cron: '* * * * *', entryNodeUrn: 'hrn:node:snap5351.example:flows:report' } })).id;
  const answer = await server.executeOperation({
    query: 'mutation($app:ID!,$trigger:ID!){setAutomationTeamSnapshotGrant(appRef:$app,triggerKind:"SCHEDULE",triggerId:$trigger){id revokedAt}}',
    variables: { app: appId, trigger: triggerId },
  }, { contextValue: ctx(manager) });
  if (answer.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(answer.body.singleResult.errors).toBeUndefined();
});

async function mintRun(): Promise<AppRun> {
  return db.appRun.create({ data: { id: generateId(), organizationId: orgId, appId, agentId: await testRunAgentId(db, orgId, appId), userId: null,
    triggerKind: 'SCHEDULE', triggerId, entryNodeUrn: 'hrn:node:snap5351.example:flows:report', status: 'RUNNING' } });
}
function snapshotTool() {
  const found = resolveRunTools(['hadron_team_snapshot']);
  expect(found.unknown).toEqual([]);
  return found.tools.find(t => t.name === 'hadron_team_snapshot')!;
}
async function callSnapshot() {
  const run = await mintRun();
  return snapshotTool().execute({ db, run, principal: runContext(db, run), log: vi.fn() } as any, { ...WINDOW });
}

/** Another session holds ACCESS EXCLUSIVE on `table` for SLEEP_S while the snapshot runs. */
async function withTableHeld<T>(table: 'workers' | 'agent_tasks', act: () => Promise<T>): Promise<T> {
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    await new Promise((r) => setTimeout(r, SLEEP_S * 1000));
  }, { timeout: HOLDER_TX_TIMEOUT_MS });
  try {
    await new Promise((r) => setTimeout(r, 300)); // the lock lands before the read starts
    return await act();
  } finally {
    await holder;
  }
}

async function expectCancelledAtBudget(table: 'workers' | 'agent_tasks') {
  const t0 = Date.now();
  const outcome: { resolved?: unknown; thrown?: any } = await withTableHeld(table, () => callSnapshot().then(
    (v) => ({ resolved: v }), (e) => ({ thrown: e }),
  ));
  const elapsed = Date.now() - t0 - 300;
  // On main the snapshot waits for the holder (~9 s) and then answers in full.
  expect(outcome.resolved, `the snapshot completed after ${elapsed} ms; the blocked statement was never cancelled`).toBeUndefined();
  expect(elapsed, `refused after ${elapsed} ms; the statement must be cancelled at the ${BUDGET_MS} ms budget, once`).toBeLessThan(REFUSED_BY);
  // The tool's existing typed source failure: nothing partial is returned or saved.
  expect(outcome.thrown.extensions).toMatchObject({ code: 'TEAM_SNAPSHOT_SOURCE_FAILED' });
  expect(outcome.thrown.message).toBe('The required team snapshot source could not be read. Fail the report and save nothing.');
  expect(outcome.thrown.message).not.toContain('canceling statement');
}

describe('#5351 red: the run team-snapshot read is cancelled at the roster budget', () => {
  it('a roster statement blocked behind another session is cancelled at the budget, typed TEAM_SNAPSHOT_SOURCE_FAILED', async () => {
    await expectCancelledAtBudget('workers');
  }, 30_000);

  it('a task statement in the same transaction is bounded too', async () => {
    await expectCancelledAtBudget('agent_tasks');
  }, 30_000);

  it('the connection goes back to the pool without the setting', async () => {
    await expectCancelledAtBudget('workers');
    // Every pooled connection answers the session default: the bound was transaction-local.
    const settings = await Promise.all(Array.from({ length: 8 }, () =>
      db.$queryRaw<Array<{ statement_timeout: string }>>`SELECT current_setting('statement_timeout') AS statement_timeout`));
    for (const [row] of settings) expect(row!.statement_timeout).toBe('0');
    const t1 = Date.now();
    await db.$queryRaw`SELECT 1`;
    expect(Date.now() - t1).toBeLessThan(1_000);
  }, 30_000);

  it('the bound is the roster budget, not tighter: a statement blocked for less than the budget completes', async () => {
    const out = await withTableHeldFor('workers', BUDGET_MS - 2_000, () => callSnapshot()) as { roster: unknown[]; complete: boolean };
    expect(out.complete).toBe(true);
    expect(out.roster).toHaveLength(1);
  }, 30_000);
});

/** Like withTableHeld, but for `ms` instead of SLEEP_S. */
async function withTableHeldFor<T>(table: 'workers', ms: number, act: () => Promise<T>): Promise<T> {
  const holder = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    await new Promise((r) => setTimeout(r, ms));
  }, { timeout: HOLDER_TX_TIMEOUT_MS });
  try {
    await new Promise((r) => setTimeout(r, 300));
    return await act();
  } finally {
    await holder;
  }
}

describe('#5351: a normal snapshot is unchanged', () => {
  it('answers the roster and tasks in full', async () => {
    const out = await callSnapshot() as { roster: Array<{ worker: { name: string } }>; tasks: Array<{ title: string }>; complete: boolean; hasMore: boolean };
    expect(out.complete).toBe(true);
    expect(out.hasMore).toBe(false);
    expect(out.roster.map((r) => r.worker.name)).toEqual(['Builder']);
    expect(out.tasks.map((t) => t.title)).toEqual(['Existing task']);
  });
});

describe('#5351: a read cancelled for time is not retried', () => {
  const cancel = (sqlstate: string) => new Prisma.PrismaClientKnownRequestError('cancelled', { code: 'P2010', clientVersion: 'test', meta: { code: sqlstate } });

  it('neither cancel SQLSTATE counts as a serialization failure', () => {
    expect(isSerializationFailure(cancel('57014'))).toBe(false);
    expect(isSerializationFailure(cancel('25P04'))).toBe(false);
    expect(isSerializationFailure(cancel('40001'))).toBe(true); // control: the retried shape
  });

  it('the serialization retry runs a time-cancelled read once', async () => {
    for (const sqlstate of ['57014', '25P04']) {
      let attempts = 0;
      await expect(retryOnSerializationFailure(async () => { attempts += 1; throw cancel(sqlstate); })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(attempts, `SQLSTATE ${sqlstate}`).toBe(1);
    }
  });
});
