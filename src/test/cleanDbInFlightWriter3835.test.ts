/**
 * #3835: cleanDb's TRUNCATE (AccessExclusive, taken table by table) against a
 * repository-scoped node DELETE still in flight from the previous test (its
 * FK cascades take RowExclusive on the same tables in another order) formed a
 * lock cycle: Postgres killed one side with 40P01.
 *
 * The stand-in holds the LAST truncated table, then deletes nodes the way the
 * git sync's cleanup does (owner_repo + memory scope). Without a quiesce step,
 * TRUNCATE holds node_signatures while waiting for that last table, and the
 * delete's cascade then wants node_signatures: a cycle, every time.
 */
import { beforeEach, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from './helpers.js';
import { waitForLockWaiters } from './lockWait.js';

beforeEach(() => cleanDb(db));

it('cleanDb waits for an in-flight repository-scoped node delete instead of deadlocking with it', async () => {
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'o3835', graphName: 'm3835' });
  await db.node.create({ data: { memoryId: graph.id, loc: 'a', name: 'a', ownerRepo: 'test/repo' } });
  let held!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => { held = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const writer = db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('LOCK TABLE user_api_key_deletions IN ROW EXCLUSIVE MODE');
    held();
    await gate;
    return tx.node.deleteMany({ where: { memoryId: graph.id, ownerRepo: 'test/repo', nodeType: { not: 'compiled-boot-prompt' } } });
  }, { timeout: 15_000 });
  await ready;
  const cleaning = cleanDb(db);
  // Wake the writer once the cleaner is demonstrably blocked behind it, or, for
  // a cleaner that waits without taking a lock, after a short beat.
  await waitForLockWaiters(db, 1, 1_000).catch(() => undefined);
  release();
  const [w, c] = await Promise.allSettled([writer, cleaning]);
  const codes = [w, c].flatMap((s) => (s.status === 'rejected' ? [String((s.reason as { message?: string }).message)] : []));
  expect(codes.filter((m) => /40P01|deadlock/i.test(m))).toEqual([]);
  expect(w.status).toBe('fulfilled');
  expect(c.status).toBe('fulfilled');
}, 30_000);
