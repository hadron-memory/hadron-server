/**
 * #4751: the shared hold latch (`./lockHold.ts`). A failing initial lock fails the caller at once (it used to stall until the
 * suite timeout), and a held lock reports the pid that really holds it.
 */
import { describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { holdInTransaction } from './lockHold.js';

describe('#4751 holdInTransaction', () => {
  it('a failing initial lock rejects at once with that error, not after a timeout', async () => {
    const started = Date.now();
    await expect(holdInTransaction(db, async (tx) => { await tx.$queryRaw`SELECT * FROM table_that_does_not_exist_4751`; }))
      .rejects.toThrow(/table_that_does_not_exist_4751/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a held lock reports the backend pid that holds it, until released', async () => {
    const held = await holdInTransaction(db, (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(4751, 1)`);
    try {
      const rows = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 4751 AND objid = 1`;
      expect(rows.map((r) => Number(r.pid))).toEqual([held.pid]);
    } finally {
      held.release();
      await held.done;
    }
    const after = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 4751 AND objid = 1`;
    expect(after[0]!.n).toBe(0);
  });
});
