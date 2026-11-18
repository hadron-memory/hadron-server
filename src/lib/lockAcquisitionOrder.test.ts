/**
 * #1187 — every advisory key in the `(memoryId, loc)` space is acquired in ONE
 * global resolved-key order (#1214), so input hash collisions cannot invert it.
 *
 * The four lock helpers share one key space and their callers had no common
 * order: bulk sorted length-first, merge took target-then-source, move took
 * destination-then-source, create walked its ancestor path. #1184 added one
 * edge to create and produced THREE pairwise inversions in three review rounds,
 * each from a locally-correct repair of the previous one.
 *
 * Three assumptions this fix rests on, measured against the real database
 * before it was designed rather than taken from the manual:
 *
 *     REENTRANT:      three acquisitions of one key in one tx succeeded
 *     OPPOSITE ORDER: rejected=1     (Postgres aborts one side)
 *     SAME ORDER:     rejected=0
 *
 * The first is what makes the fix minimally invasive — a caller declares its
 * whole key set up front and the per-endpoint helpers below it re-acquire for
 * free, keeping their own gate and revalidation behaviour.
 *
 * The middle test here is the CONTROL. Without it, "no deadlock occurred"
 * proves nothing: it could mean the ordering works, or that the two
 * transactions never actually overlapped. The control does the same thing with
 * a hand-picked opposite order and must FAIL, which is what makes the other two
 * evidence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { acquireLockSet, compareLockKeys, type LockKey } from './nodeSubtreeLock.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let org: { id: string; urn: string };
let admin: { id: string };
let memory: { id: string; urn: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'lk', urn: `lk-${t}` } });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 77111, githubUsername: `lk-${t}`, roles: ['ADMIN'] },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm',
      class: 'knowledge', visibility: 'ORGANIZATION' as never,
    },
  });
});

/** Did any settled promise fail with a Postgres deadlock (40P01)? */
function deadlocks(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => String((r.reason as Error)?.message ?? r.reason))
    .filter((m) => /deadlock|40P01/i.test(m));
}

describe('compareLockKeys — stable input order, not acquisition order', () => {
  it('sorts by memory, then length (root→leaf), then lexically', () => {
    const keys: LockKey[] = [
      { memoryId: 'm2', loc: 'a' },
      { memoryId: 'm1', loc: 'a:b:c' },
      { memoryId: 'm1', loc: 'b' },
      { memoryId: 'm1', loc: 'a' },
      { memoryId: 'm1', loc: 'a:b' },
    ];
    expect([...keys].sort(compareLockKeys)).toEqual([
      { memoryId: 'm1', loc: 'a' },
      { memoryId: 'm1', loc: 'b' },
      { memoryId: 'm1', loc: 'a:b' },
      { memoryId: 'm1', loc: 'a:b:c' },
      { memoryId: 'm2', loc: 'a' },
    ]);
  });

  it('is a TOTAL order — any permutation of one set sorts identically', () => {
    // This comparator remains a stable input-space utility; acquisition order
    // is now independently derived from PostgreSQL hashes (#1214).
    const keys: LockKey[] = [
      { memoryId: 'm1', loc: 'z' },
      { memoryId: 'm1', loc: 'a:b' },
      { memoryId: 'm0', loc: 'q:r:s' },
      { memoryId: 'm1', loc: 'a' },
    ];
    const canonical = JSON.stringify([...keys].sort(compareLockKeys));
    for (let i = 0; i < 24; i++) {
      const shuffled = [...keys].sort(() => Math.random() - 0.5);
      expect(JSON.stringify(shuffled.sort(compareLockKeys))).toBe(canonical);
    }
  });
});

describe('acquireLockSet', () => {
  it('dedupes — a key named twice is acquired once', async () => {
    const calls: string[] = [];
    const tx = {
      $queryRaw: async () => [{ h1: 1, h2: 2 }, { h1: 1, h2: 1 }],
      $executeRaw: (_s: TemplateStringsArray, m: string, l: string) => {
        calls.push(`${m}/${l}`);
        return Promise.resolve(1);
      },
    } as never;
    await acquireLockSet(tx, [
      { memoryId: 'm', loc: 'a:b' },
      { memoryId: 'm', loc: 'a' },
      { memoryId: 'm', loc: 'a:b' },
    ]);
    expect(calls).toEqual(['1/1', '1/2']);
  });

  it('two transactions given the SAME keys in OPPOSITE input orders do not deadlock', async () => {
    const keys: LockKey[] = [
      { memoryId: memory.id, loc: 'a' },
      { memoryId: memory.id, loc: 'a:b' },
    ];
    const run = (ordered: LockKey[]) =>
      db.$transaction(
        async (tx) => {
          await acquireLockSet(tx, ordered);
          await new Promise((r) => setTimeout(r, 150));
        },
        { timeout: 20_000 },
      );

    const results = await Promise.allSettled([run(keys), run([...keys].reverse())]);
    expect(deadlocks(results)).toEqual([]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('CONTROL: the same two keys taken in hand-picked opposite order DO deadlock', async () => {
    // Without this, the test above is not evidence — "no deadlock" could just
    // mean the two transactions never overlapped. This is the same timing with
    // the ordering removed, and Postgres must abort one side.
    const raw = (first: string, second: string) =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memory.id}), hashtext(${first}))`;
          await new Promise((r) => setTimeout(r, 150));
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memory.id}), hashtext(${second}))`;
        },
        { timeout: 20_000 },
      );

    const results = await Promise.allSettled([raw('a', 'a:b'), raw('a:b', 'a')]);
    expect(deadlocks(results).length).toBeGreaterThan(0);
  });
});

/**
 * Observe the advisory keys a REAL operation acquires, in order, against the
 * REAL database — by proxying `$transaction` so the transaction client it hands
 * the resolver records every `pg_advisory_xact_lock` before delegating.
 *
 * This replaces a concurrency test that did NOT discriminate: running a real
 * merge against a real move and asserting "no deadlock" passed with the fix
 * removed, because two sub-millisecond transactions do not reliably overlap in
 * the window between their two acquisitions, and nothing in-process can force
 * that interleaving. "No deadlock occurred" was an observation about timing,
 * not about ordering.
 *
 * The invariant is about the SEQUENCE, so the sequence is what to observe.
 */
type ActualKey = { h1: number; h2: number };
function recordingCtx(): { ctx: Context; keys: ActualKey[] } {
  const keys: ActualKey[] = [];
  const LOCK_RE = /pg_advisory_xact_lock/;
  const proxied = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => unknown, opts?: unknown) =>
        (target as typeof db).$transaction(async (tx) => {
          const spy = new Proxy(tx, {
            get(t, p, r) {
              if (p !== '$executeRaw') return Reflect.get(t, p, r);
              return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                if (LOCK_RE.test(strings.join(''))) {
                  const [m, l] = values;
                  const actual = typeof m === 'number' && typeof l === 'number'
                    ? { h1: m, h2: l }
                    : (await tx.$queryRaw<ActualKey[]>`SELECT hashtext(${String(m)}) AS h1, hashtext(${String(l)}) AS h2`)[0];
                  keys.push(actual);
                }
                return (t as typeof tx).$executeRaw(strings, ...values);
              };
            },
          });
          return fn(spy);
        }, opts as never);
    },
  });
  return { ctx: { db: proxied, roles: ['ADMIN'], userId: admin.id } as Context, keys };
}

/**
 * Is the order in which each DISTINCT key was FIRST taken globally ordered?
 *
 * First-acquisition, not every acquisition — and getting that wrong is how the
 * first version of this assertion failed against correct code. A caller
 * declares its whole set through `acquireLockSet` and then calls the
 * per-endpoint helpers, which re-acquire keys the transaction already holds.
 * Those re-acquisitions are re-entrant no-ops that can never block, so they
 * cannot be half of a cycle and their position in the raw sequence is
 * meaningless. Only the first time a key is taken can make this transaction
 * WAIT, so only that order can deadlock.
 */
function firstAcquisitionsOrdered(keys: ActualKey[]): boolean {
  const seen = new Set<string>();
  const firsts: ActualKey[] = [];
  for (const k of keys) {
    const id = `${k.h1},${k.h2}`;
    if (seen.has(id)) continue;
    seen.add(id);
    firsts.push(k);
  }
  for (let i = 1; i < firsts.length; i++) {
    const a = firsts[i - 1];
    const b = firsts[i];
    if ((a.h1 - b.h1 || a.h2 - b.h2) > 0) return false;
  }
  return true;
}

describe('the real operations acquire in the global order (#1187)', () => {
  const mk = (loc: string) =>
    db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc } });

  it('a LEAF→ROOT merge acquires resolved signed pairs in order', async () => {
    // The specific inversion #1187 catalogues. `mergeNodes` guards only
    // `source !== target`, so merging an ANCESTOR into its DESCENDANT is legal —
    // and it names its endpoints target-then-source, i.e. `a:b` before `a`.
    // The declared set must order the actual keys independently of input direction.
    const root = await mk('a');
    const leaf = await mk('a:b');
    const { ctx: rec, keys } = recordingCtx();

    // `deleteSource` is what makes the merge take the SECOND key — without it
    // only the target is locked and the inversion cannot arise. The first draft
    // of this test omitted it and captured one key.
    await resolvers.Mutation.mergeNodes(
      {},
      { input: { source: root.id, target: leaf.id, include: ['CONTENT'], deleteSource: true } } as never,
      rec,
    );

    expect(keys.length).toBeGreaterThan(0);
    const expected = await db.$queryRaw<ActualKey[]>`
      SELECT hashtext(${memory.id}) AS h1, hashtext(loc) AS h2
      FROM unnest(ARRAY['a', 'a:b']) AS loc`;
    for (const actual of expected) expect(keys).toContainEqual(actual);
    expect(firstAcquisitionsOrdered(keys)).toBe(true);
  });

  it('a MOVE acquires its destination and source paths in one ordered sweep', async () => {
    await mk('a');
    await mk('a:b');
    const loose = await mk('z:deep');
    const { ctx: rec, keys } = recordingCtx();

    await resolvers.Mutation.moveNode(
      null,
      { sourceRef: loose.id, targetUrn: `hrn:node:${memory.urn}:a:b:moved` },
      rec,
    );

    expect(keys.length).toBeGreaterThan(0);
    expect(firstAcquisitionsOrdered(keys)).toBe(true);
  });
});
