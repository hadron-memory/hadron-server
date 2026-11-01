/** #2764: request-local batching of AgentTask.blockedBy / AgentTask.blocks pages and counts. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const F = resolvers as any;
let appId: string, ownerId: string, outsiderId: string;

/** A context whose database counts every model operation and raw query it issues. */
function counted(userId: string): { ctx: Context; count: () => number } {
  let n = 0;
  const bump = async ({ args, query }: any) => { n++; return query(args); };
  const spy = db.$extends({ query: { $allOperations: bump, $queryRaw: bump, $queryRawUnsafe: bump } as any });
  return { ctx: { db: spy as any, userId, roles: ['READER'] }, count: () => n };
}
const plain = (userId = ownerId): Context => ({ db, userId, roles: ['READER'] });
const create = (title = 'Synthetic task') => M.createAgentTask(null, { input: { appRef: appId, title } }, plain());
const link = (taskId: string, blockerTaskId: string) => db.agentTaskBlocker.create({ data: { taskId, blockerTaskId } });
const blockedBy = (t: { id: string }, c: Context, args = {}) => F.AgentTask.blockedBy(t, args, c);
const blocks = (t: { id: string }, c: Context, args = {}) => F.AgentTask.blocks(t, args, c);
const ids = (page: { items: { id: string }[] }) => page.items.map((i) => i.id);

beforeEach(async () => {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner', handle: 'syntheticowner' } })).id;
  outsiderId = (await db.user.create({ data: { id: generateId(), name: 'Outsider', handle: 'syntheticoutsider' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:app' } })).id;
});

/** N tasks, each blocked by one shared blocker and blocking one shared dependent. */
async function fan(n: number) {
  const hub = await create('hub');
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const t = await create(`t${i}`);
    const dep = await create(`d${i}`);
    await link(t.id, hub.id);
    await link(dep.id, t.id);
    tasks.push(t);
  }
  return tasks;
}

async function queriesFor(n: number): Promise<number> {
  const tasks = await fan(n);
  const { ctx, count } = counted(ownerId);
  const pages = await Promise.all(tasks.flatMap((t) => [blockedBy(t, ctx), blocks(t, ctx)]));
  for (const p of pages) expect(p.total).toBe(1);
  return count();
}

describe('#2764 query count', () => {
  it('issues a number of relation queries that does not depend on how many tasks are listed', async () => {
    const small = await queriesFor(3);
    await cleanDb(db);
    ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner', handle: 'syntheticowner' } })).id;
    appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:app' } })).id;
    const large = await queriesFor(12);
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(25);
  }, 60000);
});

describe('#2764 isolation', () => {
  it('conceals a task the caller cannot read exactly like a missing one, inside a mixed batch', async () => {
    const [a] = await fan(1);
    const blocker = await create('blocker');
    await link(a.id, blocker.id);
    const foreignApp = await db.app.create({ data: { ownerUserId: outsiderId, name: 'Foreign', urn: 'syntheticoutsider:app' } });
    const foreign = await db.agentTask.create({ data: { appId: foreignApp.id, title: 'Foreign', ownerUserId: outsiderId } });
    const foreignBlocker = await db.agentTask.create({ data: { appId: foreignApp.id, title: 'FB', ownerUserId: outsiderId } });
    await link(foreign.id, foreignBlocker.id);
    const missing = { id: generateId() };
    const { ctx } = counted(ownerId);
    const [mine, theirs, gone, theirsBlocks] = await Promise.all([blockedBy(a, ctx), blockedBy(foreign, ctx), blockedBy(missing, ctx), blocks(foreignBlocker, ctx)]);
    expect(mine.total).toBe(2);
    expect(theirs).toEqual({ items: [], total: 0, hasMore: false });
    expect(JSON.stringify(theirs)).toBe(JSON.stringify(gone));
    expect(JSON.stringify(theirsBlocks)).toBe(JSON.stringify(gone));
  });
});

describe('#2764 paging', () => {
  it('keeps stable id order, own limit/offset, total and hasMore per task and direction', async () => {
    const a = await create('a'), b = await create('b'), c = await create('c');
    const five = [await create('1'), await create('2'), await create('3'), await create('4'), await create('5')];
    const two = [five[0], five[4]];
    for (const x of five) await link(a.id, x.id);
    for (const x of two) await link(b.id, x.id);
    for (const x of five) await link(x.id, c.id); // c blocks five tasks
    const sorted = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    const { ctx } = counted(ownerId);
    const [aPage, bPage, cEmpty, aWide, cBlocks, cBlocksOff, aZero] = await Promise.all([
      blockedBy(a, ctx, { limit: 2, offset: 1 }),
      blockedBy(b, ctx, { limit: 2, offset: 1 }),
      blockedBy(c, ctx, { limit: 2, offset: 1 }),
      blockedBy(a, ctx, { limit: 10 }),
      blocks(c, ctx, { limit: 3 }),
      blocks(c, ctx, { limit: 3, offset: 3 }),
      blockedBy(a, ctx, { limit: 0 }),
    ]);
    expect(ids(aPage)).toEqual(sorted(five).slice(1, 3));
    expect(aPage).toMatchObject({ total: 5, hasMore: true });
    expect(ids(bPage)).toEqual(sorted(two).slice(1, 3));
    expect(bPage).toMatchObject({ total: 2, hasMore: false });
    expect(cEmpty).toEqual({ items: [], total: 0, hasMore: false });
    expect(ids(aWide)).toEqual(sorted(five));
    expect(aWide).toMatchObject({ total: 5, hasMore: false });
    expect(ids(cBlocks)).toEqual(sorted(five).slice(0, 3));
    expect(cBlocks).toMatchObject({ total: 5, hasMore: true });
    expect(ids(cBlocksOff)).toEqual(sorted(five).slice(3));
    expect(cBlocksOff).toMatchObject({ total: 5, hasMore: false });
    expect(aZero).toMatchObject({ items: [], total: 5, hasMore: true });
  });
});

describe('#2764 no cache across callers or requests', () => {
  it('gives two callers in one tick their own results', async () => {
    const [t] = await fan(1);
    const owner = counted(ownerId).ctx, outsider = counted(outsiderId).ctx;
    const [o1, x1, o2, x2] = await Promise.all([blockedBy(t, owner), blockedBy(t, outsider), blocks(t, owner), blocks(t, outsider)]);
    expect(o1.total).toBe(1);
    expect(o2.total).toBe(1);
    expect(x1).toEqual({ items: [], total: 0, hasMore: false });
    expect(x2).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('does not let a context copy for another caller reuse the batch of the original', async () => {
    const [t] = await fan(1);
    const owner = plain(ownerId);
    const copy: Context = { ...owner, userId: outsiderId };
    const [o, x] = await Promise.all([blockedBy(t, owner), blockedBy(t, copy)]);
    expect(o.total).toBe(1);
    expect(x).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('re-reads on a later request with the same context object', async () => {
    const [t] = await fan(1);
    const c = plain(ownerId);
    expect((await blockedBy(t, c)).total).toBe(1);
    const extra = await create('extra');
    await link(t.id, extra.id);
    expect((await blockedBy(t, c)).total).toBe(2);
  });
});
