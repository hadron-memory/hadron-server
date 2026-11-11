/**
 * #3883 (Dorian's LOCAL P2, gate ruling Option A): execute the actual `last_matched_at` migration against legacy rows,
 * not db-push's schema-only surrogate. A NO_WORKER row the old arrival-order guard over-stated cannot be told from a
 * true one (latest-only storage), so the backfill restarts every live streak at its latest failure: the streak is then
 * under-stated, never over-stated, for upgraded rows too (cor:agt:060:13 by decision time).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { recordMatchOutcome } from './matchOutcomes.js';

const migration = readFileSync(
  new URL('../../../prisma/migrations/20261110200000_agent_match_outcomes_last_matched_at/migration.sql', import.meta.url), 'utf8');
let appId: string;

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId();
  const org = await db.organization.create({ data: { name: 'Mig', urn: `mom-${n}.example` } });
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a` } })).id;
});
// The pushed schema already has the column; the test drops it to stand in for the pre-migration table. Restore it
// whatever happens, so a failure here never leaves this worker's database without the column for later files.
afterEach(async () => {
  await db.$executeRawUnsafe('ALTER TABLE agent_match_outcomes ADD COLUMN IF NOT EXISTS last_matched_at TIMESTAMP(6)');
});

/** Run the migration file as Prisma's deploy would: one connection, the whole script. */
async function migrate() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { await c.query(migration); } finally { await c.end(); }
}
// Stamps are `timestamp` (no zone) on the DB clock: compare them as DB literals so the test process's zone can't shift them.
type Row = { outcome: string; decided_at: string; failing_since: string | null; last_matched_at: string | null };
const ts = (c: string) => `to_char(${c}, 'YYYY-MM-DD HH24:MI:SS') AS ${c}`;
const read = async (role: string) => (await db.$queryRawUnsafe<Row[]>(
  `SELECT outcome, ${ts('decided_at')}, ${ts('failing_since')}, ${ts('last_matched_at')} FROM agent_match_outcomes
   WHERE app_id = $1 AND role = $2`,
  appId, role))[0];

it('a legacy over-stated streak restarts at its latest failure, and no later write moves it back past that', async () => {
  await db.$executeRawUnsafe('ALTER TABLE agent_match_outcomes DROP COLUMN last_matched_at');
  // Legacy state the old guard left: F(t1), F(t3), then a success decided at t2 landed last and was dropped whole,
  // so the row claims a streak since t1 although it truly restarted at t3.
  const t1 = '2026-11-10 10:01:00', t3 = '2026-11-10 10:03:00', tm = '2026-11-10 09:59:00';
  await db.$executeRawUnsafe(
    `INSERT INTO agent_match_outcomes (app_id, role, outcome, reason, decided_at, failing_since)
     VALUES ($1, 'x', 'NO_WORKER', 'NOBODY_FREE', $2::timestamp, $3::timestamp), ($1, 'y', 'MATCHED', NULL, $4::timestamp, NULL)`, appId, t3, t1, tm);
  await migrate();
  // The streak restarts at the latest known failure (t3), and that failure is the floor no older failure crosses.
  expect(await read('x')).toEqual({ outcome: 'NO_WORKER', decided_at: t3, failing_since: t3, last_matched_at: t3 });
  // A MATCHED row's own decision is its newest match; it keeps no streak.
  expect(await read('y')).toEqual({ outcome: 'MATCHED', decided_at: tm, failing_since: null, last_matched_at: tm });
  // A new failure in order keeps the restarted start (Dorian's F(t4) leg: it stayed t1 before the fix).
  await recordMatchOutcome(db, appId, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE');
  expect((await read('x')).failing_since).toBe(t3);
  // A late failure decided before the restart (and, in this legacy story, before the unrecorded match) does not move it
  // back (BLIND F6's deploy-window case).
  await recordMatchOutcome(db, appId, { role: 'x' }, 'NO_WORKER', 'NOBODY_FREE', '2026-11-10 10:00:00');
  expect((await read('x')).failing_since).toBe(t3);
});
