/**
 * #3272 — the holder capture around a NOWAIT probe. A forced failure (another connection holds the node row, so the probe gets
 * 55P03) must name that backend's pid and its query in the thrown message and keep the original error as `cause`; the control
 * (a free row) behaves as before; any other error passes through untouched, and a capture that fails never hides the original.
 * No retry, no budget edit, no cause claimed: the helper reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from './helpers.js';
import { withLockHolders } from './lockWait.js';

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
  holderDone = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${nodeId} FOR UPDATE /* holder3272 */`;
    entered(pid);
    await gate;
  });
  return ready;
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
});
