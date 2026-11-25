/**
 * #5078 (Billing A7d): the fold at commit. A transaction holds no counter row while it takes other locks, a figure is always totals plus
 * pending, and the migration and post-push leave the totals equal to a recount.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaiters } from '../../test/lockWait.js';
import { expectNodeTotalsExact } from '../../test/nodeTotals.js';
import { generateId } from '../id.js';
import { isSerializationFailure, retryOnSerializationFailure } from '../serializableRetry.js';
import { countOwnerNodesOnDemand, OWNER_LIMIT_KEYS } from './keys.js';
import { repairMemoryNodeTotal } from './nodeTotals.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let orgId: string;
let m1: string;
let m2: string;
let m3: string;
const mk = (tx: Pick<typeof db, 'node'>, memoryId: string, loc: string, deletedAt: Date | null = null) =>
  tx.node.create({ data: { id: generateId(), memoryId, loc, name: 'n', deletedAt } });
const used = () => OWNER_LIMIT_KEYS.nodes.count(db, { organizationId: orgId });
async function expectExact(total: bigint) {
  await expectNodeTotalsExact(db);
  expect(await used()).toBe(total);
  expect(await countOwnerNodesOnDemand(db, { organizationId: orgId })).toBe(total);
}

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'nf', urn: 'nf' } })).id;
  [m1, m2, m3] = await Promise.all(['a', 'b', 'c'].map(async (s) => (await db.memory.create({ data: {
    id: generateId(), name: s, urn: `nf:${s}`, class: 'knowledge', organizationId: orgId } })).id));
});

describe('#5078 the fold at commit', () => {
  it('a node write then a row lock, against the row lock then a node write in the same memory, both commit', async () => {
    let locked!: () => void;
    const holds = new Promise<void>((r) => { locked = r; });
    const rowLock = (tx: Pick<typeof db, '$executeRaw'>) => tx.$executeRaw`UPDATE organizations SET updated_at = now() WHERE id = ${orgId}`;
    const rowFirst = db.$transaction(async (tx) => {
      await rowLock(tx);
      locked();
      await waitForLockWaiters(db, 1);
      await mk(tx, m1, 'row-first');
    }, { timeout: 30_000 });
    await holds;
    const nodeFirst = db.$transaction(async (tx) => {
      await mk(tx, m1, 'node-first');
      await rowLock(tx);
    }, { timeout: 30_000 });
    await Promise.all([rowFirst, nodeFirst]);
    await expectExact(2n);
  });

  it('a transaction holds no total row before its commit', async () => {
    await mk(db, m1, 'n');
    await db.$transaction(async (tx) => {
      await mk(tx, m1, 'held');
      await db.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${m1} FOR UPDATE NOWAIT`;
      await mk(db, m1, 'other');
    });
    await expectExact(3n);
  });

  /** Runs `waiter` against a transaction that has already folded its own write and holds the total row, then commits that one. */
  async function againstFolded(write: (tx: Pick<typeof db, 'node'>) => Promise<unknown>, waiter: () => Promise<unknown>) {
    let waiting!: Promise<unknown>;
    await db.$transaction(async (tx) => {
      await write(tx);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      waiting = waiter();
      await waitForLockWaiters(db, 1);
    }, { timeout: 30_000 });
    await waiting;
  }

  it('two transactions that each write a memory\'s first node both count', async () => {
    expect(await db.memoryNodeTotal.count()).toBe(0);
    await againstFolded((tx) => mk(tx, m1, 'x'), () => mk(db, m1, 'y').then(() => undefined));
    await expectExact(2n);
  });

  it('the repair waits for a writer that has folded and then counts its node', async () => {
    await mk(db, m1, 'n');
    await againstFolded((tx) => mk(tx, m1, 'x'), () => repairMemoryNodeTotal(db, m1));
    await expectExact(2n);
  });

  it('a writer that folds while the repair runs waits for it and adds on top', async () => {
    await mk(db, m1, 'n');
    let writer!: Promise<unknown>;
    const startWriter = async () => {
      let folded = false;
      writer = db.$transaction(async (w) => {
        await mk(w, m1, 'x');
        await w.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        folded = true;
        // Unlocked, the repair now recounts without this node and waits for the total row: hold it until then. Locked, nobody waits.
        await waitForLockWaiters(db, 1, 1_000).catch(() => undefined);
      }, { timeout: 30_000 });
      for (let i = 0; i < 100 && !folded; i++) {
        const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    let statements = 0;
    const pausing = { $transaction: (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      (db.$transaction as unknown as (f: (tx: object) => Promise<unknown>, o: unknown) => Promise<unknown>)((tx) => fn(new Proxy(tx, { get(t, p) {
        const real = Reflect.get(t, p) as (...a: unknown[]) => unknown;
        if (p !== '$executeRaw') return typeof real === 'function' ? real.bind(t) : real;
        return async (...a: unknown[]) => {
          if (++statements === 2) await startWriter();
          return real.apply(t, a);
        };
      } })), opts) } as unknown as Parameters<typeof repairMemoryNodeTotal>[0];
    await repairMemoryNodeTotal(pausing, m1);
    expect(statements).toBe(3);
    await writer;
    await expectExact(2n);
  });

  /** #5126 item 1: the order of a fold's `GROUP BY` is a HashAggregate over random ids, so one set of ids kills a removed `ORDER BY` only
   *  about half of the time. Each round makes fresh memories (fresh random ids) and the loop makes a miss in every round vanishingly rare. */
  it('a fold takes the total rows in memory order, over several fresh sets of memories', async () => {
    let expected = 0n;
    for (let round = 0; round < 12; round++) {
      const ids = (await Promise.all(['p', 'q', 'r'].map(async (s) => (await db.memory.create({ data: {
        id: generateId(), name: `${s}${round}`, urn: `nf:${s}${round}`, class: 'knowledge', organizationId: orgId } })).id))).sort();
      for (const id of ids) await mk(db, id, 'n');
      let writer!: Promise<unknown>;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${ids[0]} FOR UPDATE`;
        writer = db.$transaction(async (w) => { for (const id of [...ids].reverse()) await mk(w, id, 'x'); }, { timeout: 30_000 });
        await waitForLockWaiters(db, 1);
        // It waits at the first row and has taken none of the later ones.
        for (const id of ids.slice(1)) await tx.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${id} FOR UPDATE NOWAIT`;
      }, { timeout: 30_000 });
      await writer;
      expected += 6n;
      expect(await used()).toBe(expected);
    }
    await expectNodeTotalsExact(db);
  });

  it('a transaction whose changes cancel out takes no total row', async () => {
    const n = await mk(db, m1, 'n');
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM memory_node_totals WHERE memory_id = ${m1} FOR UPDATE`;
      await db.$transaction(async (other) => {
        await other.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await mk(other, m1, 'x');
        await other.node.delete({ where: { id: n.id } });
      });
    }, { timeout: 30_000 });
    await expectExact(1n);
  });

  it('two transactions that write the same memories in opposite orders both commit', async () => {
    const write = (ids: string[], loc: string) => db.$transaction(async (tx) => {
      for (const id of ids) await mk(tx, id, loc);
    }, { maxWait: 30_000 });
    for (let i = 0; i < 30; i++) await Promise.all([write([m1, m2, m3], `x${i}`), write([m3, m2, m1], `y${i}`)]);
    await expectExact(180n);
  });

  it('a concurrent SERIALIZABLE writer of one memory fails in the form the shared retry recognizes, and the retry commits', async () => {
    await mk(db, m1, 'n');
    let ready = 0;
    let attempts = 0;
    let go!: () => void;
    const both = new Promise<void>((r) => { go = r; });
    const write = (loc: string) => retryOnSerializationFailure(() => {
      attempts++;
      return db.$transaction(async (tx) => {
        await mk(tx, m1, loc);
        if (++ready === 2) go();
        await both;
      }, { isolationLevel: 'Serializable', timeout: 30_000 });
    });
    await Promise.all([write('s1'), write('s2')]);
    expect(attempts).toBeGreaterThan(2);
    await expectExact(3n);
  });

  /** #5126 item 3. Not the limit refusal (cor:acl:150:03 S2): the doors that gate a write run READ COMMITTED. This pins what two SERIALIZABLE
   *  writers that each read their owner's figure and then write a node in their own memory do today: exactly one commits, the other is aborted.
   *  (A probe with the owner read removed aborts one as well, so the read is not what conflicts: the pin names the observed outcome, not a cause.) */
  it('two SERIALIZABLE writers in two memories of one owner, each reading the owner figure first: exactly one commits, the other is aborted', async () => {
    let ready = 0;
    let go!: () => void;
    const both = new Promise<void>((r) => { go = r; });
    const gatedWrite = (memoryId: string, loc: string) => db.$transaction(async (tx) => {
      await OWNER_LIMIT_KEYS.nodes.count(tx as typeof db, { organizationId: orgId });
      await mk(tx, memoryId, loc);
      if (++ready === 2) go();
      await both;
    }, { isolationLevel: 'Serializable', timeout: 30_000 });
    const settled = await Promise.allSettled([gatedWrite(m1, 'g1'), gatedWrite(m2, 'g2')]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    // As observed (not S2's OWNER_LIMIT_REACHED): Postgres's serialization failure, in the form the shared retry recognizes.
    expect(isSerializationFailure(lost?.reason)).toBe(true);
    await expectExact(1n);
  });

  it('a node delete in flight and its memory\'s hard delete both finish; a memory deleted with its first node leaves no figure', async () => {
    const n = await mk(db, m1, 'n');
    let outcome: Promise<unknown> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.delete({ where: { id: n.id } });
      outcome = db.memory.delete({ where: { id: m1 } }).then(() => 'deleted', (e: unknown) => e);
      await waitForLockWaiters(db, 1);
    }, { timeout: 30_000 });
    expect(await outcome).toBe('deleted');
    await db.$transaction(async (tx) => {
      await mk(tx, m2, 'n');
      await tx.memory.delete({ where: { id: m2 } });
    });
    expect(await db.memoryNodeTotal.count()).toBe(0);
    await expectExact(0n);
  });

  it('left-over pending rows still count, and the fold takes only its own transaction\'s', async () => {
    await mk(db, m1, 'n');
    await db.$executeRaw`ALTER TABLE memory_node_pending DISABLE TRIGGER memory_node_pending_fold`;
    try { await mk(db, m1, 'unfolded'); } finally {
      await db.$executeRaw`ALTER TABLE memory_node_pending ENABLE TRIGGER memory_node_pending_fold`;
    }
    await mk(db, m1, 'folded');
    expect(await db.memoryNodePending.count()).toBe(1);
    expect(await used()).toBe(3n);
    expect(await countOwnerNodesOnDemand(db, { organizationId: orgId })).toBe(3n);
  });
});

describe('#5078 the migration and post-push', () => {
  const sql = (p: string) => readFileSync(new URL(`../../../prisma/${p}`, import.meta.url), 'utf8');
  const migration = sql('migrations/20261124210000_memory_node_totals/migration.sql');
  const invariants = sql('memory-node-total-invariants.sql');
  const postPush = sql('post-push.sql');
  const lock = 'LOCK TABLE nodes IN SHARE ROW EXCLUSIVE MODE;';
  const fill = postPush.slice(postPush.indexOf(lock) + lock.length, postPush.lastIndexOf('COMMIT;'));

  it('the migration carries the invariants block verbatim, after the lock and before the same fill, and cannot refuse', () => {
    expect(migration).toContain(invariants);
    expect(migration.indexOf(lock)).toBeGreaterThan(0);
    expect(migration.indexOf(lock)).toBeLessThan(migration.indexOf(invariants));
    expect(migration).not.toMatch(/RAISE|HDPRF|\bBEGIN;|\bCOMMIT;|[─-╿]/);
    const fillInsert = fill.slice(fill.indexOf('INSERT INTO memory_node_totals'), fill.indexOf('UPDATE memory_node_totals')).trim();
    expect(migration.trim().endsWith(fillInsert)).toBe(true);
    expect(postPush).toContain('\\ir memory-node-total-invariants.sql');
    expect(postPush.slice(0, postPush.indexOf(lock)).trimEnd().endsWith('BEGIN;')).toBe(true);
  });

  it('the fill corrects every stale figure over live, deleted and dead-memory nodes, run twice', async () => {
    for (const id of [m1, m2]) {
      await mk(db, id, 'live');
      await mk(db, id, 'dead', new Date());
    }
    await db.memory.update({ where: { id: m2 }, data: { deletedAt: new Date() } });
    const statements = fill.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(3);
    for (let i = 0; i < 2; i++) {
      await db.$executeRaw`
        INSERT INTO memory_node_totals (memory_id, live_nodes) SELECT id, 77 FROM memories ON CONFLICT (memory_id) DO UPDATE SET live_nodes = 77`;
      await db.$transaction(async (tx) => { for (const s of [lock, ...statements]) await tx.$executeRawUnsafe(s); });
      await expectExact(1n);
    }
  });
});

/** #5126 item 2: `TRUNCATE nodes CASCADE` is refused by the append-only tables, so the trigger function is exercised through a scratch table that carries the
 *  same trigger; a do-nothing function leaves the figures behind. */
describe('#5078 the TRUNCATE trigger', () => {
  it('a truncate empties the pending rows and zeroes every total', async () => {
    await mk(db, m1, 'a');
    await mk(db, m2, 'b');
    await db.$executeRaw`ALTER TABLE memory_node_pending DISABLE TRIGGER memory_node_pending_fold`;
    try { await mk(db, m1, 'unfolded'); } finally {
      await db.$executeRaw`ALTER TABLE memory_node_pending ENABLE TRIGGER memory_node_pending_fold`;
    }
    expect(await db.memoryNodePending.count()).toBe(1);
    expect(await db.memoryNodeTotal.count({ where: { liveNodes: { gt: 0 } } })).toBeGreaterThan(0);
    await db.$executeRawUnsafe('CREATE TABLE scratch_truncate_5126 (id int)');
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER scratch_truncate_5126_trg AFTER TRUNCATE ON scratch_truncate_5126
        FOR EACH STATEMENT EXECUTE FUNCTION hadron_memory_node_total_after_truncate()`);
      await db.$executeRawUnsafe('TRUNCATE scratch_truncate_5126');
    } finally {
      await db.$executeRawUnsafe('DROP TABLE scratch_truncate_5126');
    }
    expect(await db.memoryNodePending.count()).toBe(0);
    expect(await db.memoryNodeTotal.count({ where: { liveNodes: { not: 0 } } })).toBe(0);
  });
});
