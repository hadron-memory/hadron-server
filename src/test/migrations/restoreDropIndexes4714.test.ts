/**
 * #4714 N5 (from #4691's blind review): scripts/restore-db-from-remote.sh drops the two partial indexes by name before
 * dev-setup rebuilds them. A name-only DROP INDEX also drops a same-named index on ANOTHER table. The drop must name
 * the table too. The statements are read out of the script itself and run against a throwaway database, so the pin
 * covers what the script actually runs.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { generateId } from '../../lib/id.js';
import { maintenanceUrl, withDbName } from '../dbWorkers.js';

const SCRIPT = readFileSync(new URL('../../../scripts/restore-db-from-remote.sh', import.meta.url), 'utf8');

/** The `psql -c` statements of the "Dropping the two partial indexes" step, as the script passes them. */
function dropStatements(): string[] {
  const start = SCRIPT.indexOf('Dropping the two partial indexes');
  expect(start, 'the drop step exists in the script').toBeGreaterThan(-1);
  const step = SCRIPT.slice(start, SCRIPT.indexOf('dev-setup.sh', start));
  return [...step.matchAll(/-c\s+(?:"([^"]*)"|'([^']*)')/g)].map((m) => m[1] ?? m[2]!);
}

async function withDb(body: (pg: Client) => Promise<void>): Promise<void> {
  const name = `rd4714_${generateId().toLowerCase()}`;
  const admin = new Client({ connectionString: maintenanceUrl() });
  await admin.connect();
  let pg: Client | undefined;
  let failure: unknown;
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    pg = new Client({ connectionString: withDbName(maintenanceUrl(), name) });
    await pg.connect();
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

const exists = async (pg: Client, name: string) =>
  (await pg.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [name])).rows[0].e as boolean;

describe('#4714 N5 the restore script drops the two partial indexes only on their own tables', () => {
  it('the script has drop statements for both indexes', () => {
    expect(dropStatements().length).toBeGreaterThanOrEqual(1);
    expect(dropStatements().join('\n')).toMatch(/memories_user_id_idx/);
    expect(dropStatements().join('\n')).toMatch(/users_external_app_id_external_id_key/);
  });

  it('CONTROL: drops each index on its own table', async () => {
    await withDb(async (pg) => {
      await pg.query('CREATE TABLE memories (id text PRIMARY KEY, user_id text)');
      await pg.query('CREATE INDEX memories_user_id_idx ON memories (user_id)');
      await pg.query('CREATE TABLE users (id text PRIMARY KEY, external_app_id text, external_id text)');
      await pg.query('CREATE UNIQUE INDEX users_external_app_id_external_id_key ON users (external_app_id, external_id)');
      for (const sql of dropStatements()) await pg.query(sql);
      expect(await exists(pg, 'memories_user_id_idx')).toBe(false);
      expect(await exists(pg, 'users_external_app_id_external_id_key')).toBe(false);
    });
  }, 60_000);

  it('leaves a same-named index on ANOTHER table alone', async () => {
    await withDb(async (pg) => {
      await pg.query('CREATE TABLE memories (id text PRIMARY KEY, user_id text)');
      await pg.query('CREATE TABLE users (id text PRIMARY KEY, external_app_id text, external_id text)');
      await pg.query('CREATE INDEX memories_user_id_idx ON users (external_id)');
      await pg.query('CREATE INDEX users_external_app_id_external_id_key ON memories (user_id)');
      for (const sql of dropStatements()) await pg.query(sql);
      expect(await exists(pg, 'memories_user_id_idx')).toBe(true);
      expect(await exists(pg, 'users_external_app_id_external_id_key')).toBe(true);
    });
  }, 60_000);
});
