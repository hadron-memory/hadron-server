/**
 * #3272 — the holder capture around a NOWAIT probe. A forced failure (another connection holds the node row, so the probe gets
 * 55P03) must name that backend's pid and its query in the thrown message and keep the original error as `cause`; the control
 * (a free row) behaves as before; any other error passes through untouched, and a capture that fails never hides the original.
 * No retry, no budget edit, no cause claimed: the helper reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from './helpers.js';
import pg from 'pg';
import { HOLDER_ROW_CAP, describeLockHolders, withLockHolders } from './lockWait.js';

let memoryId: string;
let nodeId: string;
let releaseHolder: (() => void) | undefined;
let holderDone: Promise<unknown> | undefined;

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'lock3272', graphName: 'lockmem' });
  memoryId = graph.id;
  nodeId = (await db.node.create({ data: { memoryId, loc: 'probe:row', name: 'row', nodeType: 'record', content: 'x' } as never })).id;
});
afterEach(async () => {
  releaseHolder?.();
  await holderDone;
  releaseHolder = undefined;
  holderDone = undefined;
});

/** Another connection takes the node row FOR UPDATE and holds it, returning its backend pid. */
async function holdNodeRow(): Promise<number> {
  let entered!: (pid: number) => void;
  const ready = new Promise<number>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { releaseHolder = r; });
  let failed!: (e: unknown) => void;
  const rejected = new Promise<number>((_, r) => { failed = r; });
  holderDone = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR UPDATE /* holder3272 */`;
    entered(pid);
    await gate;
  }, { timeout: 60_000 }).catch((e) => { failed(e); throw e; });
  holderDone.catch(() => undefined);
  // A holder that fails before it holds anything fails the test at once instead of hanging it.
  return Promise.race([ready, rejected]);
}

const nowaitProbe = () => db.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
  return tx.$queryRaw`SELECT id FROM nodes WHERE memory_id = ${memoryId} FOR UPDATE NOWAIT`;
});

describe('#3272 withLockHolders', () => {
  it('FORCED FAILURE: a 55P03 names the holding backend\'s pid and query, and keeps the original as cause', async () => {
    const holderPid = await holdNodeRow();
    const err = await withLockHolders(db, 'nodes', nowaitProbe).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('lock holders on nodes at the failure (#3272)');
    expect(err!.message).toContain(`"pid": ${holderPid}`);
    expect(err!.message).toContain('holder3272');
    expect(err!.message).toMatch(/55P03|could not obtain lock/);
    expect((err!.cause as { meta?: { code?: string } }).meta?.code).toBe('55P03');
  });

  it('CONTROL: a free row returns the probe\'s rows, and nothing extra is read', async () => {
    let extraReads = 0;
    const counting = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === '$queryRaw') return (...a: unknown[]) => { extraReads++; return Reflect.apply(v as (...x: unknown[]) => unknown, target, a); };
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as typeof db;
    const rows = await withLockHolders(counting, 'nodes', nowaitProbe) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([nodeId]);
    expect(extraReads).toBe(0);
  });

  it('any other error is rethrown untouched (the same instance), with no capture', async () => {
    const boom = new Error('not a lock miss');
    await expect(withLockHolders(db, 'nodes', () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('a capture that itself fails never hides the original: the message says so and the cause is kept', async () => {
    await holdNodeRow();
    const broken = { $queryRaw: () => Promise.reject(new Error('capture exploded')) } as unknown as typeof db;
    const err = await withLockHolders(broken, 'nodes', nowaitProbe).then(() => undefined, (e: Error) => e);
    expect(err!.message).toContain('(capture failed: capture exploded)');
    expect((err!.cause as { meta?: { code?: string } }).meta?.code).toBe('55P03');
  });

  describe('describeLockHolders: the cap cannot push the holder out', () => {
    const noise: Array<{ release: () => void; done: Promise<unknown> }> = [];
    let client: pg.Client | undefined;
    afterEach(async () => {
      for (const n of noise.splice(0)) { n.release(); await n.done; }
      if (client) { await client.query('ROLLBACK').catch(() => undefined); await client.end(); client = undefined; }
    });

    /** An unrelated transaction holding `locks` advisory locks: many rows, none on the probed relation. */
    async function holdNoise(locks: number, base: number): Promise<number> {
      let entered!: (pid: number) => void;
      const ready = new Promise<number>((r) => { entered = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const done = db.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        for (let i = 0; i < locks; i++) await tx.$queryRaw`SELECT pg_advisory_xact_lock(${base + i}::bigint)::text AS locked`;
        entered(pid);
        await gate;
      }, { timeout: 60_000 });
      done.catch(() => undefined);
      noise.push({ release, done });
      return ready;
    }

    it('with more unrelated rows than the cap and LOWER pids, the holder\'s relation row is still returned, first, and truncation is flagged', async () => {
      const noisePids = [await holdNoise(25, 1000), await holdNoise(25, 2000)];
      // A fresh backend, created after the noise ones, so its pid is the highest: pid order alone would cut it off.
      client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM nodes WHERE id = $1 FOR UPDATE /* holderfresh3272 */', [nodeId]);
      const holderPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      expect(Math.max(...noisePids), 'premise: the noise backends were created before the holder').toBeLessThan(holderPid);
      const found = await describeLockHolders(db, 'nodes');
      expect(found.rows).toHaveLength(HOLDER_ROW_CAP);
      expect(found.truncated).toBe(true);
      expect(found.rows[0]).toMatchObject({ pid: holderPid, relation: 'nodes' });
      expect(found.rows.some((r) => r.pid === holderPid && r.relation === 'nodes')).toBe(true);
    });

    it('a failed probe through withLockHolders says when the list was truncated', async () => {
      await holdNoise(25, 3000); await holdNoise(25, 4000);
      await holdNodeRow();
      const err = await withLockHolders(db, 'nodes', nowaitProbe).then(() => undefined, (e: Error) => e);
      expect(err!.message).toContain('(truncated: more than 40 rows; relation rows first)');
      expect(err!.message).toContain('holder3272');
    });

    it('a quiet database is not flagged truncated', async () => {
      await holdNodeRow();
      expect((await describeLockHolders(db, 'nodes')).truncated).toBe(false);
    });
  });
});
