/**
 * #3947 — `tickBatch` mechanics, pinned at the helper itself (#3867, moved unchanged by #3943):
 *   - item 2: a rejected flush rejects EVERY waiter of its tick, and the next tick is not poisoned by it;
 *   - item 5 (§10 F1 on #3943): queues are per request Context. Two Contexts with distinct `db` raising lookups in one
 *     tick each get their own flush, with their own Context and only their own keys; a module-level queue would merge
 *     them and serve one request through the other's database.
 */
import { describe, it, expect } from 'vitest';
import { tickBatch } from './tickBatch.js';
import type { Context } from './resolvers.helpers.js';

const ctxOf = (name: string): Context => ({ db: { name } as never, roles: ['READER'] });

describe('#3947 tickBatch', () => {
  it('two Contexts in one tick: one flush each, with its own Context and only its own keys', async () => {
    const flushes: Array<{ db: string; keys: string[] }> = [];
    const lookup = tickBatch<string, string>(async (ctx, keys) => {
      const db = (ctx.db as unknown as { name: string }).name;
      flushes.push({ db, keys: [...keys].sort() });
      return new Map(keys.map((k) => [k, `${db}:${k}`]));
    }, 'missing');
    const a = ctxOf('A');
    const b = ctxOf('B');
    const out = await Promise.all([lookup(a, 'x'), lookup(b, 'x'), lookup(a, 'y'), lookup(b, 'z')]);
    expect(out).toEqual(['A:x', 'B:x', 'A:y', 'B:z']);
    expect(flushes.sort((p, q) => p.db.localeCompare(q.db))).toEqual([
      { db: 'A', keys: ['x', 'y'] },
      { db: 'B', keys: ['x', 'z'] },
    ]);
  });

  it('a rejected flush rejects every waiter of its tick, and the next tick flushes afresh', async () => {
    let calls = 0;
    const lookup = tickBatch<string, string>(async (_ctx, keys) => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return new Map(keys.filter((k) => k !== 'gone').map((k) => [k, `ok:${k}`]));
    }, 'missing');
    const c = ctxOf('A');
    const settled = await Promise.allSettled([lookup(c, 'x'), lookup(c, 'x'), lookup(c, 'y')]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const s of settled) expect(String((s as PromiseRejectedResult).reason)).toContain('boom');
    expect(await Promise.all([lookup(c, 'x'), lookup(c, 'gone')])).toEqual(['ok:x', 'missing']);
    expect(calls).toBe(2);
  });
});
