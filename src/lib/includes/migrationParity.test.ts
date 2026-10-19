/** #2040 — the lifecycle migration yields exactly the definitions the post-push path built. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(fileURLToPath(new URL('../../../prisma/migrations/20261018230100_include_edges_lifecycle/migration.sql', import.meta.url)), 'utf8');

const DEFS = `
  SELECT 'fn:' || p.proname AS k, pg_get_functiondef(p.oid) AS d FROM pg_proc p
    WHERE p.proname IN ('hadron_edges_governed_immutable', 'hadron_check_comment_node', 'hadron_comment_node_changed', 'hadron_comment_meta_immutable')
  UNION ALL
  SELECT 'tg:' || t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t
    WHERE t.tgname IN ('edges_governed_immutable', 'edges_governed_insert', 'comment_meta_changed')
  UNION ALL
  SELECT 'ck:' || conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'chk_edges_governed_anchor'
  ORDER BY 1`;

describe('migration 20261018230100_include_edges_lifecycle', () => {
  it('leaves a post-push-built database unchanged (same functions, triggers and CHECK)', async () => {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      const before = (await client.query(DEFS)).rows;
      expect(before.length).toBeGreaterThanOrEqual(8);
      await client.query(sql);
      const after = (await client.query(DEFS)).rows;
      expect(after).toEqual(before);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
});
