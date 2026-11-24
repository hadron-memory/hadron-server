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
import { retryOnSerializationFailure } from '../serializableRetry.js';
import { countOwnerNodesOnDemand, OWNER_LIMIT_KEYS } from './keys.js';

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
