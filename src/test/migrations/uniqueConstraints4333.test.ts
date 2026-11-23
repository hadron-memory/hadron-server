/**
 * #4333 (part of #434 Slice C): the migrations create six UNIQUE **constraints** (inline `UNIQUE` columns and a table
 * `UNIQUE(...)`), and `prisma db push` creates only a same-name unique **index**. Uniqueness and foreign-key targets work
 * on either form, but `ON CONFLICT ON CONSTRAINT <name>` needs a named constraint and the catalog differs from
 * production's, so the dev and test path (push + post-push.sql) carries the constraint form too, under the migration's
 * names (#4638 BLIND F3).
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';
import { maintenanceUrl, withDbName } from '../dbWorkers.js';
import { cleanDb } from '../helpers.js';

const CONSTRAINTS: Array<[table: string, name: string, columns: string]> = [
  ['lead_cadence_episodes', 'lead_cadence_episodes_event_id_key', 'UNIQUE (event_id)'],
  ['dark_worker_episodes', 'dark_worker_episodes_event_id_key', 'UNIQUE (event_id)'],
  ['host_sweep_episodes', 'host_sweep_episodes_event_id_key', 'UNIQUE (event_id)'],
  ['post_limit_episodes', 'post_limit_episodes_event_id_key', 'UNIQUE (event_id)'],
  ['start_failing_episodes', 'start_failing_episodes_event_id_key', 'UNIQUE (event_id)'],
  ['rate_limit_buckets', 'rate_limit_buckets_field_class_dimension_subject_window_sta_key', 'UNIQUE (field_class, dimension, subject, window_start)'],
];

describe('#4333 the six migration UNIQUE constraints exist on push + post-push', () => {
  it.each(CONSTRAINTS)('%s carries %s as a UNIQUE constraint', async (table, name, columns) => {
    const rows = await db.$queryRaw<Array<{ contype: string; def: string; index_name: string }>>`
      SELECT c.contype::text AS contype, pg_get_constraintdef(c.oid) AS def, i.relname AS index_name
      FROM pg_constraint c JOIN pg_class i ON i.oid = c.conindid
      WHERE c.conname = ${name}
        AND c.conrelid = to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${table}))`;
    expect(rows).toEqual([{ contype: 'u', def: columns, index_name: name }]);
  });

  it('ON CONFLICT ON CONSTRAINT resolves against the rate-limit bucket key', async () => {
    await cleanDb(db);
    const upsert = () => db.$executeRaw`
      INSERT INTO rate_limit_buckets (id, field_class, dimension, subject, window_start, used, expires_at)
      VALUES (${`b4333_${Math.random()}`}, 'pin4333', 'principal', 's', '2026-01-01T00:00:00Z', 1, now())
      ON CONFLICT ON CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key
      DO UPDATE SET used = rate_limit_buckets.used + 1`;
    await upsert();
    await upsert();
    const [row] = await db.$queryRaw<Array<{ used: bigint }>>`SELECT used FROM rate_limit_buckets WHERE field_class = 'pin4333'`;
    expect(Number(row.used)).toBe(2);
  });
});

const FILE = readFileSync(new URL('../../../prisma/unique-constraint-invariants.sql', import.meta.url), 'utf8');
const cols = (name: string) => CONSTRAINTS.find((c) => c[1] === name)![2].replace(/^UNIQUE /, '');

/**
 * #4638 BLIND delta F2: every schema change runs in a throwaway database (created here, dropped WITH (FORCE) in finally,
 * whatever failed), never the worker database. It holds only the six tables, each as `db push` leaves it: the columns
 * and a same-name unique index, no constraint. `indexes` overrides one table's index definition (the columns part).
 */
async function withPushOnlyDb(indexes: Record<string, string>, body: (pg: Client) => Promise<void>): Promise<void> {
  const name = `uc4333_${generateId().toLowerCase()}`;
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  let pg: Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pg = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
    await pg.connect();
    for (const [table, index] of CONSTRAINTS) {
      await pg.query(table === 'rate_limit_buckets'
        ? `CREATE TABLE ${table} (id text PRIMARY KEY, field_class text NOT NULL, dimension text NOT NULL, subject text NOT NULL, window_start timestamp(3) NOT NULL)`
        : `CREATE TABLE ${table} (id text PRIMARY KEY, event_id text NOT NULL)`);
      await pg.query(`CREATE UNIQUE INDEX ${index} ON ${table} ${indexes[index] ?? cols(index)}`);
    }
    await body(pg);
  } finally {
    await pg?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const indexOid = async (pg: Client, name: string) => (await pg.query<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [name])).rows[0].oid;
const uniqueConstraints = async (pg: Client) =>
  Number((await pg.query<{ n: string }>(`SELECT count(*) AS n FROM pg_constraint WHERE contype = 'u' AND conname = ANY($1)`, [CONSTRAINTS.map((c) => c[1])])).rows[0].n);

/** The real file, through the simple-query protocol exactly as written (BEGIN/COMMIT and the DO blocks). */
describe('#4333 prisma/unique-constraint-invariants.sql from the push-only state', () => {
  it('promotes each index in place, and a re-run with a dependent foreign key changes nothing (#4638 BLIND F1, F2)', async () => {
    await withPushOnlyDb({}, async (pg) => {
      const before = await indexOid(pg, 'lead_cadence_episodes_event_id_key');
      await pg.query(FILE);
      expect(await uniqueConstraints(pg)).toBe(CONSTRAINTS.length);
      expect(await indexOid(pg, 'lead_cadence_episodes_event_id_key')).toBe(before);

      await pg.query('CREATE TABLE pin4333_ref (event_id text REFERENCES lead_cadence_episodes (event_id))');
      await pg.query(FILE);
      expect(await uniqueConstraints(pg)).toBe(CONSTRAINTS.length);
      expect(await indexOid(pg, 'lead_cadence_episodes_event_id_key')).toBe(before);
      expect((await pg.query(`SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'pin4333_ref'::regclass`)).rowCount).toBe(1);
    });
  }, 60_000);

  it('refuses a same-name constraint with another definition, changing nothing (#4638 LOCAL delta F2)', async () => {
    await withPushOnlyDb({}, async (pg) => {
      await pg.query('DROP INDEX start_failing_episodes_event_id_key');
      await pg.query('ALTER TABLE start_failing_episodes ADD CONSTRAINT start_failing_episodes_event_id_key UNIQUE (id, event_id)');
      const first = await indexOid(pg, 'lead_cadence_episodes_event_id_key');
      await expect(pg.query(FILE)).rejects.toThrow(/start_failing_episodes\.start_failing_episodes_event_id_key exists as UNIQUE \(id, event_id\), not UNIQUE \(event_id\)/);
      await pg.query('ROLLBACK');
      expect(await indexOid(pg, 'lead_cadence_episodes_event_id_key')).toBe(first);
      expect(await uniqueConstraints(pg)).toBe(1);
    });
  }, 60_000);

  it.each([
    ['other columns', 'rate_limit_buckets_field_class_dimension_subject_window_sta_key', '(id, field_class)'],
    ['NULLS NOT DISTINCT', 'host_sweep_episodes_event_id_key', '(event_id) NULLS NOT DISTINCT'],
    ['a DESC column', 'post_limit_episodes_event_id_key', '(event_id DESC)'],
    ['a predicate', 'dark_worker_episodes_event_id_key', '(event_id) WHERE event_id <> \'\''],
  ])('refuses an index with %s and rolls back every earlier promotion (#4638 BLIND delta F1, F3)', async (_label, name, definition) => {
    await withPushOnlyDb({ [name]: definition }, async (pg) => {
      // The FIRST block's index is eligible: it would be promoted before the refusing block runs.
      const first = await indexOid(pg, 'lead_cadence_episodes_event_id_key');
      await expect(pg.query(FILE)).rejects.toThrow(new RegExp(`index ${name} is not the plain unique index`));
      await pg.query('ROLLBACK');
      expect(await indexOid(pg, 'lead_cadence_episodes_event_id_key')).toBe(first);
      expect(await uniqueConstraints(pg)).toBe(0);
    });
  }, 60_000);
});
