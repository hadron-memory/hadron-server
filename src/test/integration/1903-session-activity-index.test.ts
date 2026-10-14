/**
 * #1903 — the session-activity index that production went down without.
 *
 * On 2026-10-14 the roster liveness fold (`workerActivitySql`) probed
 * usage_events once per session for max(created_at) of its activity events.
 * The planner served that max by walking usage_events_created_at_idx
 * BACKWARDS, which for a session with no (or ancient) activity rows meant the
 * whole 10.7M-row index; 12+ minutes per roster read exhausted the pool
 * (ops:alpha:incident-2026-10-14-pool-exhaustion-liveness-query). The fix is
 * the partial index below, which Prisma can't model: it lives in
 * post-push.sql and migration 20261014020000.
 *
 * Pinned here: the index exists with its exact shape, and the liveness query
 * PLANS onto it. The plan pin disables sequential and bitmap scans so a tiny
 * test table can't make the planner's choice moot; within index paths the
 * question is exactly the incident's — this index, or a walk of another one.
 */

import { describe, it, expect } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { workerActivitySql } from '../../api/graphql/schema/resolvers.worker.js';

const INDEX = 'usage_events_session_activity_idx';

/** The text plan of the roster liveness query, with the given setup run first. */
async function livenessPlan(setup: string[] = []): Promise<string> {
  const sql = workerActivitySql(Prisma.sql`w.app_id = ${'app-1903'}`, new Date());
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      for (const stmt of setup) await tx.$executeRawUnsafe(stmt);
      const rows = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>(Prisma.sql`EXPLAIN ${sql}`);
      // Always roll back, so a setup that drops the index never escapes.
      throw new PlanResult(rows.map((r) => r['QUERY PLAN']).join('\n'));
    });
  } catch (e) {
    if (e instanceof PlanResult) return e.plan;
    throw e;
  }
  throw new Error('unreachable');
}

class PlanResult extends Error {
  constructor(readonly plan: string) {
    super('plan captured');
  }
}

describe('#1903 usage_events_session_activity_idx', () => {
  it('exists, partial on counts_as_activity, over (session_id, created_at)', async () => {
    const rows = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'usage_events' AND indexname = ${INDEX}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(session_id, created_at\) WHERE counts_as_activity$/);
  });

  it('serves the roster liveness probe, never a walk of the created_at index', async () => {
    const plan = await livenessPlan();
    expect(plan).toContain(INDEX);
    expect(plan).not.toContain('usage_events_created_at_idx');
  });

  it('the plan pin is not vacuous: without the index the probe plans elsewhere', async () => {
    const plan = await livenessPlan([`DROP INDEX ${INDEX}`]);
    expect(plan).not.toContain(INDEX);
    expect(plan).toMatch(/usage_events_\w+_idx/);
  });
});
