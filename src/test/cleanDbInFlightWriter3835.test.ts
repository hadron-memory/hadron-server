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
import { beforeEach, expect, it, vi } from 'vitest';
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

// Gizelle's LOCAL P2 on the first head (#3862): a node-DELETE-first writer scheduled
// before cleanDb whose statement starts AFTER the busy snapshot. Its cascade takes
// signing_requests before node_signatures (FK order), so a TRUNCATE holding
// node_signatures and waiting on signing_requests closes the cycle. A statement
// trigger parks the writer after its signing_requests lock; cleanDb's own
// BEGIN is the admission point, so the writer is genuinely not in the snapshot.
it('cleanDb survives a node-delete-first writer that starts after the busy snapshot', async () => {
  const { Client } = await import('pg');
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'o3835b', graphName: 'm3835b' });
  await db.node.create({ data: { memoryId: graph.id, loc: 'a', name: 'a', ownerRepo: 'test/repo' } });
  const barrier = new Client({ connectionString: process.env.DATABASE_URL });
  const conn = new Client({ connectionString: process.env.DATABASE_URL });
  await barrier.connect();
  await conn.connect();
  await barrier.query('CREATE FUNCTION pg_temp.pause_3835() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(38353835); RETURN NULL; END $$');
  await barrier.query('CREATE TRIGGER pause_3835 BEFORE DELETE ON signing_requests FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.pause_3835()');
  await barrier.query('SELECT pg_advisory_lock(38353835)');
  const original = Client.prototype.query as unknown as (...a: unknown[]) => Promise<unknown>;
  let admit!: () => void;
  const admission = new Promise<void>((r) => { admit = r; });
  let started = false;
  const spy = vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (!started && args[0] === 'BEGIN' && this !== conn && this !== barrier) {
      started = true;
      admit();
      // Let the writer park on its trigger before cleanDb's next statement.
      return waitForLockWaiters(db, 1, 3_000).catch(() => undefined).then(() => original.apply(this, args));
    }
    return original.apply(this, args);
  } as never);
  const writer = (async () => {
    try {
      await admission;
      await original.call(conn, 'BEGIN');
      await original.call(conn, "DELETE FROM nodes WHERE memory_id=$1 AND owner_repo=$2 AND node_type <> 'compiled-boot-prompt'", [graph.id, 'test/repo']);
      await original.call(conn, 'COMMIT');
    } finally { await conn.end(); }
  })();
  const cleaning = cleanDb(db);
  // Release the parked writer once cleanDb is demonstrably blocked behind it, or after a beat.
  await waitForLockWaiters(db, 2, 2_000).catch(() => undefined);
  await barrier.query('SELECT pg_advisory_unlock(38353835)');
  const [w, c] = await Promise.allSettled([writer, cleaning]);
  spy.mockRestore();
  await barrier.query('DROP TRIGGER pause_3835 ON signing_requests');
  await barrier.end();
  expect(started).toBe(true);
  const failures = [w, c].flatMap((x) => (x.status === 'rejected' ? [String(x.reason)] : []));
  expect(failures.filter((m) => /40P01|deadlock/i.test(m))).toEqual([]);
  expect([w.status, c.status]).toEqual(['fulfilled', 'fulfilled']);
}, 30_000);
