/** #1213 S1: every memory-key set orders resolved signed keys, not memory IDs. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { lockMemoryForChannelChange } from './channels.js';
import { lockEdgeEndpointMemories } from './edgeEndpointLock.js';

// Real PostgreSQL hash collision. X < Z < Y in input order, H < hash(Z).
const X = '1213-023094';
const Z = '1213-100000';
const Y = '1213-247233';
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function hashes() {
  const [h] = await db.$queryRaw<Array<{ x: number; z: number; y: number }>>`
    SELECT hashtext(${'channel-host:' + X}) AS x,
      hashtext(${'channel-host:' + Z}) AS z, hashtext(${'channel-host:' + Y}) AS y`;
  expect(h.x).toBe(h.y);
  expect(h.x).toBeLessThan(h.z);
  expect(h.x).toBeLessThan(0);
  return h;
}
/** Observe only this PID, private database and exact one-argument signed key. */
async function waitForKey(pid: number, h: number) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [r] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
        AND pid=${pid} AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND classid=${h < 0 ? 4294967295 : 0}::bigint::oid
        AND objid=${h >>> 0}::bigint::oid AND objsubid=1) AS waiting`;
    if (r.waiting) return;
  }
  throw new Error('waiter never reached the exact memory coordination key');
}

describe('#1213 memory-key ordering', () => {
  it('colliding memory names and an intervening name cannot invert two real transactions', async () => {
    const h = await hashes();
    const held = latch();
    const release = latch();
    const pid = latch<number>();
    const a = db.$transaction(async (tx) => {
      let count = 0;
      const observed = new Proxy(tx, { get(target, prop, receiver) {
        if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
        return async (sql: TemplateStringsArray, ...values: unknown[]) => {
          const result = await tx.$executeRaw(sql, ...values);
          if (/pg_advisory_xact_lock/.test(sql.join('')) && ++count === 1) {
            held.resolve(); await release.promise;
          }
          return result;
        };
      } });
      await lockEdgeEndpointMemories(observed, [X, Z]);
    }, { timeout: 15000 });
    const ra = Promise.allSettled([a]);
    let rb: ReturnType<typeof Promise.allSettled> | undefined;
    let barrierError: unknown;
    try {
      await held.promise;
      const b = db.$transaction(async (tx) => {
        pid.resolve((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
        await lockEdgeEndpointMemories(tx, [Z, Y]);
      }, { timeout: 15000 });
      rb = Promise.allSettled([b]);
      await waitForKey(await pid.promise, h.x);
    } catch (e) { barrierError = e; }
    finally { release.resolve(); }
    const results = [...await ra, ...(rb ? await rb : [])];
    if (barrierError) throw barrierError;
    expect(results.map((r) => r.status), JSON.stringify(results)).toEqual(['fulfilled', 'fulfilled']);
  }, 20000);

  it('deduplicates real physical collisions and acquires each signed key once', async () => {
    const h = await hashes();
    const seen: bigint[] = [];
    await db.$transaction(async (tx) => {
      const observed = new Proxy(tx, { get(target, prop, receiver) {
        if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
        return async (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (/pg_advisory_xact_lock/.test(sql.join(''))) {
            const [r] = await tx.$queryRaw<Array<{ h: number }>>`SELECT hashtext(${String(values[0])}) AS h`;
            seen.push(typeof values[0] === 'string' ? BigInt(r.h) : BigInt(values[0] as number));
          }
          return tx.$executeRaw(sql, ...values);
        };
      } });
      await lockEdgeEndpointMemories(observed, [Z, Y, X, Z]);
    });
    expect(seen).toEqual([BigInt(h.x), BigInt(h.z)]);
  });

  it('resolves once, sorts signed values, deduplicates and awaits each acquisition', async () => {
    const held = latch(); const release = latch(); const seen: unknown[] = [];
    const $queryRaw = vi.fn(async () => [{ key: 7 }, { key: -2 }, { key: -9 }, { key: -9 }]);
    const $executeRaw = vi.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      seen.push(values[0]);
      if (seen.length === 1) { held.resolve(); await release.promise; }
      return 1;
    });
    const work = lockEdgeEndpointMemories({ $queryRaw, $executeRaw } as unknown as Prisma.TransactionClient, [X, Y, Z]);
    try { await held.promise; await Promise.resolve(); expect(seen).toHaveLength(1); }
    finally { release.resolve(); await work; }
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([-9, -2, 7]);
  });

  it('empty sets do nothing and singleton keeps the existing one-argument namespace', async () => {
    const $queryRaw = vi.fn(); const $executeRaw = vi.fn(async () => 1);
    const tx = { $queryRaw, $executeRaw } as unknown as Prisma.TransactionClient;
    await lockEdgeEndpointMemories(tx, []);
    expect($executeRaw).not.toHaveBeenCalled();
    await lockEdgeEndpointMemories(tx, [X, X]);
    expect($queryRaw).not.toHaveBeenCalled();
    expect($executeRaw).toHaveBeenCalledTimes(1);
    expect($executeRaw.mock.calls[0]).toEqual(expect.arrayContaining(['channel-host:' + X]));
  });

  it('the singleton and set entry points contend on the same real key and release at commit', async () => {
    const h = await hashes(); const held = latch(); const release = latch(); const pid = latch<number>();
    const a = db.$transaction(async (tx) => { await lockMemoryForChannelChange(tx, X); held.resolve(); await release.promise; });
    const ra = Promise.allSettled([a]); let rb: ReturnType<typeof Promise.allSettled> | undefined;
    try {
      await held.promise;
      rb = Promise.allSettled([db.$transaction(async (tx) => {
        pid.resolve((await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0].pid);
        await lockEdgeEndpointMemories(tx, [Y, Z]);
      })]);
      await waitForKey(await pid.promise, h.x);
    } finally { release.resolve(); }
    expect([...await ra, ...(rb ? await rb : [])].map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('existing multi-memory adopters cannot keep a lexical singleton-acquisition loop', () => {
    // Protocol guard: a single left-over loop would mix old and new orders.
    const files = ['lib/edgeEndpointLock.ts', 'lib/bulkMutationGate.ts',
      'integrations/github/syncGraphFromGithub.ts', 'api/graphql/schema/resolvers.mutation.node.ts',
      'controller/operations/mergeMemories.ts'];
    const violations: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(new URL('../' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node, inLoop: boolean) {
        const loop = inLoop || ts.isIterationStatement(node, false);
        if (loop && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'lockMemoryForChannelChange') violations.push(file);
        ts.forEachChild(node, (child) => visit(child, loop));
      }
      visit(source, false);
    }
    expect(violations).toEqual([]);
  });
});
