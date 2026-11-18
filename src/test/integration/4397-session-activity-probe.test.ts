import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { workerActivitySql, setWorkerActivityPlanSettings, loadAppWorkerActivity } from '../../api/graphql/schema/resolvers.worker.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
import { everyRowProbe, skipSeedForeignKeys } from '../sessionActivityProbe.js';

/**
 * #4397: the roster's per-session latest-activity probe is ONE probe of usage_events_session_activity_idx, not a read
 * of every activity row of every open session (the 2026-11-17 P2028 incident). Plan and buffers are pinned under
 * skewed, ANALYZEd statistics in a transaction that always rolls back (seeds and ANALYZE never escape).
 */
const APP = 'app-4397';
const NOW = new Date('2026-11-17T12:00:00Z');
const HEAVY_ROWS = 60_000;

type Tx = Prisma.TransactionClient;
class RolledBack extends Error {}

async function rolledBack<T>(fn: (tx: Tx) => Promise<T>, o: { planSettings?: boolean } = {}): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        await skipSeedForeignKeys(tx);
        // What queryWorkerActivity sets before the read: the pins run under exactly what ships.
        if (o.planSettings !== false) await setWorkerActivityPlanSettings(tx);
        out = { value: await fn(tx) };
        throw new RolledBack();
      },
      { timeout: 120_000 },
    );
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  return out!.value;
}

const roster = (): Prisma.Sql => workerActivitySql(Prisma.sql`w.app_id = ${APP}`, NOW);

/** The pre-#4397 probe (#1952's max over `created_at + interval '0'`): reads every activity row of the session. */
function everyRowShape(sql: Prisma.Sql): Prisma.Sql {
  return everyRowProbe(sql, "max(e.created_at + interval '0')");
}

async function seed(tx: Tx, heavy: number): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO workers (id, app_id, agent_id, name, slug, signature, trailer)
    SELECT w.*, ${WORKER_SIGNATURE_DEFAULTS.signature}, ${WORKER_SIGNATURE_DEFAULTS.trailer}
    FROM (VALUES
      ('w4397-heavy', ${APP}, 'agent-4397', 'Heavy', 'heavy'),
      ('w4397-empty', ${APP}, 'agent-4397', 'Empty', 'empty'),
      ('w4397-nonact', ${APP}, 'agent-4397', 'NonAct', 'nonact'),
      ('w4397-closed', ${APP}, 'agent-4397', 'Closed', 'closed'),
      ('w4397-expired', ${APP}, 'agent-4397', 'Expired', 'expired')) AS w(id, app_id, agent_id, name, slug)`);
  await tx.$executeRawUnsafe(`
    INSERT INTO sessions (id, worker_id, type, started_at, updated_at, ended_at, auto_expired_at) VALUES
      ('s4397-heavy',  'w4397-heavy',  'DEVELOPER', '2026-11-01 00:00:00', '2026-11-01 00:00:00', NULL, NULL),
      ('s4397-empty',  'w4397-empty',  'DEVELOPER', '2026-11-10 00:00:00', '2026-11-10 00:00:00', NULL, NULL),
      ('s4397-nonact', 'w4397-nonact', 'DEVELOPER', '2026-11-10 00:00:00', '2026-11-10 00:00:00', NULL, NULL),
      ('s4397-closed', 'w4397-closed', 'DEVELOPER', '2026-11-05 00:00:00', '2026-11-06 00:00:00', '2026-11-06 00:00:00', NULL),
      ('s4397-expired','w4397-expired','DEVELOPER', '2026-11-05 00:00:00', '2026-11-06 00:00:00', '2026-11-06 00:00:00', '2026-11-06 00:00:00')`);
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT 'ue4397-h-' || g, 'tool_call', 's4397-heavy', true, timestamp '2026-11-01 00:00:01' + g * interval '10 seconds'
    FROM generate_series(1, ${heavy}) g`);
  // Many small sessions, so the statistics are skewed like production's.
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT 'ue4397-s-' || g, 'tool_call', 's4397-small-' || (g % 400), true, timestamp '2026-10-01' + g * interval '1 second'
    FROM generate_series(1, 4000) g`);
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at) VALUES
      -- newest row of s4397-nonact is NOT activity: the answer is the older activity row
      ('ue4397-na1', 'tool_call', 's4397-nonact', true,  '2026-11-12 08:00:00'),
      ('ue4397-na2', 'tool_call', 's4397-nonact', false, '2026-11-16 08:00:00'),
      -- closed + updated_at >= ended_at and not auto-expired: its events are not read (#4271)
      ('ue4397-c1', 'tool_call', 's4397-closed', true, '2026-11-05 12:00:00'),
      ('ue4397-c2', 'tool_call', 's4397-closed', true, '2026-11-16 12:00:00'),
      -- auto-expired: the exclusion does not apply, its events are read
      ('ue4397-x1', 'tool_call', 's4397-expired', true, '2026-11-05 12:00:00'),
      ('ue4397-x2', 'tool_call', 's4397-expired', true, '2026-11-05 18:00:00')`);
  await tx.$executeRawUnsafe('ANALYZE usage_events');
}

interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Shared Hit Blocks': number; 'Shared Read Blocks': number; Plans?: PlanNode[] }
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];

async function analyze(tx: Tx, sql: Prisma.Sql): Promise<{ buffers: number; indexes: string[]; text: string }> {
  const rows = await tx.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  const root = rows[0]['QUERY PLAN'][0].Plan;
  const indexes = walk(root).flatMap((n) => (n['Index Name'] ? [n['Index Name']] : []));
  return { buffers: root['Shared Hit Blocks'] + root['Shared Read Blocks'], indexes, text: JSON.stringify(root) };
}

describe('#4397 roster liveness: one probe per open session', () => {
  // #4399 item 5: the 60k-row seed is the churn (every rolled-back insert leaves a dead tuple), so the two plan pins share ONE
  // seed and one transaction, and the tables are vacuumed afterwards.
  let heavyRun: { fix: Awaited<ReturnType<typeof analyze>>; every: Awaited<ReturnType<typeof analyze>> };
  beforeAll(async () => {
    heavyRun = await rolledBack(async (tx) => {
      await seed(tx, HEAVY_ROWS);
      return { fix: await analyze(tx, roster()), every: await analyze(tx, everyRowShape(roster())) };
    });
  }, 120_000);
  afterAll(async () => {
    for (const t of ['usage_events', 'sessions', 'workers']) await db.$executeRawUnsafe(`VACUUM ${t}`);
  }, 120_000);

  it('reads a bounded number of buffers however many activity rows a session holds, never walks created_at_idx', () => {
    const fix = heavyRun.fix;
    expect(fix.indexes, fix.text).not.toContain('usage_events_created_at_idx');
    expect(fix.indexes, fix.text).toContain('usage_events_session_activity_idx');
    // A probe's cost, not a scan's: the heavy session's 60k activity rows would be hundreds of pages.
    expect(fix.buffers, fix.text).toBeLessThan(150);
  });

  it('the buffers bound is not vacuous: the every-row shape (main) reads far more under the same skew', () => {
    expect(heavyRun.every.buffers).toBeGreaterThan(heavyRun.fix.buffers * 10);
  });

  it('the answer is the newest QUALIFYING row, NULL when none (cor:agt:020:11 rules 3, 4)', async () => {
    const rows = await rolledBack(async (tx) => {
      await seed(tx, 100);
      return tx.$queryRaw<{ workerId: string; lastActiveAt: Date }[]>(
        Prisma.sql`SELECT r."workerId", r."lastActiveAt" FROM (${roster()}) r ORDER BY r."workerId"`,
      );
    });
    const at = Object.fromEntries(rows.map((r) => [r.workerId, r.lastActiveAt?.toISOString()]));
    // heavy: newest of 100 rows at +10s steps
    expect(at['w4397-heavy']).toBe('2026-11-01T00:16:41.000Z');
    // never driven: falls back to startedAt/updatedAt, not NULL and not "now"
    expect(at['w4397-empty']).toBe('2026-11-10T00:00:00.000Z');
    // newest row is not activity: the older activity row wins
    expect(at['w4397-nonact']).toBe('2026-11-12T08:00:00.000Z');
    // closed and capped by its own stamps: activity is capped at ended_at whatever the events say
    expect(at['w4397-closed']).toBe('2026-11-06T00:00:00.000Z');
    // auto-expired: the exclusion does not apply, its events are read (newest 18:00 is before the end, so uncapped)
    expect(at['w4397-expired']).toBe('2026-11-05T18:00:00.000Z');
  });
});

describe('#4397 the plan settings are transaction-local (they never reach the pool)', () => {
  // A leak would silently change plans fleet-wide. The read goes through the shipped entry point, then EVERY pooled
  // connection is asked for the two settings: set_config(..., false) (session scope) leaves one of them off on the
  // connection the read used, so the sweep below finds it. The defaults are read first, not assumed.
  it('after the roster read, no pooled connection sees enable_incremental_sort or jit changed', async () => {
    const show = async (): Promise<{ sort: string; jit: string }> => {
      const [r] = await db.$queryRaw<{ sort: string; jit: string }[]>`SELECT current_setting('enable_incremental_sort') AS sort, current_setting('jit') AS jit`;
      return r;
    };
    const before = await show();
    await loadAppWorkerActivity({ db } as unknown as Context, APP, { now: NOW });
    const seen = await Promise.all(Array.from({ length: 40 }, () => show()));
    for (const s of seen) expect(s).toEqual(before);
  });
});

describe('#4397 the plan settings are applied by the real read path (#4399 item 3)', () => {
  // The pins above call setWorkerActivityPlanSettings themselves, so they say nothing about whether queryWorkerActivity
  // does. These run the shipped entry point WITHOUT the pins' own call and read the settings back on the transaction the
  // read ran on. set_config(..., true) outside a transaction is a silent no-op, so reading it back in that same
  // transaction is what shows it took effect.
  type Settings = { sort: string; jit: string };
  const show = async (c: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Settings> => {
    const [r] = await c.$queryRaw<Settings[]>`SELECT current_setting('enable_incremental_sort') AS sort, current_setting('jit') AS jit`;
    return r;
  };

  it('on a caller\'s transaction, the read leaves incremental sort and jit off for that transaction', async () => {
    const r = await rolledBack(async (tx) => {
      const before = await show(tx);
      await loadAppWorkerActivity({ db: tx } as unknown as Context, APP, { now: NOW });
      return { before, after: await show(tx) };
    }, { planSettings: false });
    expect(r.before.sort).toBe('on');
    expect(r.after).toEqual({ sort: 'off', jit: 'off' });
  });

  it('on the shared client, the settings are in force inside the transaction the read opens', async () => {
    let inside: Settings | undefined;
    const spy = new Proxy(db as any, {
      get(target, prop, recv) {
        if (prop !== '$transaction') return Reflect.get(target, prop, recv);
        return (f: (tx: Tx) => Promise<unknown>) => target.$transaction(async (tx: Tx) => {
          const out = await f(tx);
          inside = await show(tx);
          return out;
        });
      },
    });
    await loadAppWorkerActivity({ db: spy } as unknown as Context, APP, { now: NOW });
    expect(inside).toEqual({ sort: 'off', jit: 'off' });
  });
});
