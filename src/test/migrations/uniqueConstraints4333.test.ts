/**
 * #4333 (part of #434 Slice C): the migrations create six UNIQUE **constraints** (inline `UNIQUE` columns and a table
 * `UNIQUE(...)`), and `prisma db push` creates only a same-name unique **index**. `ON CONFLICT ON CONSTRAINT` and
 * foreign-key targets behave differently between the two forms, so the dev and test path (push + post-push.sql) must
 * carry the constraint form too, under the migration's names.
 */
import { readFileSync } from 'node:fs';
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

  it('re-applying the invariants file is a no-op (a second db:dev-setup)', async () => {
    const sql = readFileSync(new URL('../../../prisma/unique-constraint-invariants.sql', import.meta.url), 'utf8');
    const statements = sql.split('\n').filter((l) => l && !l.startsWith('--') && l !== 'BEGIN;' && l !== 'COMMIT;');
    expect(statements).toHaveLength(CONSTRAINTS.length * 3);
    for (let run = 0; run < 2; run++) {
      await db.$transaction(async (tx) => {
        for (const st of statements) await tx.$executeRawUnsafe(st);
      });
    }
    const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint WHERE contype = 'u' AND conname = ANY(${CONSTRAINTS.map((c) => c[1])})`;
    expect(Number(n)).toBe(CONSTRAINTS.length);
  });
});
