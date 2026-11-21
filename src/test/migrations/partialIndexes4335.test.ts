/**
 * #4335 (part of #434 Slice C): migration 20260519180903_baseline_init builds `memories_user_id_idx` and
 * `users_external_app_id_external_id_key` PARTIAL (`WHERE (... IS NOT NULL)`), and `prisma db push`, which cannot model
 * an index predicate, builds both full. The uniqueness rule is the same either way (no `NULLS NOT DISTINCT` anywhere, so
 * a full unique never collides on a NULL `external_id`), but the dev and test path (push + post-push.sql) must carry the
 * migration's exact definitions so the catalogs compare equal.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';
import { maintenanceUrl, withDbName } from '../dbWorkers.js';

const INDEXES: Array<[name: string, tail: string]> = [
  ['memories_user_id_idx', 'memories USING btree (user_id) WHERE (user_id IS NOT NULL)'],
  ['users_external_app_id_external_id_key', 'users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)'],
];

describe('#4335 the two partial indexes carry the migration definition on push + post-push', () => {
  it.each(INDEXES)('%s is partial, as the migration builds it', async (name, tail) => {
    const [row] = await db.$queryRaw<Array<{ def: string | null; schema: string }>>`
      SELECT pg_get_indexdef(to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${name}))) AS def,
             current_schema() AS schema`;
    expect(row.def).not.toBeNull();
    expect(row.def!.slice(row.def!.indexOf(' ON '))).toBe(` ON ${row.schema}.${tail}`);
  });
});

const FILE = readFileSync(new URL('../../../prisma/partial-index-invariants.sql', import.meta.url), 'utf8');

/** A throwaway database (dropped WITH (FORCE) in finally) holding the two tables with push's FULL indexes. */
async function withPushOnlyDb(body: (pg: Client) => Promise<void>): Promise<void> {
  const name = `pi4335_${generateId().toLowerCase()}`;
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  let pg: Client | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pg = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
    await pg.connect();
    await pg.query('CREATE TABLE memories (id text PRIMARY KEY, user_id text)');
    await pg.query('CREATE INDEX memories_user_id_idx ON memories (user_id)');
    await pg.query('CREATE TABLE users (id text PRIMARY KEY, external_app_id text, external_id text)');
    await pg.query('CREATE UNIQUE INDEX users_external_app_id_external_id_key ON users (external_app_id, external_id)');
    await body(pg);
  } finally {
    await pg?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const def = async (pg: Client, name: string) =>
  (await pg.query<{ d: string | null; oid: string | null }>('SELECT pg_get_indexdef(to_regclass($1)) AS d, to_regclass($1)::oid::text AS oid', [name])).rows[0];

/** The real file, through the simple-query protocol exactly as written (BEGIN/COMMIT and the DO blocks). */
describe('#4335 prisma/partial-index-invariants.sql from the push-only state', () => {
  it('replaces push\'s full indexes with the partial ones, and a re-run leaves them untouched', async () => {
    await withPushOnlyDb(async (pg) => {
      await pg.query(FILE);
      const memories = await def(pg, 'memories_user_id_idx');
      const users = await def(pg, 'users_external_app_id_external_id_key');
      expect(memories.d).toBe('CREATE INDEX memories_user_id_idx ON public.memories USING btree (user_id) WHERE (user_id IS NOT NULL)');
      expect(users.d).toBe('CREATE UNIQUE INDEX users_external_app_id_external_id_key ON public.users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)');

      await pg.query(FILE);
      expect((await def(pg, 'memories_user_id_idx')).oid).toBe(memories.oid);
      expect((await def(pg, 'users_external_app_id_external_id_key')).oid).toBe(users.oid);
    });
  }, 60_000);

  it('refuses, changing nothing, when a foreign key depends on push\'s full unique index', async () => {
    await withPushOnlyDb(async (pg) => {
      await pg.query('CREATE TABLE pin4335_ref (a text, e text, FOREIGN KEY (a, e) REFERENCES users (external_app_id, external_id))');
      const memoriesBefore = await def(pg, 'memories_user_id_idx');
      await expect(pg.query(FILE)).rejects.toThrow(/depend/);
      await pg.query('ROLLBACK');
      // The memories block ran first and would have replaced its index; the refusal rolled it back.
      expect(await def(pg, 'memories_user_id_idx')).toEqual(memoriesBefore);
    });
  }, 60_000);
});
