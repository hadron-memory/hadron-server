/** #1213 S1: every memory-key set orders resolved signed keys, not memory IDs. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { lockMemoriesForChannelChange, lockMemoryForChannelChange } from './channels.js';
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
    // Yield between probes so a slow waiter is not starved by this loop's own queries.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waiter pid ${pid} never reached the exact memory coordination key ${h} (classid/objid derived from the signed key)`);
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
            // The set path passes the resolved signed key; only a raw name needs hashing.
            if (typeof values[0] === 'string') {
              const [r] = await tx.$queryRaw<Array<{ h: number }>>`SELECT hashtext(${values[0]}) AS h`;
              seen.push(BigInt(r.h));
            } else seen.push(BigInt(values[0] as number));
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

  // Signed keys chosen so numeric signed order, string order and unsigned-32 order all differ:
  // hashtext('channel-host:'||id) = B -1905139398, A -1210034056, C 215209028, D 1037588733.
  // String sort gives A, B, D, C; unsigned gives C, D, B, A; only numeric signed gives B, A, C, D.
  const ORDER = { A: 'fx-2541-1006', B: 'fx-2541-1047', C: 'fx-2541-1', D: 'fx-2541-101' };
  async function orderKeys() {
    const rows = await db.$queryRaw<Array<{ id: string; h: number }>>`
      SELECT id, hashtext('channel-host:' || id) AS h FROM unnest(${Object.values(ORDER)}::text[]) AS id`;
    const h = Object.fromEntries(rows.map((r) => [r.id, r.h]));
    const [a, b, c, d] = [h[ORDER.A], h[ORDER.B], h[ORDER.C], h[ORDER.D]];
    expect([a, b, c, d]).toEqual([-1210034056, -1905139398, 215209028, 1037588733]);
    const asStrings = [a, b, c, d].map(String).sort();
    expect(asStrings).toEqual([String(a), String(b), String(d), String(c)]);
    return { numeric: [b, a, c, d].map(BigInt) };
  }
  async function observeAcquisitions(run: (tx: Prisma.TransactionClient) => Promise<void>): Promise<bigint[]> {
    const seen: bigint[] = [];
    await db.$transaction(async (tx) => {
      const observed = new Proxy(tx, { get(target, prop, receiver) {
        if (prop !== '$executeRaw') return Reflect.get(target, prop, receiver);
        return async (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (/pg_advisory_xact_lock/.test(sql.join(''))) seen.push(BigInt(values[0] as number));
          return tx.$executeRaw(sql, ...values);
        };
      } });
      await run(observed as Prisma.TransactionClient);
    });
    return seen;
  }

  it.each([
    ['the edge-endpoint entry point', (tx: Prisma.TransactionClient, ids: string[]) => lockEdgeEndpointMemories(tx, ids)],
    ['the set helper directly', (tx: Prisma.TransactionClient, ids: string[]) => lockMemoriesForChannelChange(tx, ids)],
  ])('acquires real keys in numeric signed order, not string or unsigned order, through %s', async (_label, lock) => {
    const { numeric } = await orderKeys();
    const input = [ORDER.D, ORDER.A, ORDER.C, ORDER.B];
    expect(await observeAcquisitions((tx) => lock(tx, input))).toEqual(numeric);
    expect(await observeAcquisitions((tx) => lock(tx, [...input].reverse()))).toEqual(numeric);
  });

  describe('repeated-acquisition guard', () => {
    const ADOPTER = /lockMemoryForChannelChange|lockMemoriesForChannelChange|lockEdgeEndpointMemories|lockLiveEdgeEndpoint/;
    const SINGLETON = new Set(['lockMemoryForChannelChange']);
    const SET_HELPERS = new Set(['lockMemoriesForChannelChange', 'lockEdgeEndpointMemories', 'lockLiveEdgeEndpoints', 'lockLiveEdgeEndpointSet']);
    const ITERATING_METHODS = new Set(['forEach', 'map', 'flatMap', 'reduce', 'reduceRight', 'filter', 'some', 'every', 'find', 'findLast', 'findIndex']);
    const CONCURRENT = new Set(['all', 'allSettled', 'race', 'any']);
    const calleeName = (e: ts.Expression) => ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;

    const TRANSACTION_OPENERS = /^(\$transaction|with\w*Tx)$/;

    /**
     * Lines where memory keys are acquired repeatedly within ONE transaction: inside a loop
     * statement, inside a callback handed to an iterating array method (nested callbacks such as
     * `.then` included), or inside a Promise.all-style argument. A call that opens a transaction
     * (`$transaction`, `with…Tx`) starts a fresh acquisition scope for its arguments, so a loop
     * that opens a NEW transaction per iteration is not repetition. The set helpers count too:
     * calling one per memory is the same inversion as the singleton loop.
     */
    function repeatedAcquisitions(file: string, text: string): string[] {
      const found: string[] = [];
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node, repeated: boolean) {
        if (ts.isIterationStatement(node, false)) repeated = true;
        if (ts.isCallExpression(node)) {
          const callee = calleeName(node.expression);
          if (repeated && callee && (SINGLETON.has(callee) || SET_HELPERS.has(callee))) {
            found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${callee}`);
          }
          const owner = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
            ? node.expression.expression.text : '';
          const fans = !!callee && (owner === 'Promise' ? CONCURRENT.has(callee)
            : ts.isPropertyAccessExpression(node.expression) && ITERATING_METHODS.has(callee));
          const fresh = !!callee && TRANSACTION_OPENERS.test(callee);
          ts.forEachChild(node, (child) => visit(child, fresh ? false : repeated || (fans && child !== node.expression)));
          return;
        }
        ts.forEachChild(node, (child) => visit(child, repeated));
      }
      visit(source, false);
      return found;
    }
    function productionSources(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) return entry.name === 'generated' ? [] : productionSources(join(dir, entry.name));
        return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [join(dir, entry.name)] : [];
      });
    }

    it.each([
      ['a for loop', 'async function f(tx, ids) { for (const id of ids) { await lockMemoryForChannelChange(tx, id); } }'],
      ['forEach', 'function f(tx, ids) { ids.forEach((id) => lockMemoryForChannelChange(tx, id)); }'],
      ['map inside Promise.all', 'async function f(tx, ids) { await Promise.all(ids.map((id) => lockMemoryForChannelChange(tx, id))); }'],
      ['Promise.all of direct calls', 'async function f(tx, a, b) { await Promise.all([lockMemoryForChannelChange(tx, a), lockMemoryForChannelChange(tx, b)]); }'],
      ['reduce', 'function f(tx, ids) { return ids.reduce((p, id) => p.then(() => lockMemoryForChannelChange(tx, id)), Promise.resolve()); }'],
      ['a set helper called per memory', 'async function f(tx, ids) { for (const id of ids) { await lockMemoriesForChannelChange(tx, [id]); } }'],
      ['the edge-endpoint set helper in a callback', 'function f(tx, ids) { ids.map((id) => lockEdgeEndpointMemories(tx, [id])); }'],
      ['a loop inside the transaction callback', 'async function f(db, ids) { await db.$transaction(async (tx) => { for (const id of ids) await lockMemoryForChannelChange(tx, id); }); }'],
    ])('flags %s', (_label, text) => {
      expect(repeatedAcquisitions('fixture.ts', text)).toHaveLength(_label === 'Promise.all of direct calls' ? 2 : 1);
    });

    it.each([
      ['one complete set per transaction', 'async function f(db, ids) { await db.$transaction(async (tx) => { await lockMemoriesForChannelChange(tx, ids); }); }'],
      ['a new transaction per loop iteration', 'async function f(db, ids) { for (const id of ids) { await db.$transaction(async (tx) => { await lockMemoryForChannelChange(tx, id); }); } }'],
      ['one singleton call', 'async function f(tx, id) { await lockMemoryForChannelChange(tx, id); }'],
      ['an unrelated map', 'function f(ids) { return ids.map((id) => id.trim()); }'],
    ])('does not flag %s', (_label, text) => {
      expect(repeatedAcquisitions('fixture.ts', text)).toEqual([]);
    });

    it('no production file that takes memory keys acquires them repeatedly in one transaction', () => {
      // Protocol guard over EVERY adopter under src (discovered, not listed): one left-over
      // repeated acquisition would mix the old ID order with the signed-key order.
      const violations: string[] = [];
      for (const file of productionSources(fileURLToPath(new URL('../', import.meta.url)))) {
        const text = readFileSync(file, 'utf8');
        if (ADOPTER.test(text)) violations.push(...repeatedAcquisitions(file, text));
      }
      expect(violations).toEqual([]);
    });
  });
});
