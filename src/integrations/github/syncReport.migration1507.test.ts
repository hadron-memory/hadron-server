import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db } from '../db/client.js';

it('backfills unknown once while preserving future clean null and never-run null', async () => {
  const schema = `report_${randomUUID().replaceAll('-', '')}`;
  const sql = readFileSync(new URL('../../../prisma/migrations/20261024010000_memory_last_sync_report/migration.sql', import.meta.url), 'utf8');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      await tx.$executeRawUnsafe('CREATE TABLE memories (id text PRIMARY KEY)');
      await tx.$executeRawUnsafe("INSERT INTO memories VALUES ('old')");
      await tx.$executeRawUnsafe(sql);
      const old = await tx.$queryRawUnsafe<{ report: string }[]>('SELECT last_sync_report AS report FROM memories');
      expect(JSON.parse(old[0].report)).toMatchObject({ version: 1, outcome: 'unknown', entries: [] });
      await tx.$executeRawUnsafe("UPDATE memories SET last_sync_report = NULL WHERE id = 'old'");
      await tx.$executeRawUnsafe("INSERT INTO memories (id) VALUES ('new')");
      await tx.$executeRawUnsafe(sql);
      expect(await tx.$queryRawUnsafe('SELECT id, last_sync_report FROM memories ORDER BY id')).toEqual([
        { id: 'new', last_sync_report: null }, { id: 'old', last_sync_report: null },
      ]);
    } finally {
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
