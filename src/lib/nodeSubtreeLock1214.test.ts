/** #1214: order actual PostgreSQL signed-int32 pairs, not their string preimages. */
import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { acquireLockSet, compareLockKeys } from './nodeSubtreeLock.js';

const MEMORY = '1214-memory';
// Discovered with PostgreSQL hashtext over 300k distinct locs; rechecked below.
const X = '1214-011852';
const Z = '1214-100000';
const Y = '1214-189651';
const key = (loc: string) => ({ memoryId: MEMORY, loc });
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function fixture() {
  const [hashes] = await db.$queryRaw<Array<{ h1: number; other: number; x: number; z: number; y: number }>>`
    SELECT hashtext(${MEMORY}) AS h1, hashtext(${`${MEMORY}-2`}) AS other, hashtext(${X}) AS x,
           hashtext(${Z}) AS z, hashtext(${Y}) AS y`;
  expect(X).not.toBe(Y);
  expect(compareLockKeys(key(X), key(Z))).toBeLessThan(0);
  expect(compareLockKeys(key(Z), key(Y))).toBeLessThan(0);
  expect(hashes.x).toBe(hashes.y);
  expect(hashes.z).not.toBe(hashes.x);
  expect(hashes.x).toBeLessThan(0);
  expect(hashes.h1).toBeLessThan(0);
  expect(hashes.other).toBeGreaterThan(0);
  return hashes;
}

/** Match this backend, database, two-int function form and full unsigned key bits. */
async function waitForCollisionWaiter(pid: number, h1: number, h2: number) {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = ${h1 >>> 0}::bigint::oid AND objid = ${h2 >>> 0}::bigint::oid
        AND objsubid = 2) AS waiting`;
    if (row.waiting) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('second transaction never waited on the exact collision key');
}

/** Observe real acquisitions and pause A after its first one, without inventing hashes. */
function pauseAfterFirst(tx: Prisma.TransactionClient, acquired: ReturnType<typeof latch<void>>, release: ReturnType<typeof latch<void>>) {
  let calls = 0;
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
      return async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const result = await tx.$executeRaw(strings, ...values);
        if (/pg_advisory_xact_lock/.test(strings.join('')) && ++calls === 1) {
          acquired.resolve();
          await release.promise;
        }
        return result;
      };
    },
  });
}

describe('#1214 actual-key ordering', () => {
  it('real colliding preimages with an intervening loc do not deadlock two independent transactions', async () => {
    const h = await fixture();
    const firstHeld = latch();
    const releaseFirst = latch();
    const secondPid = latch<number>();
    const a = db.$transaction(async (tx) => {
      await acquireLockSet(pauseAfterFirst(tx, firstHeld, releaseFirst), [key(X), key(Z)]);
    }, { timeout: 20_000 });
    // Attach rejection handlers immediately, even if setup/barrier fails.
    const aResult = Promise.allSettled([a]);
    let bResult: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await firstHeld.promise;
      const b = db.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        secondPid.resolve(pid);
        await acquireLockSet(tx, [key(Z), key(Y)]);
      }, { timeout: 20_000 });
      bResult = Promise.allSettled([b]);
      // Old ordering: B owns Z and waits on H; fixed: B waits on the common
      // first actual key. Here H sorts before Z in signed int32 order.
      await waitForCollisionWaiter(await secondPid.promise, h.h1, h.x);
    } finally {
      releaseFirst.resolve();
    }
    const results = [...await aResult, ...await bResult!];
    expect(results.map((r) => r.status), results.map((r) => r.status === 'rejected' ? String(r.reason) : 'fulfilled').join('\n')).toEqual(['fulfilled', 'fulfilled']);
  });

  it('resolves a multi-key set once, sorts signed pairs, dedupes collisions and awaits each lock', async () => {
    const calls: unknown[][] = [];
    const started = latch();
    const release = latch();
    const $queryRaw = vi.fn(async () => [
      { h1: 2, h2: -7 }, { h1: -2, h2: 9 }, { h1: -2, h2: -9 }, { h1: -2, h2: -9 },
    ]);
    const $executeRaw = vi.fn(async (_sql: unknown, ...values: unknown[]) => {
      calls.push(values);
      if (calls.length === 1) { started.resolve(); await release.promise; }
      return 1;
    });
    const running = acquireLockSet({ $queryRaw, $executeRaw } as never, [key(X), key(Y), key(Z)]);
    try {
      await started.promise;
      await Promise.resolve();
      expect(calls).toHaveLength(1);
    } finally { release.resolve(); await running; }
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([[-2, -9], [-2, 9], [2, -7]]);
  });

  it('deduplicates real collisions and orders real signed pairs before acquiring them', async () => {
    const h = await fixture();
    const calls: unknown[][] = [];
    await db.$transaction(async (tx) => {
      const spy = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
          return async (sql: TemplateStringsArray, ...values: unknown[]) => {
            calls.push(values);
            return tx.$executeRaw(sql, ...values);
          };
        },
      });
      await acquireLockSet(spy, [key(Z), { memoryId: `${MEMORY}-2`, loc: Z }, key(Y), key(X), key(Z)]);
    });
    expect(calls).toEqual([[h.h1, h.x], [h.h1, h.z], [h.other, h.z]].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  });

  it('empty input makes no DB call and one distinct input keeps the original hashtext statement', async () => {
    const $queryRaw = vi.fn();
    const $executeRaw = vi.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1);
    const tx = { $queryRaw, $executeRaw } as never;
    await acquireLockSet(tx, []);
    expect($executeRaw).not.toHaveBeenCalled();
    expect($queryRaw).not.toHaveBeenCalled();
    await acquireLockSet(tx, [key(X), key(X)]);
    expect($queryRaw).not.toHaveBeenCalled();
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect($executeRaw.mock.calls[0].slice(1)).toEqual([MEMORY, X]);
    expect(($executeRaw.mock.calls[0][0] as TemplateStringsArray).join('')).toContain('hashtext(');
  });
});
