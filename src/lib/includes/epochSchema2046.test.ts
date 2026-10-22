/**
 * #2046 S9-3: the include-history authority epoch row and its guards, on the schema `db push` + post-push.sql actually
 * build, plus the migration that must carry the same statements for production.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { withIncludeHistoryTransaction } from './includeHistoryFence.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const epoch = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT n FROM include_history_epoch WHERE id = 1`)[0].n);

/** Run `body` with the guard triggers off (table-owner maintenance), restoring them and the row afterwards. */
async function withGuardsOff(body: () => Promise<void>): Promise<void> {
  const saved = await epoch();
  await db.$executeRawUnsafe('ALTER TABLE include_history_epoch DISABLE TRIGGER USER');
  try {
    await body();
  } finally {
    await db.$executeRawUnsafe('DELETE FROM include_history_epoch');
    await db.$executeRawUnsafe(`INSERT INTO include_history_epoch (id, n) VALUES (1, ${saved})`);
    await db.$executeRawUnsafe('ALTER TABLE include_history_epoch ENABLE TRIGGER USER');
  }
}

describe('#2046 S9-3 include_history_epoch', () => {
  beforeEach(async () => {
    // The row is seeded by post-push and never reset by cleanDb; make sure the guards are on before each test.
    await db.$executeRawUnsafe('ALTER TABLE include_history_epoch ENABLE TRIGGER USER');
  });

  it('is seeded as a single row on the pushed schema', async () => {
    const rows = await db.$queryRaw<Array<{ id: number; n: bigint }>>`SELECT id, n FROM include_history_epoch`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0);
  });

  it('advances by exactly one and never otherwise', async () => {
    const before = await epoch();
    await db.$executeRaw`UPDATE include_history_epoch SET n = n + 1 WHERE id = 1`;
    expect(await epoch()).toBe(before + 1);
    await expect(db.$executeRaw`UPDATE include_history_epoch SET n = n + 2 WHERE id = 1`).rejects.toThrow(/only advances by exactly one/);
    await expect(db.$executeRaw`UPDATE include_history_epoch SET n = 0 WHERE id = 1`).rejects.toThrow(/only advances by exactly one/);
    await expect(db.$executeRaw`UPDATE include_history_epoch SET n = n WHERE id = 1`).rejects.toThrow(/only advances by exactly one/);
    await expect(db.$executeRaw`UPDATE include_history_epoch SET id = 2, n = n + 1 WHERE id = 1`).rejects.toThrow();
    expect(await epoch()).toBe(before + 1);
  });

  it('refuses delete, truncate and a second or unknown-id row', async () => {
    await expect(db.$executeRaw`DELETE FROM include_history_epoch`).rejects.toThrow(/never deleted or truncated/);
    await expect(db.$executeRawUnsafe('TRUNCATE include_history_epoch')).rejects.toThrow(/never deleted or truncated/);
    await expect(db.$executeRaw`INSERT INTO include_history_epoch (id, n) VALUES (2, 0)`).rejects.toThrow();
    await expect(db.$executeRaw`INSERT INTO include_history_epoch (id, n) VALUES (1, 0)`).rejects.toThrow();
  });

  it('a repeated seed never resets a nonzero value', async () => {
    await db.$executeRaw`UPDATE include_history_epoch SET n = n + 1 WHERE id = 1`;
    const before = await epoch();
    expect(before).toBeGreaterThan(0);
    await db.$executeRawUnsafe('INSERT INTO include_history_epoch (id, n) VALUES (1, 0) ON CONFLICT (id) DO NOTHING');
    expect(await epoch()).toBe(before);
  });

  it('a missing row fails closed: no holder runs, nothing is inserted on the hot path', async () => {
    await withGuardsOff(async () => {
      await db.$executeRawUnsafe('DELETE FROM include_history_epoch');
      let ran = false;
      await expect(withIncludeHistoryTransaction(db, async () => { ran = true; })).rejects.toThrow(/epoch row is missing/);
      expect(ran).toBe(false);
      expect(await db.$queryRaw<unknown[]>`SELECT 1 FROM include_history_epoch`).toHaveLength(0);
    });
  });

  it('overflow fails closed instead of wrapping', async () => {
    await withGuardsOff(async () => {
      await db.$executeRawUnsafe('UPDATE include_history_epoch SET n = 9223372036854775807');
      let ran = false;
      await expect(withIncludeHistoryTransaction(db, async () => { ran = true; })).rejects.toThrow();
      expect(ran).toBe(false);
    });
  });

  it('the migration carries the same statements as the post-push invariants file', () => {
    const invariants = read('../../../prisma/include-history-epoch-invariants.sql');
    const migration = read('../../../prisma/migrations/20261022040000_include_history_epoch/migration.sql');
    expect(migration.endsWith(invariants)).toBe(true);
    expect(read('../../../prisma/post-push.sql')).toContain('\\ir include-history-epoch-invariants.sql');
  });
});
