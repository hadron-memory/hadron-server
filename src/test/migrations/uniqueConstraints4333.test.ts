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
import { cleanDb } from '../helpers.js';

const CONSTRAINTS: Array<[table: string, name: string, columns: string]> = [
  ['coordinator_cadence_episodes', 'coordinator_cadence_episodes_event_id_key', 'UNIQUE (event_id)'],
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

  /**
   * #4638 BLIND F2: the real file, through the simple-query protocol exactly as written (BEGIN/COMMIT and the DO blocks),
   * from the push-only state: promoted in place on the first run (the index's OID is kept), then left untouched on a
   * re-run (same OID), with a foreign key that depends on the backing index surviving the re-run.
   */
  it('promotes push\'s index in place, and a re-run with a dependent foreign key changes nothing', async () => {
    const file = readFileSync(new URL('../../../prisma/unique-constraint-invariants.sql', import.meta.url), 'utf8');
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const indexOid = async (name: string) =>
      (await pg.query<{ oid: string }>(`SELECT to_regclass(quote_ident(current_schema()) || '.' || quote_ident($1))::oid::text AS oid`, [name])).rows[0].oid;
    const constraints = async () =>
      Number((await pg.query<{ n: string }>(`SELECT count(*) AS n FROM pg_constraint WHERE contype = 'u' AND conname = ANY($1)`, [CONSTRAINTS.map((c) => c[1])])).rows[0].n);
    try {
      // Back to what db push leaves: a same-name unique index and no constraint.
      for (const [table, name] of CONSTRAINTS) {
        const cols = (CONSTRAINTS.find((c) => c[1] === name)![2]).replace(/^UNIQUE /, '');
        await pg.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
        await pg.query(`CREATE UNIQUE INDEX ${name} ON ${table} ${cols}`);
      }
      expect(await constraints()).toBe(0);
      const pushIndex = await indexOid('coordinator_cadence_episodes_event_id_key');

      await pg.query(file);
      expect(await constraints()).toBe(CONSTRAINTS.length);
      expect(await indexOid('coordinator_cadence_episodes_event_id_key')).toBe(pushIndex);

      await pg.query('CREATE TABLE pin4333_ref (event_id text REFERENCES coordinator_cadence_episodes (event_id))');
      await pg.query(file);
      expect(await constraints()).toBe(CONSTRAINTS.length);
      expect(await indexOid('coordinator_cadence_episodes_event_id_key')).toBe(pushIndex);
      const fk = await pg.query(`SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid = 'pin4333_ref'::regclass`);
      expect(fk.rowCount).toBe(1);
    } finally {
      await pg.query('DROP TABLE IF EXISTS pin4333_ref');
      await pg.end();
    }
  });

  it('refuses, changing nothing, when a same-name index is on other columns', async () => {
    const file = readFileSync(new URL('../../../prisma/unique-constraint-invariants.sql', import.meta.url), 'utf8');
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query('ALTER TABLE rate_limit_buckets DROP CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key');
      await pg.query('CREATE UNIQUE INDEX rate_limit_buckets_field_class_dimension_subject_window_sta_key ON rate_limit_buckets (id, field_class)');
      await expect(pg.query(file)).rejects.toThrow(/not a plain unique index on \(field_class, dimension, subject, window_start\)/);
      await pg.query('ROLLBACK');
    } finally {
      await pg.query('DROP INDEX IF EXISTS rate_limit_buckets_field_class_dimension_subject_window_sta_key');
      await pg.query('ALTER TABLE rate_limit_buckets ADD CONSTRAINT rate_limit_buckets_field_class_dimension_subject_window_sta_key UNIQUE (field_class, dimension, subject, window_start)');
      await pg.end();
    }
  });
});
