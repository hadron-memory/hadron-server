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

/** The full definitions, uniqueness included (#4672 BLIND F3), with `<s>` for the schema. */
const INDEXES: Array<[name: string, definition: string]> = [
  ['memories_user_id_idx', 'CREATE INDEX memories_user_id_idx ON <s>.memories USING btree (user_id) WHERE (user_id IS NOT NULL)'],
  ['users_external_app_id_external_id_key',
    'CREATE UNIQUE INDEX users_external_app_id_external_id_key ON <s>.users USING btree (external_app_id, external_id) WHERE (external_id IS NOT NULL)'],
];

describe('#4335 the two partial indexes carry the migration definition on push + post-push', () => {
  it.each(INDEXES)('%s is exactly the migration definition', async (name, definition) => {
    const [row] = await db.$queryRaw<Array<{ def: string | null; schema: string }>>`
      SELECT pg_get_indexdef(to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${name}))) AS def,
             current_schema() AS schema`;
    expect(row.def).toBe(definition.replace('<s>', row.schema));
  });
});

const FILE = readFileSync(new URL('../../../prisma/partial-index-invariants.sql', import.meta.url), 'utf8');

/**
 * A throwaway database holding a hand-built approximation of a database `db push` built from the old schema: the two
 * tables with their FULL same-name indexes (#4672 BLIND F5). `setup` may change that state before the body runs. The
 * database is dropped WITH (FORCE) whatever failed, and the admin client is closed even if the drop fails; a cleanup
 * error never hides the test's own failure (#4672 BLIND F4).
 */
async function withLegacyFullIndexes(body: (pg: Client) => Promise<void>): Promise<void> {
  const name = `pi4335_${generateId().toLowerCase()}`;
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  let pg: Client | undefined;
  let failure: unknown;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pg = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
    await pg.connect();
    await pg.query('CREATE TABLE memories (id text PRIMARY KEY, user_id text)');
    await pg.query('CREATE INDEX memories_user_id_idx ON memories (user_id)');
    await pg.query('CREATE TABLE users (id text PRIMARY KEY, external_app_id text, external_id text)');
    await pg.query('CREATE UNIQUE INDEX users_external_app_id_external_id_key ON users (external_app_id, external_id)');
    await body(pg);
  } catch (e) {
    failure = e;
  } finally {
    await pg?.end().catch(() => undefined);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch (e) {
      if (failure === undefined) failure = e;
    } finally {
      await admin.end().catch(() => undefined);
    }
  }
  if (failure !== undefined) throw failure;
}

const state = async (pg: Client, name: string) =>
  (await pg.query<{ d: string | null; oid: string | null; valid: boolean | null }>(
    `SELECT pg_get_indexdef(to_regclass($1)) AS d, to_regclass($1)::oid::text AS oid,
            (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)) AS valid`, [name])).rows[0];
const PARTIAL = (name: string) => INDEXES.find((i) => i[0] === name)![1].replace('<s>', 'public');

/** The real file, through the simple-query protocol exactly as written (BEGIN/COMMIT and the DO blocks). */
describe('#4335 prisma/partial-index-invariants.sql', () => {
  it('replaces push\'s full indexes with the partial ones, and a re-run leaves them untouched', async () => {
    await withLegacyFullIndexes(async (pg) => {
      await pg.query(FILE);
      const memories = await state(pg, 'memories_user_id_idx');
      const users = await state(pg, 'users_external_app_id_external_id_key');
      expect(memories.d).toBe(PARTIAL('memories_user_id_idx'));
      expect(users.d).toBe(PARTIAL('users_external_app_id_external_id_key'));

      await pg.query(FILE);
      expect((await state(pg, 'memories_user_id_idx')).oid).toBe(memories.oid);
      expect((await state(pg, 'users_external_app_id_external_id_key')).oid).toBe(users.oid);
    });
  }, 60_000);

  it('repairs an invalid index that has the migration definition (a failed concurrent build) (#4672 BLIND F1)', async () => {
    await withLegacyFullIndexes(async (pg) => {
      await pg.query('DROP INDEX users_external_app_id_external_id_key');
      await pg.query(`INSERT INTO users VALUES ('u1', 'app', 'e1'), ('u2', 'app', 'e1')`);
      await expect(pg.query(
        'CREATE UNIQUE INDEX CONCURRENTLY users_external_app_id_external_id_key ON users (external_app_id, external_id) WHERE (external_id IS NOT NULL)',
      )).rejects.toThrow(/could not create unique index/);
      const broken = await state(pg, 'users_external_app_id_external_id_key');
      expect(broken).toMatchObject({ d: PARTIAL('users_external_app_id_external_id_key'), valid: false });
      await pg.query(`DELETE FROM users WHERE id = 'u2'`);

      await pg.query(FILE);
      const repaired = await state(pg, 'users_external_app_id_external_id_key');
      expect(repaired).toMatchObject({ d: PARTIAL('users_external_app_id_external_id_key'), valid: true });
      expect(repaired.oid).not.toBe(broken.oid);
    });
  }, 60_000);

  it.each([
    ['an index of the same name on another table', 'DROP INDEX memories_user_id_idx; CREATE INDEX memories_user_id_idx ON users (external_id)', /is on users, not memories/],
    ['an unrecognised definition (a standalone unique)', 'DROP INDEX memories_user_id_idx; CREATE UNIQUE INDEX memories_user_id_idx ON memories (user_id)', /neither the migration's partial form nor push's full form/],
    ['a foreign key on push\'s full unique', 'CREATE TABLE pin4335_ref (a text, e text, FOREIGN KEY (a, e) REFERENCES users (external_app_id, external_id))', /depend/],
  ])('refuses, changing nothing, for %s (#4672 BLIND F2)', async (_label, setup, refusal) => {
    await withLegacyFullIndexes(async (pg) => {
      await pg.query(setup);
      const before = [await state(pg, 'memories_user_id_idx'), await state(pg, 'users_external_app_id_external_id_key')];
      await expect(pg.query(FILE)).rejects.toThrow(refusal);
      await pg.query('ROLLBACK');
      expect([await state(pg, 'memories_user_id_idx'), await state(pg, 'users_external_app_id_external_id_key')]).toEqual(before);
    });
  }, 60_000);
});
