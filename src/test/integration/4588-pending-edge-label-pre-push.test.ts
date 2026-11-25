/** #4588: a non-wiping schema push must not drop the labels of a legacy `pending_edges` table. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { generateId } from '../../lib/id.js';

const prisma = fileURLToPath(new URL('../../../prisma/', import.meta.url));

/** Execute the shipped pre-push entry point, including its relative includes, in the private schema. */
function expandedSql(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\\ir (\S+)\s*$/gm, (_, child: string) => expandedSql(resolve(dirname(file), child)));
}

async function scratch(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const schema = `pending4588_${generateId().replaceAll('-', '')}`;
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`SET LOCAL search_path TO "${schema}"`);
    await c.query("SET LOCAL statement_timeout = '10s'");
    await fn(c);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
}

const prePush = (c: pg.Client) => c.query(expandedSql(resolve(prisma, 'pre-push.sql')));
const columns = async (c: pg.Client) => (await c.query(`
  SELECT column_name FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'pending_edges'
   ORDER BY column_name`)).rows.map((r) => r.column_name as string);
const image = async (c: pg.Client) => (await c.query('SELECT to_jsonb(p) AS row FROM pending_edges p ORDER BY id')).rows;

/** `pending_edges` as the baseline migration created it, before 20260620120000_edge_first_class. */
async function legacy(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE pending_edges (id text PRIMARY KEY, source_id text NOT NULL, target_id text NOT NULL, label text);
    CREATE UNIQUE INDEX pending_edges_source_id_target_id_key ON pending_edges(source_id, target_id);
    INSERT INTO pending_edges VALUES ('p1', 's', 't1', 'depends on'), ('p2', 's', 't2', NULL), ('p3', 's', 't3', '');
  `);
}

const preserved = [
  { id: 'p1', source_id: 's', target_id: 't1', name: 'depends on' },
  { id: 'p2', source_id: 's', target_id: 't2', name: null },
  { id: 'p3', source_id: 's', target_id: 't3', name: '' },
];

describe('#4588 pending-edge label pre-push transition', () => {
  it('renames label to name on a populated legacy table, keeping every value', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await prePush(c);
      expect(await columns(c), 'db push would drop `label` unless pre-push renames it').toEqual(['id', 'name', 'source_id', 'target_id']);
      expect((await c.query('SELECT * FROM pending_edges ORDER BY id')).rows).toEqual(preserved);
    });
  });

  it('transitions pending_edges even when edges is already upgraded', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await c.query('CREATE TABLE edges (id text PRIMARY KEY, memory_id text NOT NULL, loc text NOT NULL, name text)');
      await prePush(c);
      expect((await c.query('SELECT * FROM pending_edges ORDER BY id')).rows).toEqual(preserved);
    });
  });

  it('is a no-op on a second run, keeping a name edited after the upgrade', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await prePush(c);
      await c.query("UPDATE pending_edges SET name = 'edited' WHERE id = 'p1'");
      const before = await image(c);
      await prePush(c);
      expect(await image(c)).toEqual(before);
    });
  });

  it('is a no-op on an already-upgraded table', async () => {
    await scratch(async (c) => {
      await c.query(`CREATE TABLE pending_edges (id text PRIMARY KEY, source_id text, target_id text, loc text, name text);
        INSERT INTO pending_edges VALUES ('p', 's', 't', 'person:authored', 'Edited')`);
      const before = await image(c);
      await prePush(c);
      expect(await image(c)).toEqual(before);
      expect(await columns(c)).toEqual(['id', 'loc', 'name', 'source_id', 'target_id']);
    });
  });

  it('leaves a table that has both columns untouched instead of failing the setup run', async () => {
    await scratch(async (c) => {
      await c.query(`CREATE TABLE pending_edges (id text PRIMARY KEY, label text, name text);
        INSERT INTO pending_edges VALUES ('p', 'old', 'current')`);
      const before = await image(c);
      await prePush(c);
      expect(await image(c)).toEqual(before);
    });
  });

  it('looks only at the current schema', async () => {
    await scratch(async (c) => {
      // Another schema's table carries `name`; it must not stop this schema's legacy table being renamed.
      const own = (await c.query('SELECT current_schema() AS s')).rows[0].s as string;
      await c.query(`CREATE SCHEMA "${own}_other"; CREATE TABLE "${own}_other".pending_edges (id text, name text)`);
      await legacy(c);
      await prePush(c);
      expect((await c.query('SELECT * FROM pending_edges ORDER BY id')).rows).toEqual(preserved);
    });
  });

  it('is a no-op on a fresh database, leaving db push to create the table', async () => {
    await scratch(async (c) => {
      await prePush(c);
      expect((await c.query("SELECT to_regclass('pending_edges')::text AS t")).rows).toEqual([{ t: null }]);
    });
  });
});
