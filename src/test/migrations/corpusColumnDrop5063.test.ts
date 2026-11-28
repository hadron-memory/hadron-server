/**
 * #5063 PR 2 (the contract half of the #1613 remainder): the three legacy memory corpus columns
 * `corpus_draft`, `corpus_minted_at` and `corpus_minted_by` are physically gone, and nothing else is.
 *
 * PR 1 (#5085, 9cf95ca2, deploy-verified in 8e01d932) re-keyed every reader off them and stopped every
 * writer: corpus state is derived per node (hrn:node:hadronmemory.com:specs:cor:dmo:120:00, :08, :09).
 * This file follows the #3695 shape (src/test/migrations/s7ColumnDrop3695.test.ts):
 *
 * - D1: a database built from empty has none of the three columns and keeps its neighbours.
 * - D1b: the generated Prisma client no longer selects them (a stale scalar is a P2022 on every
 *   Memory read), which is also what makes tsc prove no non-test reader is left.
 * - D2: the migration, replayed on a populated PR 1 shape (a draft memory, a stamped memory, a plain
 *   one), drops exactly the three columns and changes no other value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Prisma } from '../../generated/prisma/index.js';
import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { generateId } from '../../lib/id.js';

const MIGRATION = '20261125030000_drop_memory_corpus_columns';
const migrationPath = new URL(`../../../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url);
const historical = (name: string) => readFileSync(new URL(`../../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
const statements = (sql: string) => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);

const DROPPED = ['corpus_draft', 'corpus_minted_at', 'corpus_minted_by'] as const;

const columnsOf = async (table: string) =>
  (await db.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`)
    .map(r => r.column_name);

describe('#5063 PR 2: the legacy memory corpus columns are dropped', () => {
  it('D1: a database built from empty has none of the three columns and keeps its neighbours', async () => {
    const memories = await columnsOf('memories');
    for (const c of DROPPED) expect(memories, `memories.${c} must be dropped`).not.toContain(c);
    // The columns on either side of the dropped block in schema.prisma stay.
    expect(memories).toEqual(expect.arrayContaining(['id', 'name', 'schema', 'tags', 'updated_at']));
  });

  it('D1b: the generated Prisma client no longer selects them', () => {
    const fields = Prisma.dmmf.datamodel.models.find(m => m.name === 'Memory')!.fields.map(f => f.name);
    for (const f of ['corpusDraft', 'corpusMintedAt', 'corpusMintedBy']) expect(fields, `Memory.${f}`).not.toContain(f);
    expect(fields).toEqual(expect.arrayContaining(['schema', 'tags', 'updatedAt']));
  });

  it('D2: the migration drops exactly the three columns from a populated PR 1 shape and changes no other value', async () => {
    // The historical statements that created the columns really name them (guards the fixture below).
    const created = historical('20260929190000_memory_corpus_draft') + historical('20260929220000_memory_corpus_minted');
    for (const c of DROPPED) expect(created).toContain(c);
    expect(existsSync(migrationPath), `${MIGRATION}/migration.sql must exist`).toBe(true);
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql, 'no tool banner pasted into the migration').not.toMatch(/[─-╿]/);

    await db.$transaction(async tx => {
      const publicMemories = Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM public.memories`)[0]!.n);
      // Same columns and defaults, private to this connection; every NOT NULL but id relaxed so a sparse row can be inserted.
      await tx.$executeRawUnsafe('CREATE TEMP TABLE memories (LIKE public.memories INCLUDING DEFAULTS) ON COMMIT DROP');
      await tx.$executeRawUnsafe(`DO $$ DECLARE c text; BEGIN FOR c IN SELECT attname FROM pg_attribute
        WHERE attrelid = 'pg_temp.memories'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'id'
        LOOP EXECUTE format('ALTER TABLE pg_temp.memories ALTER COLUMN %I DROP NOT NULL', c); END LOOP; END $$`);
      // Rebuild the PR 1 shape whatever the live table looks like (idempotent before the drop, adds them back after).
      await tx.$executeRawUnsafe(`ALTER TABLE pg_temp.memories ADD COLUMN IF NOT EXISTS corpus_draft BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS corpus_minted_at TIMESTAMP(3), ADD COLUMN IF NOT EXISTS corpus_minted_by TEXT`);

      const [draft, stamped, plain] = [generateId(), generateId(), generateId()];
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.memories (id, name, urn, tags, corpus_draft, corpus_minted_at, corpus_minted_by) VALUES
        ('${draft}', 'draft', 'd5063.example:draft', '{a}', true, NULL, NULL),
        ('${stamped}', 'stamped', 'd5063.example:stamped', '{b,c}', false, '2026-06-01', 'github:someone'),
        ('${plain}', 'plain', 'd5063.example:plain', '{}', false, NULL, NULL)`);

      const snap = () => tx.$queryRawUnsafe<unknown[]>(
        `SELECT to_jsonb(t) - 'corpus_draft' - 'corpus_minted_at' - 'corpus_minted_by' AS r FROM pg_temp.memories t ORDER BY id`);
      const before = await snap();
      expect(before).toHaveLength(3);
      for (const statement of statements(sql)) await tx.$executeRawUnsafe(statement);
      expect(await snap()).toEqual(before);

      const gone = await tx.$queryRaw<Array<{ attname: string }>>`
        SELECT attname FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped
          AND attrelid = 'pg_temp.memories'::regclass AND attname IN ('corpus_draft', 'corpus_minted_at', 'corpus_minted_by')`;
      expect(gone).toEqual([]);
      // The statements hit the temp table, never the real one.
      expect(Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM public.memories`)[0]!.n)).toBe(publicMemories);
    });
  });
});
