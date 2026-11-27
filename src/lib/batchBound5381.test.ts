/**
 * #5381 (found by #5348 / PR #5371): every `LIMIT n ... FOR UPDATE [OF x] SKIP LOCKED` batch takes the #5371 shape, a
 * MATERIALIZED CTE that is scanned once. As an `id IN (subquery)`, or as a CTE the planner may inline into the outer join, a
 * nested-loop plan can rescan the locking subquery once per outer row; each rescan skips the rows the statement has just changed
 * and takes the next ones, so one batch can process the whole matching set, past every per-batch and per-run bound.
 *
 * Bounds: hrn:node:hadronmemory.com:specs:cor:sec:070:02 ("bounded batches, each its own transaction, with its own per-run
 * budget"; the numbers are engineering bounds) for the change-request retention DELETE and the version purge; the reconcile of
 * hrn:node:hadronmemory.com:specs:cor:int:030:03 and the passkey ceremony sweep (#3122) are bounded only in code.
 *
 * Harness (#5371's pin R8): `SET LOCAL enable_hashjoin = off` and `SET LOCAL enable_mergejoin = off` in the statement's own
 * transaction, on the per-worker clone. The row-count pins are red against the old shapes only while the planner still picks the
 * rescanning nested loop (a table without statistics); the plan pins are red against them in any order: every row-locking node of
 * a batch must be scanned once, inside a CTE with no join between, and the batch must be declared MATERIALIZED (the guard the
 * plan alone cannot show: see expectLocksScannedOnce). Real database throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { deleteEndedSecretChanges, drainEndedSecretChanges } from './secrets/changeRequests.js';
import { purgeSupersededVersions } from './secrets/purge.js';
import { appKeyCache } from './secrets/appKeys.js';
import { resetSecretRetentionWarningsForTests } from './secrets/retention.js';
import { reconcileOrphanedChatToolConnections } from './chatToolTeardown.js';
import { sweepPasskeyCeremonies } from '../jobs/sweepPasskeyCeremonies.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Tx = Prisma.TransactionClient;
type PlanNode = { 'Node Type': string; 'Subplan Name'?: string; 'CTE Name'?: string; Plans?: PlanNode[] };

/** #5371's forced plan: no hash join, no merge join, so a semi join can only be a nested loop. */
const force = async (tx: Tx) => {
  await tx.$executeRawUnsafe('SET LOCAL enable_hashjoin = off');
  await tx.$executeRawUnsafe('SET LOCAL enable_mergejoin = off');
};
/** Run `f` on a transaction under the forced plan. */
const forced = <T>(f: (tx: Tx) => Promise<T>) => db.$transaction(async (tx) => { await force(tx); return f(tx); }, { timeout: 60_000 });
/** A client whose every `$transaction` runs under the forced plan (for drains that open their own transactions). */
const forcedClient = new Proxy(db, {
  get: (t, k) => k === '$transaction'
    ? (fn: (tx: Tx) => Promise<unknown>, opts?: object) => t.$transaction(async (tx) => { await force(tx); return fn(tx); }, { timeout: 60_000, ...opts })
    : (t as any)[k],
}) as unknown as PrismaClient;

/**
 * The batch statements `run` sends, captured instead of executed: `$queryRaw` answers [] and `$executeRaw` 0, so a drain stops
 * after its first statement. Then each is EXPLAINed (not run) and the path from the root to every LockRows node is returned.
 */
async function lockPaths(run: (client: any) => Promise<unknown>): Promise<Array<{ sql: string; locks: string[][] }>> {
  const captured: Prisma.Sql[] = [];
  const grab = (answer: unknown) => (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    captured.push(Array.isArray(strings) ? Prisma.sql(strings as TemplateStringsArray, ...values) : strings as Prisma.Sql);
    return Promise.resolve(answer);
  };
  const fake: any = new Proxy(db, {
    // A batch answers no rows; the purge's closing `more` probe answers false.
    get: (t, k) => k === '$queryRaw' ? (s: any, ...v: unknown[]) => grab(/SKIP LOCKED/.test(Array.isArray(s) ? s.join('') : s.sql) ? [] : [{ more: false }])(s, ...v) : k === '$executeRaw' ? grab(0)
      : k === '$transaction' ? (fn: (tx: unknown) => unknown) => fn(fake) : (t as any)[k],
  });
  await run(fake);
  const out: Array<{ sql: string; locks: string[][] }> = [];
  for (const sql of captured) {
    if (!/SKIP LOCKED/.test(sql.sql)) continue;
    const rows = await db.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`);
    const locks: string[][] = [];
    (function walk(n: PlanNode, path: string[]) {
      const here = [...path, n['Subplan Name'] ?? n['Node Type']];
      if (n['Node Type'] === 'LockRows') locks.push(here);
      for (const c of n.Plans ?? []) walk(c, here);
    })((rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0].Plan, []);
    out.push({ sql: sql.sql, locks });
  }
  return out;
}
/**
 * Every statement locks, and every lock is scanned once: it sits inside a CTE (an InitPlan the executor runs once) with no join
 * between the CTE and the lock. A lock under a join (the `id IN (subquery)` shape's semi join, or a CTE the planner inlined into
 * the outer join) is the rescannable shape. An enclosing data-modifying CTE (the reconcile's `gone`) does not count, as the lock
 * still sits under the join inside it.
 */
function expectLocksScannedOnce(statements: Array<{ sql: string; locks: string[][] }>, count: number) {
  expect(statements.length, 'batch statements captured').toBe(count);
  for (const { sql, locks } of statements) {
    // The declared guard. On the Postgres this runs on, a CTE holding a locking clause was not inlined even without the keyword
    // (the remove-MATERIALIZED mutants left the plan unchanged), so the plan alone cannot pin it; MATERIALIZED is what keeps the
    // batch scanned once if a planner ever does inline it.
    expect(sql, 'the batch statement').toMatch(/\bbatch AS MATERIALIZED \(/);
    expect(locks.length, 'LockRows nodes in the statement').toBeGreaterThan(0);
    for (const path of locks) {
      const cte = path.map((p) => p.startsWith('CTE ')).lastIndexOf(true);
      const below = cte < 0 ? path : path.slice(cte + 1);
      expect({ path: path.join(' > '), insideCte: cte >= 0, joinBetween: below.some((p) => /Join|Nested Loop/.test(p)) },
        'path to a LockRows node').toMatchObject({ insideCte: true, joinBetween: false });
    }
  }
}

let userId: string, appId: string;
beforeEach(async () => {
  await cleanDb(db);
  userId = (await db.user.create({ data: { email: `${generateId()}@bound5381.test` } })).id;
  appId = (await db.app.create({ data: { ownerUserId: userId, name: 'bound 5381', urn: `${generateId().toLowerCase()}:bound5381` } })).id;
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('#5381 deleteEndedSecretChanges (the #5333 retention DELETE)', () => {
  /**
   * `n` ended requests past retention (`expired`), oldest first in insertion order, plus two that must survive. The order matters
   * to the red: the rescanning nested loop cascades only when the outer scan meets rows in the batch's own ORDER BY order (the
   * first outer row is the one the LIMIT picks, so it is deleted, and the next rescan skips it and takes the next).
   */
  async function seedEnded(n: number, prefix: string) {
    await db.$executeRawUnsafe(`INSERT INTO secret_change_requests
      (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,write_version,expires_at,ended_at)
      SELECT $1 || g, $2, 'n' || g, 'generic', '{}'::jsonb, 'DELETE', $3, 'expired', 'snap', false,
        (clock_timestamp() AT TIME ZONE 'UTC') - interval '40 days',
        (clock_timestamp() AT TIME ZONE 'UTC') - interval '31 days' - (${n} - g) * interval '1 millisecond'
      FROM generate_series(1, ${n}) g`, prefix, appId, userId);
    await db.$executeRawUnsafe(`INSERT INTO secret_change_requests
      (id,app_id,secret_name,secret_kind,metadata,operation,requester_id,state,snapshot,write_version,expires_at,ended_at)
      VALUES ('keep-recent', $1, 'r', 'generic', '{}'::jsonb, 'DELETE', $2, 'expired', 'snap', false,
        (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 days', (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day'),
      ('keep-open', $1, 'o', 'generic', '{}'::jsonb, 'DELETE', $2, 'open', 'snap', false,
        (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour', NULL)`, appId, userId);
  }
  const left = (prefix: string) => db.secretChangeRequest.count({ where: { id: { startsWith: prefix } } });

  it('B1: one forced-plan batch of limit 1 deletes exactly 1 row', async () => {
    await seedEnded(60, 'ret');
    const n = await forced((tx) => deleteEndedSecretChanges(tx, 1));
    expect(n, `deleteEndedSecretChanges(tx, 1) deleted ${n} rows`).toBe(1);
    expect(await left('ret')).toBe(59);
  });
  it('B2: the batch is a MATERIALIZED CTE and every row lock is scanned once (inside a CTE, no join between)', async () => {
    expectLocksScannedOnce(await lockPaths((c) => deleteEndedSecretChanges(c, 1)), 1);
  });
  it('B3: a run holds batch x maxBatches, and successive runs delete every row past retention exactly once, nothing else', async () => {
    await seedEnded(25, 'drain');
    const runs: number[] = [];
    for (let i = 0; i < 6; i++) runs.push(await drainEndedSecretChanges(forcedClient, { batchSize: 2, maxBatches: 3 }));
    expect(runs, 'rows deleted per run').toEqual([6, 6, 6, 6, 1, 0]);
    expect(await left('drain')).toBe(0);
    expect((await db.secretChangeRequest.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((r) => r.id)).toEqual(['keep-open', 'keep-recent']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('#5381 reconcileOrphanedChatToolConnections (the cor:int:030:03 reconcile)', () => {
  /**
   * `n` live telegram and `n` live slack connections whose App is soft-deleted (one App each: a telegram connection is unique per
   * App), created in id order (the batch's ORDER BY), plus one of each under a live App that must never be reached.
   */
  async function seedOrphans(n: number) {
    const org = (await db.organization.create({ data: { id: generateId(), name: 'rc-org', urn: `rc-${generateId().toLowerCase()}` } })).id;
    const app = async (name: string) => (await db.app.create({ data: { id: generateId(), organizationId: org, name, urn: `${generateId().toLowerCase()}::${name}` } })).id;
    const gone: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = await app(`gone${i}`); gone.push(a);
      await db.telegramConnection.create({ data: { id: `tgc-${String(i).padStart(3, '0')}`, organizationId: org, appId: a, toolConnectionId: `tg-${i}`, botId: `bot-${i}`, botUsername: `bot_${i}`, displayName: `t${i}` } });
      await db.slackConnection.create({ data: { id: `slc-${String(i).padStart(3, '0')}`, organizationId: org, defaultAppId: a, toolConnectionId: `sl-${i}`, teamId: `T-${i}`, teamName: `s${i}`, botUserId: `U-${i}`, botId: `B-${i}` } });
    }
    const live = await app('live');
    await db.telegramConnection.create({ data: { id: 'tgc-live', organizationId: org, appId: live, toolConnectionId: 'tg-live', botId: 'bot-live', botUsername: 'bot_live', displayName: 'live' } });
    await db.slackConnection.create({ data: { id: 'slc-live', organizationId: org, defaultAppId: live, toolConnectionId: 'sl-live', teamId: 'T-live', teamName: 'live', botUserId: 'U-live', botId: 'B-live' } });
    await db.app.updateMany({ where: { id: { in: gone } }, data: { deletedAt: new Date() } });
  }
  const softDeleted = async () => ({
    telegram: await db.telegramConnection.count({ where: { deletedAt: { not: null } } }),
    slack: await db.slackConnection.count({ where: { deletedAt: { not: null } } }),
  });

  it('C1: one forced-plan call of limit 1 queues exactly 1 telegram and 1 slack row', async () => {
    await seedOrphans(40);
    const n = await forced((tx) => reconcileOrphanedChatToolConnections(tx as unknown as PrismaClient, 1));
    const after = await softDeleted();
    expect(after, `reconcile(limit 1) returned ${n}; soft-deleted telegram ${after.telegram}, slack ${after.slack}`).toEqual({ telegram: 1, slack: 1 });
    expect(n).toBe(2);
    expect(await db.chatToolTeardownIntent.count()).toBe(2);
  });
  it('C2: both batches are MATERIALIZED CTEs and every row lock is scanned once (inside a CTE, no join between)', async () => {
    expectLocksScannedOnce(await lockPaths((c) => reconcileOrphanedChatToolConnections(c, 1)), 2);
  });
  it('C3: successive forced-plan calls queue every orphan exactly once and never a live owner\'s row', async () => {
    await seedOrphans(7);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) runs.push(await forced((tx) => reconcileOrphanedChatToolConnections(tx as unknown as PrismaClient, 3)));
    expect(runs, 'rows queued per call (telegram + slack)').toEqual([6, 6, 2, 0, 0]);
    expect(await softDeleted()).toEqual({ telegram: 7, slack: 7 });
    expect(await db.chatToolTeardownIntent.count()).toBe(14);
    expect(await db.telegramConnection.findFirstOrThrow({ where: { toolConnectionId: 'tg-live' } })).toMatchObject({ deletedAt: null });
    expect(await db.slackConnection.findFirstOrThrow({ where: { toolConnectionId: 'sl-live' } })).toMatchObject({ deletedAt: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('#5381 purgeSupersededVersions (the version retention purge)', () => {
  let memberId: string;
  const ctx = (): Context => ({ db, userId: memberId, roles: [] }) as unknown as Context;
  beforeEach(async () => {
    process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
    process.env.SECRET_ROOT_KEY = '22'.repeat(32);
    delete process.env.SECRET_VERSION_RETENTION_DAYS;
    resetSecretRetentionWarningsForTests();
    appKeyCache.clear();
    memberId = (await db.user.create({ data: { email: `${generateId()}@bound5381.test` } })).id;
    await db.appMember.create({ data: { appId, userId: memberId, role: 'reader' } });
  });
  afterEach(() => { appKeyCache.clear(); });
  /** `secrets` secrets of `versions` versions each; every superseded version is back-dated past retention. */
  async function seedVersions(secrets: number, versions: number) {
    for (let s = 0; s < secrets; s++) {
      const created = await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: `s${s}`, kind: 'generic', value: 'v1' }, ctx());
      for (let v = 2; v <= versions; v++) await resolvers.Mutation.updateSecret({}, { ref: (created as { id: string }).id, value: `v${v}` }, ctx());
    }
    await db.$executeRaw`UPDATE secret_versions SET superseded_at = (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(days => 400)
      WHERE superseded_at IS NOT NULL`;
  }

  it('P1: one forced-plan batch of size 1 deletes exactly 1 version', async () => {
    await seedVersions(4, 5); // 16 purgeable
    const r = await purgeSupersededVersions(forcedClient, { batchSize: 1, maxBatches: 1 });
    expect(r.purged, `purgeSupersededVersions({ batchSize: 1, maxBatches: 1 }) purged ${r.purged}`).toBe(1);
    expect(await db.secretVersion.count()).toBe(19);
  });
  it('P2: the batch is a MATERIALIZED CTE and every row lock is scanned once (inside a CTE, no join between)', async () => {
    expectLocksScannedOnce(await lockPaths((c) => purgeSupersededVersions(c, { batchSize: 1, maxBatches: 1 })), 1);
  });
  it('P3: a run holds batch x maxBatches; successive runs purge every superseded version exactly once and never a current one', async () => {
    await seedVersions(3, 4); // 9 purgeable, 3 current
    const runs: number[] = [];
    for (let i = 0; i < 4; i++) runs.push((await purgeSupersededVersions(forcedClient, { batchSize: 2, maxBatches: 2 })).purged);
    expect(runs, 'versions purged per run').toEqual([4, 4, 1, 0]);
    expect(await db.secretVersion.count()).toBe(3);
    expect(await db.secretVersion.count({ where: { supersededAt: null } })).toBe(3);
    expect(await db.secretEvent.count({ where: { kind: 'PURGE' } })).toBe(9);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('#5381 sweepPasskeyCeremonies (the #3122 ceremony sweep)', () => {
  async function ceremony(id: string, ageSeconds: number) {
    await db.$executeRaw`INSERT INTO passkey_ceremonies(id,purpose,browser_nonce_hash,challenge_hash,expires_at)
      VALUES(${id},'SIGN_IN',${'a'.repeat(64)},${'b'.repeat(64)},(clock_timestamp() AT TIME ZONE 'UTC') - make_interval(secs => ${ageSeconds}))`;
  }
  async function seedCeremonies(n: number) {
    // Oldest first in insertion order (the batch orders by expiry), so the rescanning plan cascades: see seedEnded.
    for (let i = 0; i < n; i++) await ceremony(`old-${String(i).padStart(3, '0')}`, 31 * 86400 + (n - i));
    await ceremony('live', -300);
    await ceremony('recent', 60);
  }
  const old = () => db.passkeyCeremony.count({ where: { id: { startsWith: 'old-' } } });

  it('K1: one forced-plan pass of size 1 deletes exactly 1 ceremony', async () => {
    await seedCeremonies(40);
    const n = await forced((tx) => sweepPasskeyCeremonies(tx as unknown as PrismaClient, { batchSize: 1, maxPasses: 1 }));
    expect(n, `sweepPasskeyCeremonies({ batchSize: 1, maxPasses: 1 }) deleted ${n}`).toBe(1);
    expect(await old()).toBe(39);
  });
  it('K2: the batch is a MATERIALIZED CTE and every row lock is scanned once (inside a CTE, no join between)', async () => {
    expectLocksScannedOnce(await lockPaths((c) => sweepPasskeyCeremonies(c, { batchSize: 1, maxPasses: 1 })), 1);
  });
  it('K3: a run holds batch x passes; successive runs delete every retired ceremony once; live ceremonies and credentials are untouched', async () => {
    const user = await db.user.create({ data: { handle: `k3-${generateId().slice(0, 6).toLowerCase()}`, roles: [] } });
    const credId = await insertSoftPasskey(db, user.id, softPasskey());
    const credBefore = await db.passkeyCredential.findUniqueOrThrow({ where: { id: credId } });
    await seedCeremonies(11);
    const liveBefore = await db.passkeyCeremony.findMany({ where: { id: { in: ['live', 'recent'] } }, orderBy: { id: 'asc' } });
    const runs: number[] = [];
    for (let i = 0; i < 4; i++) runs.push(await forced((tx) => sweepPasskeyCeremonies(tx as unknown as PrismaClient, { batchSize: 2, maxPasses: 3 })));
    expect(runs, 'ceremonies deleted per run').toEqual([6, 5, 0, 0]);
    expect(await old()).toBe(0);
    expect(await db.passkeyCeremony.findMany({ orderBy: { id: 'asc' } })).toEqual(liveBefore);
    expect(await db.passkeyCredential.findUniqueOrThrow({ where: { id: credId } })).toEqual(credBefore);
  });
});
