/** #4540: upgrade populated, migrationless pre-edge-first-class databases without resetting them. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { generateId } from '../../lib/id.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';

const prisma = fileURLToPath(new URL('../../../prisma/', import.meta.url));
const migration = readFileSync(resolve(prisma, 'migrations/20260620120000_edge_first_class/migration.sql'), 'utf8');

/** Execute the shipped pre-push entry point, including its relative includes, in the private schema. */
function expandedSql(file: string): string {
  return readFileSync(file, 'utf8').replace(/^\\ir (\S+)\s*$/gm, (_, child: string) => expandedSql(resolve(dirname(file), child)));
}

async function scratch(fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const schema = `edge4540_${generateId().replaceAll('-', '')}`;
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
const shape = async (c: pg.Client) => (await c.query(`
  SELECT column_name, is_nullable FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'edges'
     AND column_name IN ('memory_id', 'loc') ORDER BY column_name`)).rows;
const image = async (c: pg.Client) => (await c.query('SELECT to_jsonb(e) AS row FROM edges e ORDER BY id')).rows;

async function legacy(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE nodes (id text PRIMARY KEY, memory_id text NOT NULL, loc text NOT NULL);
    INSERT INTO nodes VALUES ('s1', 'source-memory', 'from:root'), ('s2', 'other-memory', 'from:root'),
      ('t', 'target-memory', 'to:leaf');
    CREATE TABLE edges (id text PRIMARY KEY, source_id text NOT NULL, target_id text NOT NULL,
      label text NOT NULL, data jsonb NOT NULL DEFAULT '{}');
    CREATE UNIQUE INDEX edges_source_id_target_id_label_key ON edges(source_id, target_id, label);
  `);
}

describe('#4540 edge-first-class pre-push transition', () => {
  it('fills required columns on populated legacy edges, preserves names/data and uses the SOURCE memory', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await c.query(`INSERT INTO edges VALUES ('e1', 's1', 't', 'depends on', '{"kept":42}')`);
      await prePush(c);
      expect(await shape(c), 'pre-push must prepare the required columns before db push').toEqual([
        { column_name: 'loc', is_nullable: 'NO' }, { column_name: 'memory_id', is_nullable: 'NO' },
      ]);
      expect((await c.query('SELECT * FROM edges')).rows).toEqual([
        { id: 'e1', source_id: 's1', target_id: 't', name: 'depends on', data: { kept: 42 },
          memory_id: 'source-memory', loc: deriveEdgeLoc('from:root', 'depends on', 'to:leaf') },
      ]);
    });
  });

  it('keeps SQL loc derivation in parity with TypeScript, including trim, fallback, cap and Unicode', async () => {
    await scratch(async (c) => {
      await legacy(c);
      const names = ['depends-on', 'has space', 'a:b', '!leading_', '', '!!!', 'éclair', 'a😀b',
        'a'.repeat(63) + '-tail', 'x'.repeat(80)];
      for (const [i, name] of names.entries()) {
        // Different source locs isolate sanitizer parity from collision suffixing.
        await c.query('INSERT INTO nodes VALUES ($1, $2, $3)', [`n${i}`, 'source-memory', `src:${i}`]);
        await c.query('INSERT INTO edges(id, source_id, target_id, label) VALUES ($1,$2,$3,$4)', [`e${i}`, `n${i}`, 't', name]);
      }
      await prePush(c);
      expect(await shape(c)).toHaveLength(2);
      for (const [i, name] of names.entries()) {
        expect((await c.query('SELECT loc FROM edges WHERE id=$1', [`e${i}`])).rows[0]?.loc, `name ${JSON.stringify(name)}`)
          .toBe(deriveEdgeLoc(`src:${i}`, name, 'to:leaf'));
      }
    });
  });

  it('disambiguates sanitized collisions by id within each SOURCE memory, as the migration does', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await c.query(`INSERT INTO edges(id,source_id,target_id,label) VALUES
        ('b','s1','t','has:space'), ('a','s1','t','has space'), ('c','s2','t','has space')`);
      await prePush(c);
      expect(await shape(c)).toHaveLength(2);
      expect((await c.query('SELECT id, memory_id, loc FROM edges ORDER BY id')).rows).toEqual([
        { id: 'a', memory_id: 'source-memory', loc: 'from:root:has-space:to:leaf' },
        { id: 'b', memory_id: 'source-memory', loc: 'from:root:has-space:to:leaf:2' },
        { id: 'c', memory_id: 'other-memory', loc: 'from:root:has-space:to:leaf' },
      ]);
    });
  });

  it('is a no-op on a second run, preserving a person-authored loc/name and row metadata', async () => {
    await scratch(async (c) => {
      await legacy(c);
      await c.query("INSERT INTO edges(id,source_id,target_id,label) VALUES ('e','s1','t','rel')");
      await prePush(c);
      expect(await shape(c)).toHaveLength(2);
      await c.query("UPDATE edges SET loc='person:authored', name='Edited', data='{\"edited\":true}'");
      const before = await image(c);
      await prePush(c);
      expect(await image(c)).toEqual(before);
    });
  });

  it('is a no-op on already-migrated edges even when an authored loc differs from its derivation', async () => {
    await scratch(async (c) => {
      await c.query(`CREATE TABLE edges(id text PRIMARY KEY, memory_id text NOT NULL, loc text NOT NULL, name text);
        INSERT INTO edges VALUES ('e','m','person:authored','Edited')`);
      const before = await image(c);
      await prePush(c);
      expect(await image(c)).toEqual(before);
      expect(await shape(c)).toEqual([
        { column_name: 'loc', is_nullable: 'NO' }, { column_name: 'memory_id', is_nullable: 'NO' },
      ]);
    });
  });

  it('is a no-op on an empty database, leaving the test-template path free to push its schema', async () => {
    await scratch(async (c) => {
      await prePush(c);
      expect((await c.query("SELECT to_regclass('edges')::text AS edges")).rows).toEqual([{ edges: null }]);
    });
  });

  it('carries the historical memory and loc backfill statements verbatim', () => {
    const sql = expandedSql(resolve(prisma, 'pre-push.sql'));
    const memoryBackfill = migration.match(/UPDATE "edges" e[\s\S]*?ALTER TABLE "edges" ALTER COLUMN "memory_id" SET NOT NULL;/)?.[0];
    const locBackfill = migration.match(/WITH derived AS \([\s\S]*?ALTER TABLE "edges" ALTER COLUMN "loc" SET NOT NULL;/)?.[0];
    expect(memoryBackfill).toBeTruthy();
    expect(locBackfill).toBeTruthy();
    expect(sql).toContain(memoryBackfill);
    expect(sql).toContain(locBackfill);
  });
});
