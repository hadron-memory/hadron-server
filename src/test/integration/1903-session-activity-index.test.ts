import { WORKER_SIGNATURE_DEFAULTS } from '../../lib/workerSignature.js';
/**
 * #1903 — the session-activity index that production went down without, and
 * #1952 — the query shape that keeps the planner off the incident's walk.
 *
 * On 2026-10-14 the roster liveness fold (`workerActivitySql`) probed
 * usage_events once per session for max(created_at) of its activity events.
 * The planner served that max by walking usage_events_created_at_idx
 * BACKWARDS, which for a session with no (or ancient) activity rows meant the
 * whole 10.7M-row index; 12+ minutes per roster read exhausted the pool
 * (ops:alpha:incident-2026-10-14-pool-exhaustion-liveness-query). #1903 added
 * the partial index below, which Prisma can't model: it lives in
 * post-push.sql and migration 20261014040000.
 *
 * The index alone was not enough (#1952). With ACCURATE statistics in which a
 * few sessions dominate activity, the planner still picks the created_at walk
 * for a bare max(created_at), and no rewording of "newest first" avoids it
 * (ORDER BY … LIMIT 1 is the same plan). The probe therefore aggregates
 * `created_at + interval '0'`, an expression no created_at index can order, so
 * the only paths left are session-keyed.
 *
 * Pinned here: the index exists with its exact shape; the probe never walks
 * usage_events_created_at_idx, on the test DB's own statistics or on the
 * skewed statistics that produce the incident plan; and the shape change moves
 * only the PLAN, never the answer. The plan pins disable sequential and bitmap
 * scans so a tiny test table can't make the planner's choice moot; within
 * index paths the question is exactly the incident's.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { workerActivitySql } from '../../api/graphql/schema/resolvers.worker.js';

const INDEX = 'usage_events_session_activity_idx';
const WALK = 'usage_events_created_at_idx';
const APP = 'app-1903';
const NOW = new Date('2026-10-14T12:00:00Z');

type Tx = Prisma.TransactionClient;

/** Runs `fn` in a transaction that always rolls back, so seeds, ANALYZE and dropped indexes never escape. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
        out = { value: await fn(tx) };
        throw new RolledBack();
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  if (!out) throw new Error('unreachable');
  return out.value;
}

class RolledBack extends Error {}

const roster = (): Prisma.Sql => workerActivitySql(Prisma.sql`w.app_id = ${APP}`, NOW);

/**
 * The pre-#1952 probe shape (a bare `max(e.created_at)`), derived from the
 * live SQL so the parity pin compares the shipped query against exactly one
 * difference.
 */
function incidentShape(sql: Prisma.Sql): Prisma.Sql {
  const D = "max(e.created_at + interval '0')";
  const hits = sql.strings.filter((s) => s.includes(D)).length;
  if (hits !== 1) throw new Error(`expected the probe shape exactly once, found ${hits}`);
  const strings = sql.strings.map((s) => s.replace(D, 'max(e.created_at)'));
  return Prisma.sql(Object.assign(strings, { raw: strings }) as TemplateStringsArray, ...sql.values);
}

async function explain(tx: Tx, sql: Prisma.Sql): Promise<string> {
  const rows = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${sql}`);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

/**
 * The #1952 skew: 20,000 activity rows in ONE session, then a real ANALYZE.
 * session_replication_role=replica skips the FKs (and triggers), so the rows
 * need no session, worker or App behind them.
 */
async function seedSkew(tx: Tx): Promise<void> {
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
  await tx.$executeRawUnsafe(`
    INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at)
    SELECT 'ue-skew-' || g, 'tool_call', 'sess-heavy', true,
           timestamp '2026-09-01 00:00:00' + g * interval '1 second'
    FROM generate_series(1, 20000) g`);
  await tx.$executeRawUnsafe('ANALYZE usage_events');
}

/** A plan-assertion message that carries the plan, so a future failure is diagnosable from the log. */
const withPlan = (plan: string) => `chosen plan:\n${plan}`;

describe('#1903 / #1952 roster liveness probe', () => {
  it('the activity index exists, partial on counts_as_activity, over (session_id, created_at)', async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'usage_events' AND indexname = ${INDEX}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(session_id, created_at\) WHERE counts_as_activity$/);
  });

  it('never walks the created_at index on the test DB\'s own statistics', async () => {
    const plan = await rolledBack((tx) => explain(tx, roster()));
    expect(plan, withPlan(plan)).not.toContain(WALK);
    expect(plan, withPlan(plan)).toMatch(/usage_events_\w+_idx/);
  });

  it('never walks the created_at index under skewed statistics (one session dominating activity)', async () => {
    const plan = await rolledBack(async (tx) => {
      await seedSkew(tx);
      return explain(tx, roster());
    });
    expect(plan, withPlan(plan)).not.toContain(WALK);
  });

  it('the skew pin is not vacuous: the bare max(created_at) walks the created_at index under that skew', async () => {
    const plan = await rolledBack(async (tx) => {
      await seedSkew(tx);
      return explain(tx, incidentShape(roster()));
    });
    expect(plan, withPlan(plan)).toContain(WALK);
  });

  it('the index pin is not vacuous: without the index the probe plans elsewhere', async () => {
    const plan = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
      return explain(tx, roster());
    });
    expect(plan, withPlan(plan)).not.toContain(INDEX);
    expect(plan, withPlan(plan)).toMatch(/usage_events_\w+_idx/);
  });

  it('moves only the plan: the answer is identical to the bare max(created_at) under both plans', async () => {
    const result = await rolledBack(async (tx) => {
      await seedSkew(tx);
      // The heavy session and a spread of liveness cases, all in scope. Times
      // are naive UTC, as the columns are.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO workers (id, app_id, agent_id, name, slug, signature, trailer)
        SELECT w.*, ${WORKER_SIGNATURE_DEFAULTS.signature}, ${WORKER_SIGNATURE_DEFAULTS.trailer}
        FROM (VALUES
          ('w-heavy', ${APP}, 'agent-1903', 'Heavy', 'heavy'),
          ('w-quiet', ${APP}, 'agent-1903', 'Quiet', 'quiet'),
          ('w-mixed', ${APP}, 'agent-1903', 'Mixed', 'mixed'),
          ('w-ended', ${APP}, 'agent-1903', 'Ended', 'ended'),
          ('w-other', 'app-elsewhere', 'agent-1903', 'Other', 'other')) AS w(id, app_id, agent_id, name, slug)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO sessions (id, worker_id, type, started_at, updated_at, ended_at, auto_expired_at, deleted_at, family) VALUES
          ('sess-heavy',   'w-heavy', 'DEVELOPER', '2026-08-31 00:00:00', '2026-08-31 00:00:00', NULL, NULL, NULL, 'claude'),
          ('sess-quiet',   'w-quiet', 'DEVELOPER', '2026-10-01 00:00:00', '2026-10-01 00:00:00', NULL, NULL, NULL, NULL),
          ('sess-mixed-a', 'w-mixed', 'DEVELOPER', '2026-10-10 00:00:00', '2026-10-10 00:00:00', NULL, NULL, NULL, 'codex'),
          ('sess-mixed-b', 'w-mixed', 'AUTOMATION', '2026-10-12 00:00:00', '2026-10-14 11:00:00', NULL, '2026-10-14 11:00:00', NULL, 'glm'),
          ('sess-mixed-x', 'w-mixed', 'DEVELOPER', '2026-10-14 11:59:00', '2026-10-14 11:59:00', NULL, NULL, '2026-10-14 11:59:30', NULL),
          ('sess-ended',   'w-ended', 'DEVELOPER', '2026-10-13 00:00:00', '2026-10-14 10:00:00', '2026-10-13 06:00:00', NULL, NULL, NULL),
          ('sess-other',   'w-other', 'DEVELOPER', '2026-10-14 11:00:00', '2026-10-14 11:00:00', NULL, NULL, NULL, NULL)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO usage_events (id, type, session_id, counts_as_activity, created_at) VALUES
          ('ue-mixed-a1', 'tool_call', 'sess-mixed-a', true,  '2026-10-14 09:00:00'),
          ('ue-mixed-a2', 'tool_call', 'sess-mixed-a', false, '2026-10-14 11:30:00'),
          ('ue-mixed-b1', 'tool_call', 'sess-mixed-b', true,  '2026-10-13 08:00:00'),
          ('ue-mixed-x1', 'tool_call', 'sess-mixed-x', true,  '2026-10-14 11:59:10'),
          ('ue-ended-1',  'tool_call', 'sess-ended',   true,  '2026-10-13 05:00:00'),
          ('ue-ended-2',  'tool_call', 'sess-ended',   true,  '2026-10-13 09:00:00'),
          ('ue-other-1',  'tool_call', 'sess-other',   true,  '2026-10-14 11:50:00')`);

      const shipped = roster();
      const incident = incidentShape(shipped);
      const read = (sql: Prisma.Sql) =>
        tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT * FROM (${sql}) r ORDER BY r."workerId"`);
      return {
        shippedPlan: await explain(tx, shipped),
        incidentPlan: await explain(tx, incident),
        shipped: await read(shipped),
        incident: await read(incident),
      };
    });

    // Two genuinely different plans were compared...
    expect(result.incidentPlan, withPlan(result.incidentPlan)).toContain(WALK);
    expect(result.shippedPlan, withPlan(result.shippedPlan)).not.toContain(WALK);
    // ...over a fixture that exercises the probe, not an empty roster...
    expect(result.shipped.map((r) => r.workerId)).toEqual(['w-ended', 'w-heavy', 'w-mixed', 'w-quiet']);
    expect(result.shipped.find((r) => r.workerId === 'w-heavy')?.lastActiveAt).toEqual(
      new Date('2026-09-01T05:33:20Z'),
    );
    // ...and the answer is the same, row for row and field for field.
    expect(JSON.stringify(result.shipped)).toBe(JSON.stringify(result.incident));
  });
});
